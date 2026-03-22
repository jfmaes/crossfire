import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { parseStructuredTurn } from "../structured-turn";
import type { ClaudeProcess } from "./claude-process";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  /**
   * Tracks Claude CLI session IDs for conversation resumption within a single
   * phase context.
   *
   * Key: "sessionId:phaseKey", Value: Claude CLI session_id.
   *
   * Reusing one Claude conversation across different prompt shapes causes
   * phase bleed, especially on spec generation where Claude can stall and
   * return no output. Starting fresh on phase boundaries keeps the prompt
   * contract stable while still allowing reuse within repeated turns of the
   * same phase.
   */
  private readonly cliSessions = new Map<string, string>();

  constructor(private readonly processRunner: ClaudeProcess) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    const phaseKey = input.phase ?? "debate";
    const sessionKey = `${input.sessionId}:${phaseKey}`;
    const isAnalysis = phaseKey === "analysis";
    const resumeSessionId = isAnalysis ? undefined : this.cliSessions.get(sessionKey);
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
        this.cliSessions.set(sessionKey, event.cliSessionId);
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
    const prefix = `${sessionId}:`;
    for (const key of this.cliSessions.keys()) {
      if (key.startsWith(prefix)) {
        this.cliSessions.delete(key);
      }
    }
  }

  healthCheck() {
    return this.processRunner.healthCheck();
  }
}
