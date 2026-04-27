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

  it("hardens the spec-generation review prompt output contract when peer drafts are present", () => {
    const prompt = buildSpecPrompt({
      role: "claude",
      originalProblem: "Design a planning system",
      interviewResults: [],
      approachResult: "Adopt a structured review flow",
      peerDraft: "# Draft spec\n\n# Draft plan"
    });

    expect(prompt).toContain("Respond ONLY with a single raw JSON object.");
    expect(prompt).toContain('Do not say things like "Here is the JSON" or "Below is the object".');
    expect(prompt).toContain("If you add any text outside the JSON object, your turn will be rejected.");
    expect(prompt).toContain("No markdown fences.");
    expect(prompt).toContain("No prose before or after the JSON.");
  });

  it("hardens the existing-spec revision prompt output contract when peer drafts are present", () => {
    const prompt = buildSpecPrompt({
      role: "claude",
      originalProblem: "EXISTING SPECIFICATION:\n# Spec",
      interviewResults: [],
      approachResult: "Revise the existing documents",
      peerDraft: "# Revised draft spec\n\n# Revised draft plan",
      mode: "existing_spec"
    });

    expect(prompt).toContain("Respond ONLY with a single raw JSON object.");
    expect(prompt).toContain('Do not say things like "Here is the JSON" or "Below is the object".');
    expect(prompt).toContain("If you add any text outside the JSON object, your turn will be rejected.");
    expect(prompt).toContain("No markdown fences.");
    expect(prompt).toContain("No prose before or after the JSON.");
  });
});
