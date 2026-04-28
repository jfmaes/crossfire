import { useEffect, useState } from "react";
import {
  getRunEvents,
  type CompactionMetadata,
  type EndorsementCounts,
  type ProgressEventMetadata,
  type SessionRun,
  type SessionRunEvent
} from "../lib/api";
import { deriveMilestones } from "./progress-milestones";

function formatTimestamp(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatEventType(type: string): string {
  switch (type) {
    case "model_progress":
      return "progress";
    case "model_stream":
      return "cli";
    default:
      return type;
  }
}

function formatCompaction(compaction: CompactionMetadata): string {
  const percent = compaction.originalChars > 0
    ? Math.round((1 - (compaction.finalChars / compaction.originalChars)) * 100)
    : 0;
  const base = `${compaction.component}: ${compaction.originalChars} → ${compaction.finalChars} chars`;
  return percent > 0 ? `${base} (${percent}% smaller)` : base;
}

function formatEndorsementCounts(counts: EndorsementCounts): string {
  return `${counts.dual_endorsed} dual, ${counts.gpt_only} GPT-only, ${counts.claude_only} Claude-only`;
}

function formatStopReason(reason?: string | null): string | null {
  switch (reason) {
    case "consensus":
      return "consensus reached";
    case "questions_for_human":
      return "clarification needed";
    case "max_turns":
      return "turn cap reached";
    case "phase_invalid_turn":
      return "invalid turn output";
    case "spec_generation_input_too_large":
      return "spec input too large";
    case "revision_input_too_large":
      return "revision input too large";
    default:
      return reason ? reason.replaceAll("_", " ") : null;
  }
}

function metadataEntries(metadata?: ProgressEventMetadata | null): Array<[string, string]> {
  if (!metadata) return [];

  const entries: Array<[string, string]> = [];

  if (metadata.outputStatus) {
    entries.push(["status", metadata.outputStatus.replaceAll("_", " ")]);
  }

  const stopReasonValue = metadata.blockedReason ?? metadata.stopReason;
  if (stopReasonValue) {
    const stopReason = formatStopReason(stopReasonValue);
    if (stopReason) {
      entries.push(["stop", stopReason]);
    }
  }

  if (typeof metadata.totalTurns === "number") {
    entries.push(["turns", String(metadata.totalTurns)]);
  }

  if (typeof metadata.finalDisagreementCount === "number") {
    entries.push(["open disagreements", String(metadata.finalDisagreementCount)]);
  }

  if (metadata.missingFields && metadata.missingFields.length > 0) {
    entries.push(["missing fields", metadata.missingFields.join(", ")]);
  }

  if (metadata.conversationReused === true) {
    entries.push(["context", "reused"]);
  } else if (
    metadata.conversationReused === false ||
    metadata.freshContext === true ||
    metadata.startedFromFreshContext === true
  ) {
    entries.push(["context", "fresh"]);
  }

  if (metadata.endorsementCounts) {
    entries.push(["question provenance", formatEndorsementCounts(metadata.endorsementCounts)]);
  }

  if (metadata.canonicalApproachHandoff === true || metadata.usedCanonicalApproachHandoff === true) {
    entries.push(["approach handoff", "canonical"]);
  }

  if (metadata.authorityPathUncompacted === true) {
    entries.push(["authority path", "uncompressed"]);
  } else if (metadata.authorityPathCompacted === true) {
    entries.push(["authority path", "compacted"]);
  }

  if (metadata.blockedByOversize === true || metadata.oversizeBlocking === true) {
    entries.push(["blocked", "authority input too large"]);
  }

  if (metadata.promptLedger && metadata.promptLedger.length > 0) {
    const compactedCount = metadata.promptLedger.filter((entry) => entry.compacted).length;
    entries.push([
      "prompt ledger",
      `${metadata.promptLedger.length} component${metadata.promptLedger.length === 1 ? "" : "s"}${compactedCount > 0 ? `, ${compactedCount} compacted` : ""}`
    ]);
  }

  if (metadata.compaction) {
    const label =
      metadata.compaction.component === "approachResult" ||
      metadata.compaction.component === "peerDraft" ||
      metadata.compaction.component === "revisionPeerDraft"
        ? "authority input"
        : "compaction";
    entries.push([label, formatCompaction(metadata.compaction)]);
  } else if (metadata.compacted && metadata.component) {
    const label =
      metadata.component === "approachResult" ||
      metadata.component === "peerDraft" ||
      metadata.component === "revisionPeerDraft"
        ? "authority input"
        : "compaction";
    entries.push([label, `${metadata.component}: compacted`]);
  } else if (metadata.compacted) {
    entries.push(["compaction", "applied"]);
  }

  if (metadata.finalDisagreements && metadata.finalDisagreements.length > 0) {
    entries.push(["final disagreement list", `${metadata.finalDisagreements.length} item${metadata.finalDisagreements.length === 1 ? "" : "s"}`]);
  }

  return entries;
}

export function RunDetail({ run }: { run: SessionRun | null }) {
  const [events, setEvents] = useState<SessionRunEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const recentMilestones = deriveMilestones(events).slice(-5).reverse();

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
        {!loading && recentMilestones.length > 0 && (
          <div className="run-detail__milestones">
            <div className="run-detail__milestones-heading">Recent milestones</div>
            {recentMilestones.map((milestone) => (
              <div key={milestone.id} className="run-detail__milestone">
                <span className="run-detail__event-time">{formatTimestamp(milestone.createdAt)}</span>
                <span className="run-detail__event-message">{milestone.text}</span>
              </div>
            ))}
          </div>
        )}
        {!loading && events.map((event) => (
          <div key={event.id} className={`run-detail__event run-detail__event--${event.type}`}>
            <div className="run-detail__event-top">
              <span className="run-detail__event-type">{formatEventType(event.type)}</span>
              <span className="run-detail__event-time">{formatTimestamp(event.createdAt)}</span>
            </div>
            <div className="run-detail__event-message">{event.message}</div>
            {metadataEntries(event.metadata).length > 0 && (
              <div className="run-detail__event-meta">
                {metadataEntries(event.metadata).map(([key, value]) => (
                  <span key={`${event.id}-${key}`} className="trace-pill">
                    {key}: {value}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
