import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter";

class FakeCodexTransport {
  async *runTurn() {
    yield {
      kind: "result",
      text: JSON.stringify({
        rawText: "We should bound the checkpoint loop.",
        summary: "Bound the checkpoint loop",
        newInsights: ["Need a hard stop"],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Add a turn-count cutoff",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null
      })
    } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "codex ready" };
  }
}

describe("CodexAdapter", () => {
  it("normalizes transport events into provider events", async () => {
    const adapter = new CodexAdapter(new FakeCodexTransport());
    const events: string[] = [];

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Review the checkpoint logic"
    })) {
      events.push(event.type);
    }

    expect(events).toContain("structured_turn");
  });
});
