import type { WorkflowClassification, WorkflowSessionSnapshot } from "../contracts";

const TERMINAL_ERROR_PATTERN =
  /\b(unsupported|forbidden|unauthorized|invalid input|missing required)\b|phase[-_]invalid(?:[_-]turn)?/i;

const TRANSIENT_ERROR_PATTERN =
  /\b(provider|timeout|timed out|terminated|termination|killed|network|connection|unavailable|rate limit)\b/i;

export function classifyChildSession(
  snapshot: WorkflowSessionSnapshot,
  _events: Array<Record<string, unknown>>
): WorkflowClassification {
  const { status } = snapshot.session;

  if (status === "waiting_for_human" || status === "interviewing") {
    return {
      state: "human_blocked",
      reason: "Crossfire is waiting for a human answer."
    };
  }

  if (status === "checkpoint") {
    return {
      state: "human_blocked",
      reason: "Crossfire is waiting for a human approval or decision."
    };
  }

  if (status === "finalized") {
    return {
      state: "finalized",
      reason: "Crossfire finalized the child session."
    };
  }

  if (status === "errored") {
    const recentErroredRun = snapshot.recentRuns?.find(
      (run) => run.status === "errored" && run.errorMessage
    );
    const errorMessage =
      snapshot.activeRun?.errorMessage ??
      recentErroredRun?.errorMessage ??
      snapshot.recentRuns?.find((run) => run.errorMessage)?.errorMessage ??
      "Crossfire entered an errored state.";

    return {
      state: "errored",
      errorState: TERMINAL_ERROR_PATTERN.test(errorMessage)
        ? "terminal"
        : TRANSIENT_ERROR_PATTERN.test(errorMessage)
          ? "recoverable_transient"
          : "recoverable_operator",
      reason: errorMessage
    };
  }

  return {
    state: "running",
    reason: "Crossfire is actively progressing."
  };
}
