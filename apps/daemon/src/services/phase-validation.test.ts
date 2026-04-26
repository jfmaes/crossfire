import { describe, expect, it } from "vitest";
import { getRequiredFieldsForPhase, validatePhaseTurn } from "./phase-validation";

describe("phase-validation", () => {
  it("requires proposedQuestions for analysis turns", () => {
    const result = validatePhaseTurn("analysis", {
      rawText: "analysis",
      summary: "summary",
      questionsForHuman: []
    });

    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(["proposedQuestions"]);
  });

  it("requires synthesizedQuestions for question synthesis turns", () => {
    const result = validatePhaseTurn("analysis_debate", {
      rawText: "debate",
      summary: "summary",
      disagreements: [],
      questionsForHuman: []
    });

    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(["synthesizedQuestions"]);
  });

  it("requires milestoneReached for approach debate turns", () => {
    const result = validatePhaseTurn("approach_debate", {
      rawText: "debate",
      summary: "summary",
      disagreements: [],
      questionsForHuman: [],
      proposedSpecDelta: "delta"
    });

    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(["milestoneReached"]);
  });

  it("requires implementationPlan for spec generation turns", () => {
    const result = validatePhaseTurn("spec_generation", {
      rawText: "spec",
      summary: "summary",
      proposedSpecDelta: "delta",
      milestoneReached: "implementation_plan_ready"
    });

    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(["implementationPlan"]);
  });

  it("requires walkthroughGaps for walkthrough turns", () => {
    const result = validatePhaseTurn("walkthrough", {
      rawText: "walkthrough",
      summary: "summary"
    });

    expect(result.ok).toBe(false);
    expect(result.missingFields).toEqual(["walkthroughGaps"]);
  });

  it("only requires rawText and summary for gap synthesis turns", () => {
    const result = validatePhaseTurn("gap_synthesis", {
      rawText: "repair brief",
      summary: "summary"
    });

    expect(result.ok).toBe(true);
    expect(result.missingFields).toEqual([]);
  });

  it("requires digest fields for feedback digest turns", () => {
    const result = validatePhaseTurn("feedback_digest", {
      rawText: "digest",
      summary: "summary",
      proposedSpecDelta: "- request"
    });

    expect(result.ok).toBe(true);
    expect(result.missingFields).toEqual([]);
  });

  it("includes rawText and summary in every phase contract", () => {
    for (const phase of ["analysis", "analysis_debate", "approach_debate", "feedback_digest", "spec_generation", "walkthrough", "gap_synthesis"] as const) {
      expect(getRequiredFieldsForPhase(phase)).toEqual(
        expect.arrayContaining(["rawText", "summary"])
      );
    }
  });
});
