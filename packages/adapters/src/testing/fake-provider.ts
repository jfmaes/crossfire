import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";

export class FakeProvider implements ProviderAdapter {
  constructor(public readonly name: "gpt" | "claude") {}

  async *sendTurn(_input: ProviderTurnInput) {
    const turn: ModelTurn = {
      actor: this.name,
      rawText: `${this.name} raw response`,
      summary: `${this.name} response`,
      newInsights: [`${this.name} insight`],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: `${this.name} delta`,
      milestoneReached: null,
      implementationPlan: null,
      proposedQuestions: null,
      synthesizedQuestions: null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: null,
      degraded: false
    };

    yield { type: "status", value: "started" } as const;
    yield { type: "stderr", text: "fake provider bootstrap" } as const;
    yield {
      type: "structured_turn",
      actor: this.name,
      turn
    } as const;
    yield { type: "done" } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "fake provider ready" };
  }
}
