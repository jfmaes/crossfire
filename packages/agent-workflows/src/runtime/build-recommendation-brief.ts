import type {
  RecommendationBrief,
  WorkflowClassification,
  WorkflowSessionSnapshot
} from "../contracts";

export function buildRecommendationBrief(
  snapshot: WorkflowSessionSnapshot,
  classification: WorkflowClassification
): RecommendationBrief | null {
  if (classification.state === "human_blocked") {
    const currentQuestion = snapshot.interviewState?.currentQuestion;

    if (currentQuestion) {
      return {
        kind: "human_blocked",
        label: snapshot.label,
        lens: snapshot.lens,
        summary: snapshot.summary?.currentUnderstanding ?? classification.reason,
        recommendedDirection:
          currentQuestion.recommendation ??
          snapshot.summary?.recommendation ??
          "Review the question and answer explicitly.",
        risks: snapshot.summary?.openRisks ?? [],
        questions: [currentQuestion.text]
      };
    }

    return {
      kind: "human_blocked",
      label: snapshot.label,
      lens: snapshot.lens,
      summary: snapshot.summary?.currentUnderstanding ?? classification.reason,
      recommendedDirection:
        snapshot.summary?.recommendation ??
        "Review the checkpoint and decide whether to continue.",
      risks: snapshot.summary?.openRisks ?? [],
      questions: snapshot.summary?.decisionsNeeded ?? []
    };
  }

  if (classification.state === "errored") {
    return {
      kind: "recovery_needed",
      label: snapshot.label,
      lens: snapshot.lens,
      summary: classification.reason,
      recommendedDirection:
        classification.errorState === "terminal"
          ? "Do not retry automatically. Repair the underlying input or workflow state manually before continuing."
          : classification.errorState === "recoverable_transient"
          ? "Retry or restart this child session after reviewing the latest run error."
          : "Inspect the child session manually before continuing.",
      risks: snapshot.summary?.openRisks ?? [],
      questions: []
    };
  }

  return null;
}
