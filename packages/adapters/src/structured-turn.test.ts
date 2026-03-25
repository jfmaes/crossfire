import { describe, expect, it } from "vitest";
import { parseStructuredTurn } from "./structured-turn";

describe("parseStructuredTurn", () => {
  it("preserves phase-specific fields on valid non-degraded turns", () => {
    const turn = parseStructuredTurn("claude", JSON.stringify({
      rawText: "Walkthrough found concrete issues.",
      summary: "Found walkthrough issues",
      newInsights: [],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: "Updated spec",
      milestoneReached: null,
      implementationPlan: "Updated plan",
      proposedQuestions: null,
      synthesizedQuestions: null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: [
        {
          location: "Phase 5.5",
          issue: "No dynamic importer check",
          fix: "Add dynamic importer analysis"
        }
      ]
    }));

    expect(turn.degraded).toBe(false);
    expect(turn.implementationPlan).toBe("Updated plan");
    expect(turn.walkthroughGaps).toEqual([
      {
        location: "Phase 5.5",
        issue: "No dynamic importer check",
        fix: "Add dynamic importer analysis"
      }
    ]);
  });
});
