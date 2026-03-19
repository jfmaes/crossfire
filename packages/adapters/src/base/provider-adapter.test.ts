import { describe, expect, it } from "vitest";
import { FakeProvider } from "../testing/fake-provider";

describe("FakeProvider", () => {
  it("streams normalized provider events", async () => {
    const provider = new FakeProvider("gpt");
    const events: string[] = [];

    for await (const event of provider.sendTurn({
      sessionId: "sess_1",
      prompt: "Outline the risks"
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["status", "stderr", "structured_turn", "done"]);
  });
});
