import type { SessionRun } from "../lib/api";

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatKind(kind: string): string {
  switch (kind) {
    case "create":
      return "Initial run";
    case "continue":
      return "Continue";
    case "restart":
      return "Restart";
    case "retry":
      return "Retry";
    case "revise":
      return "Revision";
    default:
      return kind;
  }
}

export function RunHistory({
  runs,
  activeRunId,
  selectedRunId,
  onSelect
}: {
  runs: SessionRun[];
  activeRunId?: string | null;
  selectedRunId?: string | null;
  onSelect?: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return null;
  }

  const hasActive = runs.some((r) => r.id === activeRunId);
  const failedCount = runs.filter((r) => r.status === "failed" || r.status === "errored").length;

  return (
    <details className="card card--run-history" open={hasActive}>
      <summary className="card__header card__header--toggle">
        <h2>Run History</h2>
        <span className="run-history__summary-meta">
          {runs.length} run{runs.length !== 1 ? "s" : ""}
          {failedCount > 0 && <span className="run-history__fail-count">{failedCount} failed</span>}
        </span>
      </summary>
      <div className="run-history">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={`run-history__item ${run.id === activeRunId ? "run-history__item--active" : ""} ${run.id === selectedRunId ? "run-history__item--selected" : ""}`}
            onClick={() => onSelect?.(run.id)}
          >
            <div className="run-history__top">
              <span className="run-history__kind">{formatKind(run.kind)}</span>
              <span className={`run-history__status run-history__status--${run.status}`}>
                {run.id === activeRunId ? "Active" : run.status}
              </span>
            </div>
            <div className="run-history__meta">
              <span>{run.phase ?? "unknown phase"}</span>
              <span>{formatTimestamp(run.startedAt)}</span>
            </div>
            {run.errorMessage && (
              <div className="run-history__error">{run.errorMessage}</div>
            )}
          </button>
        ))}
      </div>
    </details>
  );
}
