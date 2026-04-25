import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { detectProviderFailureText, parseStructuredTurn } from "../structured-turn";
import type { CodexTransport } from "./codex-transport";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "gpt";

  /**
   * Tracks Codex thread IDs only for the unphased approach-debate path.
   *
   * Crossfire's hard reuse policy is broader than this cache and is enforced
   * by orchestration before another resumed turn is attempted: same provider
   * (implicit here because this cache is Codex-only), same phase family,
   * same behavioral contract, same response-schema expectations, a confirmed
   * Codex resume path, and a previous turn that was neither degraded nor
   * phase-invalid. In this pass, the only Codex path that satisfies those
   * gates is the unphased approach debate; every phase-specific prompt starts
   * from fresh context.
   */
  private readonly threadIds = new Map<string, string>();

  constructor(private readonly transport: CodexTransport) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    const debateKey = `${input.sessionId}:debate`;
    const resumeThreadId = input.phase ? undefined : this.threadIds.get(debateKey);
    const canOmitContext = !!resumeThreadId;

    const prompt = input.phase
      ? input.prompt
      : buildStructuredTurnPrompt({
          role: "gpt",
          originalProblem: input.originalProblem ?? input.prompt,
          peerResponse: input.peerResponse,
          turnNumber: input.turnNumber ?? 1,
          totalTurns: input.totalTurns ?? 4,
          omitContext: canOmitContext
        });

    for await (const event of this.transport.runTurn({
      ...input,
      prompt,
      resumeThreadId
    })) {
      if (event.kind === "progress") {
        yield { type: "progress", text: event.text } as const;
        continue;
      }

      if (event.kind === "stderr") {
        yield { type: "stderr", text: event.text } as const;
        continue;
      }

      if (event.kind === "error") {
        yield { type: "error", message: event.message } as const;
        continue;
      }

      if (event.kind === "thread_started") {
        if (!input.phase) {
          this.threadIds.set(debateKey, event.threadId);
        }
        continue;
      }

      const turn = parseStructuredTurn("gpt", event.text);
      if (turn.degraded) {
        const providerFailure = detectProviderFailureText(event.text);
        if (providerFailure) {
          yield { type: "error", message: providerFailure } as const;
          continue;
        }
      }

      yield {
        type: "structured_turn",
        actor: "gpt",
        turn,
        rawResponse: event.text,
        conversationReused: canOmitContext
      } as const;
    }

    yield { type: "done" } as const;
  }

  clearSession(sessionId: string) {
    this.threadIds.delete(`${sessionId}:debate`);
  }

  healthCheck() {
    return this.transport.healthCheck();
  }
}
