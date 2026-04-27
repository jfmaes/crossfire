import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { detectProviderFailureText, parseStructuredTurn } from "../structured-turn";
import type { ClaudeProcess } from "./claude-process";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  /**
   * Tracks Claude CLI session IDs only for the unphased approach-debate path.
   *
   * Crossfire's hard reuse policy is broader than this cache and is enforced
   * by orchestration before another resumed turn is attempted: same provider
   * (implicit here because this cache is Claude-only), same phase family,
   * same behavioral contract, same response-schema expectations, a confirmed
   * Claude resume path, and a previous turn that was neither degraded nor
   * phase-invalid. In this pass, the only Claude path that satisfies those
   * gates is the unphased approach debate; every phase-specific prompt starts
   * from fresh context.
   */
  private readonly cliSessions = new Map<string, string>();

  constructor(private readonly processRunner: ClaudeProcess) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    const debateKey = `${input.sessionId}:debate`;
    const resumeSessionId = input.phase ? undefined : this.cliSessions.get(debateKey);
    const canOmitContext = !!resumeSessionId;

    const prompt = input.phase
      ? input.prompt
      : buildStructuredTurnPrompt({
          role: "claude",
          originalProblem: input.originalProblem ?? input.prompt,
          peerResponse: input.peerResponse,
          turnNumber: input.turnNumber ?? 1,
          totalTurns: input.totalTurns ?? 4,
          omitContext: canOmitContext
        });

    for await (const event of this.processRunner.runTurn({
      ...input,
      prompt,
      resumeSessionId
    })) {
      if (event.type === "stderr") {
        yield { type: "stderr", text: event.text } as const;
        continue;
      }

      if (event.type === "error") {
        yield { type: "error", message: event.message } as const;
        continue;
      }

      // Capture CLI session ID for future resumption
      if (event.cliSessionId && !input.phase) {
        this.cliSessions.set(debateKey, event.cliSessionId);
      }

      const turn = parseStructuredTurn("claude", event.text);
      if (turn.degraded) {
        const providerFailure = detectProviderFailureText(event.text);
        if (providerFailure) {
          yield { type: "error", message: providerFailure } as const;
          continue;
        }
      }

      yield {
        type: "structured_turn",
        actor: "claude",
        turn,
        rawResponse: event.text,
        conversationReused: canOmitContext
      } as const;
    }

    yield { type: "done" } as const;
  }

  clearSession(sessionId: string) {
    this.cliSessions.delete(`${sessionId}:debate`);
  }

  healthCheck() {
    return this.processRunner.healthCheck();
  }
}
