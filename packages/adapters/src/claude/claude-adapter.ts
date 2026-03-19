import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { parseStructuredTurn } from "../structured-turn";
import type { ClaudeProcess } from "./claude-process";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  /**
   * Tracks CLI session IDs for conversation resumption across all phases.
   * Key: Crossfire sessionId, Value: Claude CLI session_id.
   * Analysis phase always starts fresh; all subsequent phases/debates resume.
   */
  private readonly cliSessions = new Map<string, string>();

  constructor(private readonly processRunner: ClaudeProcess) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    // Analysis is always the entry point — start a fresh conversation.
    // All subsequent phases resume the same conversation, so the model
    // already has the original problem, analysis results, debate context, etc.
    const isAnalysis = input.phase === "analysis";
    const resumeSessionId = isAnalysis ? undefined : this.cliSessions.get(input.sessionId);
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
      if (event.cliSessionId) {
        this.cliSessions.set(input.sessionId, event.cliSessionId);
      }

      yield {
        type: "structured_turn",
        actor: "claude",
        turn: parseStructuredTurn("claude", event.text)
      } as const;
    }

    yield { type: "done" } as const;
  }

  clearSession(sessionId: string) {
    this.cliSessions.delete(sessionId);
  }

  healthCheck() {
    return this.processRunner.healthCheck();
  }
}
