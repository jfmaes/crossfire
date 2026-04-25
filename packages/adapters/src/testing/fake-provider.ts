import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";

export class FakeProvider implements ProviderAdapter {
  constructor(public readonly name: "gpt" | "claude") {}

  async *sendTurn(input: ProviderTurnInput) {
    const turn: ModelTurn = {
      actor: this.name,
      rawText: `${this.name} raw response`,
      summary: `${this.name} response`,
      newInsights: [`${this.name} insight`],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: input.phase === "spec_generation" ? `${this.name} spec` : `${this.name} delta`,
      milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
      implementationPlan: input.phase === "spec_generation" ? `${this.name} implementation plan` : null,
      proposedQuestions: input.phase === "analysis" ? [] : null,
      synthesizedQuestions: input.phase === "analysis_debate" ? [] : null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: input.phase === "walkthrough" ? [] : null,
      degraded: false
    };

    yield { type: "status", value: "started" } as const;
    yield { type: "stderr", text: "fake provider bootstrap" } as const;
    yield {
      type: "structured_turn",
      actor: this.name,
      turn,
      rawResponse: JSON.stringify(turn)
    } as const;
    yield { type: "done" } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "fake provider ready" };
  }
}
