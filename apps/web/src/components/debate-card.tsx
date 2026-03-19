import { MarkdownContent } from "./markdown-content";

interface DebateCardProps {
  title: string;
  badge: string;
  summary: string;
  turns?: Array<{ actor: string; summary: string }>;
  convergedApproach?: string;
}

export function DebateCard({ title, badge, summary, turns, convergedApproach }: DebateCardProps) {
  return (
    <article className="card card--debate">
      <div className="card__header">
        <h2>{title}</h2>
        <span className="card__badge">{badge}</span>
      </div>

      <div className="debate-summary">
        <MarkdownContent text={summary} />
      </div>

      {turns && turns.length > 0 && (
        <div className="checkpoint-section">
          <h3>Debate turns</h3>
          <div className="debate-turns">
            {turns.map((turn, i) => (
              <div key={i} className={`debate-turn debate-turn--${turn.actor}`}>
                <span className="debate-turn__actor">{turn.actor === "gpt" ? "Dr. Chen (GPT)" : "Dr. Rivera (Claude)"}</span>
                <MarkdownContent text={turn.summary} />
              </div>
            ))}
          </div>
        </div>
      )}

      {convergedApproach && (
        <details className="debate-converged">
          <summary>Converged approach (full text)</summary>
          <MarkdownContent text={convergedApproach} className="debate-converged-text" />
        </details>
      )}
    </article>
  );
}
