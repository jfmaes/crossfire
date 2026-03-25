import { useEffect, useState } from "react";
import { getRunEvents, type SessionRun, type SessionRunEvent } from "../lib/api";

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function RunDetail({ run }: { run: SessionRun | null }) {
  const [events, setEvents] = useState<SessionRunEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!run) {
      setEvents([]);
      return;
    }

    let cancelled = false;
    const token = localStorage.getItem("council-token") ?? "local-dev-token";
    setLoading(true);

    void getRunEvents({ runId: run.id, token })
      .then((items) => {
        if (!cancelled) {
          setEvents(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvents([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [run?.id]);

  if (!run) {
    return null;
  }

  return (
    <details className="card card--run-detail">
      <summary className="card__header card__header--toggle">
        <h2>Run Detail</h2>
        <span className="run-detail__summary-info">
          <span className={`run-history__status run-history__status--${run.status}`}>
            {run.status}
          </span>
          <span className="run-detail__event-count">
            {loading ? "loading\u2026" : `${events.length} event${events.length !== 1 ? "s" : ""}`}
          </span>
        </span>
      </summary>

      <div className="run-detail__meta">
        <span>{run.kind}</span>
        <span>{run.phase ?? "unknown phase"}</span>
        <span>Started {formatTimestamp(run.startedAt)}</span>
        {run.finishedAt && <span>Finished {formatTimestamp(run.finishedAt)}</span>}
      </div>

      {run.errorMessage && (
        <div className="run-detail__error">{run.errorMessage}</div>
      )}

      <div className="run-detail__events">
        {loading && <div className="run-detail__empty">Loading run events\u2026</div>}
        {!loading && events.length === 0 && (
          <div className="run-detail__empty">No persisted events for this run.</div>
        )}
        {!loading && events.map((event) => (
          <div key={event.id} className={`run-detail__event run-detail__event--${event.type}`}>
            <div className="run-detail__event-top">
              <span className="run-detail__event-type">{event.type}</span>
              <span className="run-detail__event-time">{formatTimestamp(event.createdAt)}</span>
            </div>
            <div className="run-detail__event-message">{event.message}</div>
          </div>
        ))}
      </div>
    </details>
  );
}
