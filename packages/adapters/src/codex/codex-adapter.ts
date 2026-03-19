import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";
import { buildStructuredTurnPrompt } from "../prompts/structured-turn";
import { parseStructuredTurn } from "../structured-turn";
import type { CodexTransport } from "./codex-transport";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "gpt";

  constructor(private readonly transport: CodexTransport) {}

  async *sendTurn(input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;

    // When a phase is set, the caller has already built a phase-specific prompt — use it directly.
    const prompt = input.phase
      ? input.prompt
      : buildStructuredTurnPrompt({
          role: "gpt",
          originalProblem: input.originalProblem ?? input.prompt,
          peerResponse: input.peerResponse,
          turnNumber: input.turnNumber ?? 1,
          totalTurns: input.totalTurns ?? 4
        });

    for await (const event of this.transport.runTurn({ ...input, prompt })) {
      if (event.kind === "stderr") {
        yield { type: "stderr", text: event.text } as const;
        continue;
      }

      if (event.kind === "error") {
        yield { type: "error", message: event.message } as const;
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

  healthCheck() {
    return this.transport.healthCheck();
  }
}
