import type { ExistingSpecWorkflowInput, WorkflowSpec } from "../contracts";

export const parallelExistingSpecReview: WorkflowSpec = {
  id: "parallel_existing_spec_review",
  description: "Launch one holistic existing-spec review session using the full Crossfire process.",
  buildSessionTemplates(input: ExistingSpecWorkflowInput) {
    return [{
      label: "existing-spec-review",
      lens: "end-to-end specification review",
      title: input.title,
      mode: "existing_spec" as const,
      prompt: [
        input.prompt?.trim() || "Review the supplied specification carefully.",
        "",
        "Primary review lens: end-to-end specification review.",
        "Use one holistic Crossfire review session that balances requirements, architecture, rollout risk, and operability together.",
        "Do not split this single spec review into multiple parallel lens conversations.",
        "Do not rewrite the whole document unless the submitted design is fundamentally unsound.",
        "Prioritize surfacing only the few human questions that are truly blocking a sound revision."
      ].join("\n"),
      existingSpec: { ...input.existingSpec }
    }];
  }
};
