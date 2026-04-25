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

  it("includes rawText and summary in every phase contract", () => {
    for (const phase of ["analysis", "analysis_debate", "approach_debate", "spec_generation", "walkthrough"] as const) {
      expect(getRequiredFieldsForPhase(phase)).toEqual(
        expect.arrayContaining(["rawText", "summary"])
      );
    }
  });
});
