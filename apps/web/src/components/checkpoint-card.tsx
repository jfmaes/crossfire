import { checkpointSummarySchema } from "@council/core";
import type { z } from "zod";

type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

const DEGRADED_MARKER = "Limited analysis used for at least one turn";

export function CheckpointCard({ summary }: { summary: CheckpointSummary }) {
  const isDegraded = summary.openRisks.includes(DEGRADED_MARKER);
  const displayRisks = summary.openRisks.filter((r) => r !== DEGRADED_MARKER);

  return (
    <article className="card card--checkpoint">
      <div className="card__header">
        <h2>Checkpoint</h2>
        <span className="card__badge">Needs review</span>
      </div>

      {isDegraded && (
        <div className="degraded-banner">
          Partial analysis — at least one model returned unstructured output. Semantic fields may be incomplete.
        </div>
      )}

      <p>{summary.currentUnderstanding}</p>

      <div className="checkpoint-section">
        <h3>Decisions needed</h3>
        <ul>
          {summary.decisionsNeeded.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="checkpoint-section">
        <h3>Open risks</h3>
        <ul className="risk-list">
          {displayRisks.length > 0
            ? displayRisks.map((item) => <li key={item}>{item}</li>)
            : <li>No explicit disagreements yet</li>}
        </ul>
      </div>
    </article>
  );
}
