import { describe, expect, it } from "vitest";
import { parallelExistingSpecReview } from "./parallel-existing-spec-review";

describe("parallelExistingSpecReview", () => {
  it("builds one holistic existing_spec child template", () => {
    const input = {
      title: "Payments spec review",
      prompt: "Focus on concrete revision guidance.",
      existingSpec: {
        spec: "# Spec\n\nCurrent draft",
        implementationPlan: "# Plan\n\nRollout in phases"
      }
    };

    const templates = parallelExistingSpecReview.buildSessionTemplates(input);

    expect(templates).toHaveLength(1);
    expect(templates.every((template) => template.mode === "existing_spec")).toBe(true);

    expect(templates[0]).toMatchObject({
      label: "existing-spec-review",
      lens: "end-to-end specification review"
    });
    expect(templates[0]?.prompt).toContain("Primary review lens: end-to-end specification review.");
    expect(templates[0]?.prompt).toContain("Focus on concrete revision guidance.");
    expect(templates[0]?.prompt).toContain("Use one holistic Crossfire review session");
    expect(templates[0]?.prompt).toContain("Do not split this single spec review into multiple parallel lens conversations.");

    for (const template of templates) {
      expect(template.prompt).toContain("Do not rewrite the whole document unless the submitted design is fundamentally unsound.");
      expect(template.prompt).toContain("Prioritize surfacing only the few human questions that are truly blocking a sound revision.");
      expect(template.existingSpec.spec).toContain("Current draft");
      expect(template.existingSpec).toEqual(input.existingSpec);
      expect(template.existingSpec).not.toBe(input.existingSpec);
    }
  });
});
