import { describe, expect, it } from "vitest";
import { parallelExistingSpecReview } from "./parallel-existing-spec-review";

describe("parallelExistingSpecReview", () => {
  it("builds four distinct existing_spec child templates with lens-shaped prompts", () => {
    const input = {
      title: "Payments spec review",
      prompt: "Focus on concrete revision guidance.",
      existingSpec: {
        spec: "# Spec\n\nCurrent draft",
        implementationPlan: "# Plan\n\nRollout in phases"
      }
    };

    const templates = parallelExistingSpecReview.buildSessionTemplates(input);

    expect(templates).toHaveLength(4);
    expect(templates.map((template) => template.label)).toEqual([
      "requirements",
      "architecture",
      "release-risk",
      "operability"
    ]);
    expect(new Set(templates.map((template) => template.label)).size).toBe(4);
    expect(templates.every((template) => template.mode === "existing_spec")).toBe(true);

    expect(templates[0]).toMatchObject({
      label: "requirements",
      lens: "requirements and ambiguity gaps"
    });
    expect(templates[0]?.prompt).toContain("Primary review lens: requirements and ambiguity gaps.");
    expect(templates[0]?.prompt).toContain("Focus on concrete revision guidance.");

    expect(templates[1]).toMatchObject({
      label: "architecture",
      lens: "architecture and boundary quality"
    });
    expect(templates[1]?.prompt).toContain("architecture and boundary quality");

    expect(templates[2]).toMatchObject({
      label: "release-risk",
      lens: "implementation and rollout risk"
    });
    expect(templates[2]?.prompt).toContain("implementation and rollout risk");

    expect(templates[3]).toMatchObject({
      label: "operability",
      lens: "testing, failure modes, and operability"
    });
    expect(templates[3]?.prompt).toContain("testing, failure modes, and operability");

    for (const template of templates) {
      expect(template.prompt).toContain("Do not rewrite the whole document unless the submitted design is fundamentally unsound.");
      expect(template.prompt).toContain("Prioritize surfacing questions, risks, and revision guidance within this lens.");
      expect(template.existingSpec.spec).toContain("Current draft");
      expect(template.existingSpec).toEqual(input.existingSpec);
      expect(template.existingSpec).not.toBe(input.existingSpec);
    }
  });
});
