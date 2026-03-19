import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";

class FakeClaudeProcess {
  async *runTurn() {
    yield {
      type: "result",
      text: JSON.stringify({
        rawText: "Need the human to confirm mobile support.",
        summary: "Need human confirmation on mobile support",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: ["Should mobile support be included in v1?"],
        proposedSpecDelta: "Include mobile web support",
        milestoneReached: null
      })
    } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "claude ready" };
  }
}

describe("ClaudeAdapter", () => {
  it("normalizes streamed Claude messages", async () => {
    const adapter = new ClaudeAdapter(new FakeClaudeProcess());
    const events: string[] = [];

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Find hidden risks"
    })) {
      events.push(event.type);
    }

    expect(events).toContain("structured_turn");
  });
});
