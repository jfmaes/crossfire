import { useEffect, useRef, useState } from "react";
import { getRunEvents, type ProgressEventMetadata } from "../lib/api";
import { deriveMilestones } from "./progress-milestones";

interface ProgressEvent {
  sessionId: string;
  runId?: string;
  type: string;
  message: string;
  model?: string;
  phase?: string;
  turnNumber?: number;
  elapsedMs?: number;
  disagreements?: number;
  metadata?: ProgressEventMetadata | null;
}

interface TimedProgressEvent extends ProgressEvent {
  id: number;
  receivedAt: number;
}

interface ActiveModelState {
  key: string;
  model: string;
  phase?: string;
  turnNumber?: number;
  startedAt: number;
  latestMessage: string | null;
}

interface PendingState {
  title: string;
  detail: string;
  startedAt: number;
}

function eventKey(event: Pick<ProgressEvent, "model" | "phase" | "turnNumber">): string {
  return `${event.model ?? "system"}:${event.phase ?? ""}:${event.turnNumber ?? "single"}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function describeActivity(input: { model?: string; phase?: string; turnNumber?: number }): string {
  if (!input.model) return "Working";

  if (input.phase === "feedback_digest") {
    return "Extracting feedback changes";
  }

  if (input.phase === "spec_generation") {
    return input.model === "gpt" ? "Drafting specification" : "Reviewing and refining spec";
  }

  if (input.phase === "walkthrough") {
    return "Running adversarial walkthrough";
  }

  if (input.phase === "analysis") {
    return "Analyzing problem";
  }

  if (input.phase === "analysis_debate") {
    return "Debating interview questions";
  }

  if (input.phase === "interview") {
    return "Evaluating interview answer";
  }

  if (input.phase === "approach_debate" || input.turnNumber) {
    return input.turnNumber ? `Debate turn ${input.turnNumber}` : "Debating approach";
  }

  return "Working";
}

function formatEventLabel(type: string): string | null {
  switch (type) {
    case "model_progress":
      return "Progress";
    case "model_stream":
      return "CLI";
    default:
      return null;
  }
}

function formatStopReason(reason?: string | null): string | null {
  switch (reason) {
    case "consensus":
      return "outcome: consensus reached";
    case "questions_for_human":
      return "outcome: clarification needed";
    case "max_turns":
      return "outcome: turn cap reached";
    case "phase_invalid_turn":
      return "outcome: invalid turn";
    case "spec_generation_input_too_large":
      return "blocked: spec input too large";
    case "revision_input_too_large":
      return "blocked: revision input too large";
    case "feedback_input_too_large":
      return "blocked: feedback too large";
    default:
      return reason ? `outcome: ${reason.replaceAll("_", " ")}` : null;
  }
}

function isAuthorityPathComponent(component?: string | null): boolean {
  return component === "approachResult" || component === "peerDraft" || component === "revisionPeerDraft";
}

function isWarningBadge(badge: string): boolean {
  return badge.includes("degraded") ||
    badge.includes("phase-invalid") ||
    badge.includes("provider-error") ||
    badge.includes("blocked:") ||
    badge.includes("reused context") ||
    badge.includes("compacted");
}

function eventMetadataBadges(event: Pick<ProgressEvent, "phase" | "metadata">): string[] {
  const metadata = event.metadata;
  if (!metadata) return [];

  const badges: string[] = [];
  if (metadata.outputStatus === "degraded") badges.push("degraded");
  if (metadata.outputStatus === "phase_invalid") badges.push("phase-invalid");
  if (metadata.outputStatus === "provider_error") badges.push("provider-error");
  if (metadata.conversationReused === true) {
    badges.push("reused context");
  } else if (
    metadata.freshContext === true ||
    metadata.startedFromFreshContext === true ||
    ((event.phase === "spec_generation" || event.phase === "walkthrough") && metadata.conversationReused === false)
  ) {
    badges.push("fresh context");
  }
  const stopReasonValue = metadata.blockedReason ?? metadata.stopReason;
  if (stopReasonValue && typeof stopReasonValue === "string") {
    const stopReason = formatStopReason(stopReasonValue);
    if (stopReason) badges.push(stopReason);
  }
  if (typeof metadata.finalDisagreementCount === "number" && metadata.finalDisagreementCount > 0) {
    badges.push(`open disagreements: ${metadata.finalDisagreementCount}`);
  }
  if (metadata.canonicalApproachHandoff === true || metadata.usedCanonicalApproachHandoff === true) {
    badges.push("canonical handoff");
  }
  if (metadata.authorityPathUncompacted === true) {
    badges.push("authority path uncompressed");
  }
  if (metadata.blockedByOversize === true || metadata.oversizeBlocking === true) {
    badges.push("blocked: authority input too large");
  }
  if (metadata.compaction) {
    if (isAuthorityPathComponent(metadata.compaction.component)) {
      badges.push(`authority input compacted: ${metadata.compaction.component}`);
    } else {
      const ratio = metadata.compaction.originalChars > 0
      ? Math.round((1 - (metadata.compaction.finalChars / metadata.compaction.originalChars)) * 100)
      : 0;
      badges.push(`compacted ${metadata.compaction.component}${ratio > 0 ? ` ${ratio}%` : ""}`);
    }
  } else if (metadata.compacted === true) {
    badges.push(
      isAuthorityPathComponent(metadata.component)
        ? `authority input compacted${metadata.component ? `: ${metadata.component}` : ""}`
        : "compacted"
    );
  }

  const promptLedger = metadata.promptLedger ?? [];
  if (!metadata.compaction && promptLedger.some((entry) => entry.compacted === true)) {
    badges.push("prompt compacted");
  }

  return badges;
}

export function ProgressFeed({
  sessionId,
  runId = null,
  resetToken = 0,
  pendingState = null,
  onEvent
}: {
  sessionId: string | null;
  runId?: string | null;
  resetToken?: number;
  pendingState?: PendingState | null;
  onEvent?: (event: ProgressEvent) => void;
}) {
  const [events, setEvents] = useState<TimedProgressEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const prevEventCount = useRef(0);

  useEffect(() => {
    setEvents([]);
  }, [sessionId, resetToken]);

  useEffect(() => {
    if (!runId) return;

    let cancelled = false;
    const token = localStorage.getItem("council-token") ?? "local-dev-token";

    void getRunEvents({ runId, token })
      .then((items) => {
        if (cancelled) return;
        setEvents(items.map((event, index) => ({
          ...event,
          id: index + 1,
          receivedAt: Date.parse(event.createdAt)
        })));
      })
      .catch(() => {
        // Ignore hydration failures; live SSE can still populate the feed
      });

    return () => {
      cancelled = true;
    };
  }, [runId, resetToken]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const token = localStorage.getItem("council-token") ?? "local-dev-token";
    const params = new URLSearchParams({ token });
    if (sessionId) {
      params.set("sessionId", sessionId);
    }
    if (runId) {
      params.set("runId", runId);
    }
    const source = new EventSource(`/progress?${params.toString()}`);

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ProgressEvent;
        onEvent?.(event);
        setEvents((prev) => [
          ...prev.slice(-59),
          {
            ...event,
            id: (prev.at(-1)?.id ?? 0) + 1,
            receivedAt: Date.now()
          }
        ]);
      } catch {
        // Ignore malformed events
      }
    };

    source.onerror = () => {
      // Connection lost — EventSource auto-reconnects
    };

    return () => source.close();
  }, [sessionId, runId, onEvent]);

  useEffect(() => {
    if (events.length === 0) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [events.length]);

  const activeStates = new Map<string, ActiveModelState>();

  for (const event of events) {
    const key = eventKey(event);

    if (event.type === "model_start" && event.model) {
      activeStates.set(key, {
        key,
        model: event.model,
        phase: event.phase,
        turnNumber: event.turnNumber,
        startedAt: event.receivedAt,
        latestMessage: null
      });
      continue;
    }

    if ((event.type === "model_stream" || event.type === "model_progress") && event.model) {
      const existing = activeStates.get(key);
      activeStates.set(key, {
        key,
        model: event.model,
        phase: event.phase,
        turnNumber: event.turnNumber,
        startedAt: existing?.startedAt ?? event.receivedAt,
        latestMessage: event.message
      });
      continue;
    }

    if (event.type === "model_done") {
      activeStates.delete(key);
    }
  }

  const active = [...activeStates.values()];
  const visibleEvents = events.length > 0
    ? events
    : pendingState
      ? [{
          id: -1,
          receivedAt: pendingState.startedAt,
          sessionId: sessionId ?? "pending",
          type: "info",
          message: pendingState.detail
        } as TimedProgressEvent]
      : [];
  const milestones = deriveMilestones(visibleEvents.map((event) => ({
    id: String(event.id),
    runId: event.runId ?? "",
    sessionId: event.sessionId,
    type: event.type,
    message: event.message,
    model: event.model ?? null,
    phase: event.phase ?? null,
    turnNumber: event.turnNumber ?? null,
    elapsedMs: event.elapsedMs ?? null,
    disagreements: event.disagreements ?? null,
    metadata: event.metadata ?? null,
    createdAt: new Date(event.receivedAt).toISOString()
  })));
  const latestMilestone = milestones.at(-1) ?? null;
  const recentMilestones = milestones.slice(-5).reverse();

  useEffect(() => {
    if (visibleEvents.length > prevEventCount.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
    prevEventCount.current = visibleEvents.length;
  }, [visibleEvents.length]);

  if (events.length === 0 && !pendingState) {
    return null;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  return (
    <div className={`progress-feed ${active.length > 0 ? "progress-feed--live" : ""}`}>
      <div className="progress-feed__header">
        <h3 className="progress-feed__title">
          {active.length > 0 && <span className="progress-feed__live-dot" />}
          Live progress
        </h3>
        {(active.length > 0 || pendingState) && (
          <span className="progress-feed__badge">
            {active.length > 0 ? `${active.length} active` : "starting"}
          </span>
        )}
      </div>

      {(active.length > 0 || pendingState || latestMilestone) && (
        <div className="progress-feed__active">
          {latestMilestone && (
            <div className="progress-feed__milestone">
              <div className="progress-feed__milestone-title">{latestMilestone.text}</div>
            </div>
          )}
          {active.map((item) => (
            <div key={item.key} className={`progress-feed__active-card progress-feed__active-card--${item.model}`}>
              <div className="progress-feed__active-top">
                <span className={`progress-feed__model progress-feed__model--${item.model}`}>
                  {item.model.toUpperCase()}
                </span>
                <span className="progress-feed__timer">
                  {formatElapsed(now - item.startedAt)}
                </span>
              </div>
              <div className="progress-feed__active-title">
                {describeActivity(item)}
              </div>
              <div className="progress-feed__active-body">
                {item.latestMessage || "Still working. Waiting for model output…"}
              </div>
            </div>
          ))}
          {active.length === 0 && pendingState && milestones.length === 0 && (
            <div className="progress-feed__active-card progress-feed__active-card--pending">
              <div className="progress-feed__active-top">
                <span className="progress-feed__model progress-feed__model--pending">SYSTEM</span>
                <span className="progress-feed__timer">
                  {formatElapsed(now - pendingState.startedAt)}
                </span>
              </div>
              <div className="progress-feed__active-title">
                {pendingState.title}
              </div>
              <div className="progress-feed__active-body">
                {pendingState.detail}
              </div>
            </div>
          )}
          {recentMilestones.length > 0 && (
            <div className="progress-feed__milestones">
              <div className="progress-feed__milestones-heading">Recent milestones</div>
              {recentMilestones.map((milestone) => (
                <div key={milestone.id} className="progress-feed__milestone-row">
                  <span className="progress-feed__milestone-time">
                    {new Date(milestone.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit"
                    })}
                  </span>
                  {milestone.model && (
                    <span className={`progress-feed__model progress-feed__model--${milestone.model}`}>
                      {milestone.model.toUpperCase()}
                    </span>
                  )}
                  <span className="progress-feed__milestone-text">{milestone.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="progress-feed__log" ref={logRef}>
        {visibleEvents.map((e, i) => (
          <div key={e.id ?? i} className={`progress-feed__event progress-feed__event--${e.type}`}>
            <span className="progress-feed__timestamp">{formatTime(e.receivedAt)}</span>
            {e.model && <span className={`progress-feed__model progress-feed__model--${e.model}`}>{e.model.toUpperCase()}</span>}
            {formatEventLabel(e.type) && <span className="progress-feed__event-label">{formatEventLabel(e.type)}</span>}
            <span className="progress-feed__message">{e.message}</span>
            {eventMetadataBadges(e).map((badge) => (
              <span
                key={badge}
                className={`progress-feed__meta-badge ${isWarningBadge(badge) ? "progress-feed__meta-badge--warning" : ""}`}
              >
                {badge}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
