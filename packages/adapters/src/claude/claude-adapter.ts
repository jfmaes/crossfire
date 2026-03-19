import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { parseStructuredTurn } from "../structured-turn";
import type { ClaudeProcess } from "./claude-process";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  constructor(private readonly processRunner: ClaudeProcess) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    // When a phase is set, the caller has already built a phase-specific prompt — use it directly.
    const prompt = input.phase
      ? input.prompt
      : buildStructuredTurnPrompt({
          role: "claude",
          originalProblem: input.originalProblem ?? input.prompt,
          peerResponse: input.peerResponse,
          turnNumber: input.turnNumber ?? 1,
          totalTurns: input.totalTurns ?? 4
        });

    for await (const event of this.processRunner.runTurn({ ...input, prompt })) {
      if (event.type === "stderr") {
        yield { type: "stderr", text: event.text } as const;
        continue;
      }

      if (event.type === "error") {
        yield { type: "error", message: event.message } as const;
        continue;
      }

      yield {
        type: "structured_turn",
        actor: "claude",
        turn: parseStructuredTurn("claude", event.text)
      } as const;
    }

    yield { type: "done" } as const;
  }

  healthCheck() {
    return this.processRunner.healthCheck();
  }
}
