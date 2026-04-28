import type { ExistingSpecWorkflowInput, WorkflowSpec } from "../contracts";

const REVIEW_LENSES = [
  {
    label: "requirements",
    lens: "requirements and ambiguity gaps"
  },
  {
    label: "architecture",
    lens: "architecture and boundary quality"
  },
  {
    label: "release-risk",
    lens: "implementation and rollout risk"
  },
  {
    label: "operability",
    lens: "testing, failure modes, and operability"
  }
] as const;

export const parallelExistingSpecReview: WorkflowSpec = {
  id: "parallel_existing_spec_review",
  description: "Launch four existing-spec review sessions with complementary review lenses.",
  buildSessionTemplates(input: ExistingSpecWorkflowInput) {
    return REVIEW_LENSES.map(({ label, lens }) => ({
      label,
      lens,
      title: `${input.title} (${lens})`,
      mode: "existing_spec" as const,
      prompt: [
        input.prompt?.trim() || "Review the supplied specification carefully.",
        "",
        `Primary review lens: ${lens}.`,
        "Stay within this lens even if other concerns are visible; note cross-lens issues briefly and return to your assigned review focus.",
        "Do not rewrite the whole document unless the submitted design is fundamentally unsound.",
        "Prioritize surfacing questions, risks, and revision guidance within this lens."
      ].join("\n"),
      existingSpec: { ...input.existingSpec }
    }));
  }
};
