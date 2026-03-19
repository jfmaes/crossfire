import { describe, expect, it } from "vitest";
import { FakeProvider } from "../testing/fake-provider";

describe("ProviderAdapter streaming contract", () => {
  it("supports status, stderr, structured_turn, and done events", async () => {
    const provider = new FakeProvider("gpt");
    const events = [];

    for await (const event of provider.sendTurn({
      sessionId: "sess_1",
      prompt: "Outline the risks"
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", value: "started" },
      { type: "stderr", text: "fake provider bootstrap" },
      {
        type: "structured_turn",
        actor: "gpt",
        turn: {
          actor: "gpt",
          rawText: "gpt raw response",
          summary: "gpt response",
          newInsights: ["gpt insight"],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "gpt delta",
          milestoneReached: null,
          degraded: false
        }
      },
      { type: "done" }
    ]);
  });
});
