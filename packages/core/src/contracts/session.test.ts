import { describe, expect, it } from "vitest";
import { modelTurnSchema, milestoneReachedSchema, sessionStatusSchema } from "./session";

describe("session contracts", () => {
  it("parses a model turn envelope", () => {
    const parsed = modelTurnSchema.parse({
      actor: "gpt",
      rawText: "Refined the scope in detail",
      summary: "Refined the scope",
      newInsights: ["Need a checkpoint timer"],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: "Add hybrid checkpointing",
      milestoneReached: null,
      degraded: false
    });

    expect(parsed.actor).toBe("gpt");
  });

  it("limits session status to known values", () => {
    expect(sessionStatusSchema.parse("debating")).toBe("debating");
  });

  it("limits milestone values to the supported enum", () => {
    expect(milestoneReachedSchema.parse("architecture_selected")).toBe("architecture_selected");
  });
});
