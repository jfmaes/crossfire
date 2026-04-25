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
      implementationPlan: null,
      proposedQuestions: [
        {
          text: "Should Crossfire manage authoritative artifacts or advisory notes?",
          priority: 1,
          rationale: "This changes whether the system needs freshness and invalidation guarantees.",
          context: "In plain English: should the saved files be the official source of truth or just helpful notes?",
          recommendation: "Prefer authoritative machine-managed artifacts.",
          recommendationReasoning: "That is safer for brownfield work because stale notes can mislead later runs."
        }
      ],
      synthesizedQuestions: null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: null,
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
