import { checkpointSummarySchema } from "@council/core";
import { MarkdownContent } from "./markdown-content";
import type { z } from "zod";

type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

const DEGRADED_MARKER = "Limited analysis used for at least one turn";
const UNRESOLVED_DEBATE_PREFIX = "Debate stopped at max turns with ";

export function CheckpointCard({
  summary,
  phase,
  status,
  stopReason,
  clarificationCount = 0
}: {
  summary: CheckpointSummary;
  phase?: string | null;
  status?: string;
  stopReason?: string | null;
  clarificationCount?: number;
}) {
  const isDegraded = summary.openRisks.includes(DEGRADED_MARKER);
  const unresolvedDebateRisk = summary.openRisks.find((risk) => risk.startsWith(UNRESOLVED_DEBATE_PREFIX)) ?? null;
  const displayRisks = summary.openRisks.filter((risk) => risk !== DEGRADED_MARKER && risk !== unresolvedDebateRisk);
  const clarificationNeeded =
    phase === "approach_debate" &&
    (stopReason === "questions_for_human" || status === "waiting_for_human");
  const decisionsTitle = clarificationNeeded ? "Clarifications needed" : "Decisions needed";

  return (
    <article className="card card--checkpoint">
      <div className="card__header">
        <h2>Checkpoint</h2>
        <span className="card__badge">Needs review</span>
      </div>

      {isDegraded && (
        <div className="degraded-banner">
          Partial analysis - at least one model returned unstructured output. Semantic fields may be incomplete.
        </div>
      )}

      {clarificationNeeded && (
        <div className="checkpoint-warning checkpoint-warning--debate">
          <div className="checkpoint-warning__header">
            <span className="checkpoint-warning__badge">Clarification needed</span>
            <span className="checkpoint-warning__title">The approach debate is blocked on your input</span>
          </div>
          <p className="checkpoint-warning__body">
            The models paused because they still need clarification before they can converge.
            {clarificationCount > 0 ? ` Answer the ${clarificationCount} open clarification${clarificationCount === 1 ? "" : "s"} below, then continue the debate.` : " Answer the open clarification questions below, then continue the debate."}
          </p>
        </div>
      )}

      {unresolvedDebateRisk && (
        <div className="checkpoint-warning checkpoint-warning--debate">
          <div className="checkpoint-warning__header">
            <span className="checkpoint-warning__badge">Needs human judgment</span>
            <span className="checkpoint-warning__title">The debate ended without full agreement</span>
          </div>
          <p className="checkpoint-warning__body">
            {unresolvedDebateRisk}. Review the remaining disagreements below before deciding whether to continue, rewind, or restart.
          </p>
        </div>
      )}

      <MarkdownContent text={summary.currentUnderstanding} />

      {summary.decisionsNeeded.length > 0 && (
        <div className="checkpoint-section">
          <h3>{decisionsTitle}</h3>
          <ul>
            {summary.decisionsNeeded.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {displayRisks.length > 0 && (
        <div className="checkpoint-section">
          <h3>Open risks</h3>
          <ul className="risk-list">
            {displayRisks.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
    </article>
  );
}
