import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { parseStructuredTurn } from "../structured-turn";
import type { CodexTransport } from "./codex-transport";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "gpt";

  /**
   * Tracks Codex thread IDs for conversation resumption within multi-turn phases.
   * Key: "sessionId:phase", Value: Codex thread_id.
   *
   * Codex `exec resume` works within the same conversational context (e.g. multiple
   * debate turns) but fails when the prompt structure changes completely (e.g.
   * debate → spec generation returns 0 chars). So we track per-phase, and only
   * resume for phases that have multiple turns within the same conversation.
   */
  private readonly threadIds = new Map<string, string>();

  constructor(private readonly transport: CodexTransport) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    // Only resume within the same phase context.
    // "debate" = approach debate (no phase set, uses orchestrator).
    // "analysis_debate" = question debate (multi-turn, same phase key).
    // Single-shot phases (analysis, interview, spec_generation) always start fresh.
    // Codex `exec resume` only works reliably for the approach debate
    // (non-phase path where the adapter builds the prompt with omitContext).
    // Phase-specific calls pass pre-built prompts with full context which
    // confuses codex when resumed — returns 0 chars. So only resume for debate.
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

      yield {
        type: "structured_turn",
        actor: "gpt",
        turn: parseStructuredTurn("gpt", event.text)
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
