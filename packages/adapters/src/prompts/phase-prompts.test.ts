import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, buildSpecPrompt } from "./phase-prompts";

describe("existing spec prompt framing", () => {
  it("frames analysis as review when session mode is existing_spec", () => {
    const prompt = buildAnalysisPrompt({
      role: "gpt",
      originalProblem: "EXISTING SPECIFICATION:\n# Spec",
      mode: "existing_spec"
    });

    expect(prompt).toContain("PHASE: EXISTING SPEC REVIEW ANALYSIS");
    expect(prompt).toContain("Treat the submitted spec and implementation plan as the subject under review");
    expect(prompt).toContain("Ask questions only when the supplied documents do not contain enough information");
  });

  it("frames spec generation as revision when session mode is existing_spec", () => {
    const prompt = buildSpecPrompt({
      role: "claude",
      originalProblem: "EXISTING SPECIFICATION:\n# Spec",
      interviewResults: [],
      approachResult: "Revision strategy",
      mode: "existing_spec"
    });

    expect(prompt).toContain("PHASE: EXISTING SPEC REVISION");
    expect(prompt).toContain("Revise the supplied specification and implementation plan");
    expect(prompt).not.toContain("produce TWO separate markdown documents:");
  });
});
