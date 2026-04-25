import type { SpecGenerationTrace } from "../lib/api";
import { MarkdownContent } from "./markdown-content";

interface SpecResult {
  spec: string;
  implementationPlan?: string;
  summary: string;
  trace?: SpecGenerationTrace;
}

function artifactUrl(sessionId: string, type: string): string {
  const token = localStorage.getItem("council-token") ?? "local-dev-token";
  return `/artifacts/${sessionId}/${type}?token=${encodeURIComponent(token)}`;
}

function formatStopReason(reason?: string | null): string | null {
  switch (reason) {
    case "spec_generation_input_too_large":
      return "Spec input too large";
    case "revision_input_too_large":
      return "Revision input too large";
    case "consensus":
      return "Consensus reached";
    case "questions_for_human":
      return "Clarification needed";
    case "max_turns":
      return "Turn cap reached";
    default:
      return reason ? reason.replaceAll("_", " ") : null;
  }
}

export function SpecCard({
  result,
  isFinalized,
  sessionId
}: {
  result: SpecResult;
  isFinalized: boolean;
  sessionId?: string;
}) {
  const trace = result.trace;
  const authorityCompaction = [
    trace?.compaction?.approachResult ? "approach handoff" : null,
    trace?.compaction?.peerDraft ? "review draft" : null,
    trace?.compaction?.revisionPeerDraft ? "revision input" : null
  ].filter((item): item is string => item !== null);
  const blockedReason = trace?.blockedReason ?? trace?.stopReason;
  const blockedByOversize =
    trace?.blockedByOversize === true ||
    trace?.oversizeBlocking === true ||
    blockedReason === "spec_generation_input_too_large" ||
    blockedReason === "revision_input_too_large";
  const canonicalHandoff =
    trace?.canonicalApproachHandoff ??
    trace?.usedCanonicalApproachHandoff ??
    trace?.canonicalHandoffUsed;
  const stageFreshness = [
    trace?.draft?.conversationReused,
    trace?.review?.conversationReused,
    trace?.revision?.conversationReused
  ].filter((value): value is boolean => typeof value === "boolean");
  const structuredFreshContext =
    trace?.freshContext && typeof trace.freshContext === "object"
      ? trace.freshContext
      : null;
  const freshContext =
    (structuredFreshContext
      ? structuredFreshContext.draft === true &&
        structuredFreshContext.review === true &&
        structuredFreshContext.walkthrough === true
      : trace?.freshContext) ??
    trace?.startedFromFreshContext ??
    (stageFreshness.length > 0 ? stageFreshness.every((reused) => reused === false) : undefined);
  const reusedContext =
    stageFreshness.length > 0 && stageFreshness.some((reused) => reused === true);
  const authorityPathUncompacted =
    trace?.authorityPathUncompacted ??
    trace?.authorityPathUncompressed ??
    (trace?.authorityPathCompacted === true ? false : authorityCompaction.length === 0);

  return (
    <article className="card card--spec">
      <div className="card__header">
        <h2>Specification &amp; Implementation Plan</h2>
        <span className={`card__badge ${isFinalized ? "card__badge--success" : ""}`}>
          {isFinalized ? "Finalized" : "Needs review"}
        </span>
      </div>

      <p className="spec-summary">{result.summary}</p>

      {trace && (
        <div className="trace-summary">
          <div className="trace-pill-row">
            {typeof trace.gapCount === "number" && (
              <span className="trace-pill">Walkthrough gaps: {trace.gapCount}</span>
            )}
            {typeof trace.revisedAfterWalkthrough === "boolean" && (
              <span className="trace-pill">
                Revision after walkthrough: {trace.revisedAfterWalkthrough ? "yes" : "no"}
              </span>
            )}
            {typeof freshContext === "boolean" && (
              <span className={`trace-pill ${!freshContext || reusedContext ? "trace-pill--warning" : ""}`}>
                {freshContext && !reusedContext ? "Fresh context throughout spec path" : "Context reuse detected"}
              </span>
            )}
            {canonicalHandoff === true && (
              <span className="trace-pill">Canonical approach handoff</span>
            )}
            {authorityPathUncompacted && !blockedByOversize && (
              <span className="trace-pill">Authority path: uncompressed</span>
            )}
            {blockedByOversize && formatStopReason(blockedReason) && (
              <span className="trace-pill trace-pill--warning">Blocked: {formatStopReason(blockedReason)}</span>
            )}
            {authorityCompaction.length > 0 && (
              <span className="trace-pill trace-pill--warning">
                Authority input compacted: {authorityCompaction.join(", ")}
              </span>
            )}
          </div>
        </div>
      )}

      {(blockedByOversize || authorityCompaction.length > 0 || reusedContext) && (
        <div className="checkpoint-warning checkpoint-warning--debate">
          <div className="checkpoint-warning__header">
            <span className="checkpoint-warning__badge">Trace warning</span>
            <span className="checkpoint-warning__title">The spec path did not stay in the ideal handoff state</span>
          </div>
          <p className="checkpoint-warning__body">
            {blockedByOversize
              ? "Crossfire blocked instead of compacting an oversized authority-path input. Tighten the upstream handoff or revision input before rerunning."
              : authorityCompaction.length > 0
                ? `Authority-path compaction was used for ${authorityCompaction.join(", ")}. Treat this as a lossy fallback, not normal healthy operation.`
                : "One or more spec-generation steps reused context. Fresh context is the intended contract for this phase."}
          </p>
        </div>
      )}

      {isFinalized && sessionId && (
        <div className="spec-downloads">
          <a
            className="spec-download-btn"
            href={artifactUrl(sessionId, "spec")}
            download={`${sessionId}-spec.md`}
          >
            Download Spec (.md)
          </a>
          {result.implementationPlan && (
            <a
              className="spec-download-btn"
              href={artifactUrl(sessionId, "plan")}
              download={`${sessionId}-plan.md`}
            >
              Download Implementation Plan (.md)
            </a>
          )}
        </div>
      )}

      <details className="spec-section" open>
        <summary className="spec-section__title">Specification</summary>
        <div className="spec-content">
          <MarkdownContent text={result.spec} className="spec-document" />
        </div>
      </details>

      {result.implementationPlan && (
        <details className="spec-section" open>
          <summary className="spec-section__title">Implementation Plan</summary>
          <div className="spec-content">
            <MarkdownContent text={result.implementationPlan} className="spec-document" />
          </div>
        </details>
      )}
    </article>
  );
}
