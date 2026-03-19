import type { SessionListItem } from "../lib/api";

const STATUS_LABELS: Record<string, string> = {
  checkpoint: "Checkpoint",
  interviewing: "Interviewing",
  debating: "Debating",
  finalized: "Finalized",
  errored: "Errored",
  waiting_for_human: "Waiting"
};

const PHASE_LABELS: Record<string, string> = {
  analysis: "Analysis",
  interview: "Interview",
  approach_debate: "Approach",
  spec_generation: "Spec"
};

export function SessionList({
  sessions,
  onSelect,
  onRestart,
  onDelete
}: {
  sessions: SessionListItem[];
  onSelect: (id: string) => void;
  onRestart: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="session-list">
      <h3 className="session-list__title">Previous sessions</h3>
      <ul className="session-list__items">
        {sessions.map((s) => (
          <li key={s.id} className="session-list__item">
            <button
              className="session-list__button"
              onClick={() => onSelect(s.id)}
            >
              <span className="session-list__name">{s.title}</span>
              <span className="session-list__meta">
                <span className={`session-list__status session-list__status--${s.status}`}>
                  {STATUS_LABELS[s.status] ?? s.status}
                </span>
                {s.phase && (
                  <span className="session-list__phase">
                    {PHASE_LABELS[s.phase] ?? s.phase}
                  </span>
                )}
              </span>
            </button>
            <div className="session-list__actions">
              <button
                className="session-list__action session-list__action--restart"
                onClick={(e) => { e.stopPropagation(); onRestart(s.id); }}
                title="Re-run from scratch with the same prompt"
              >
                Restart
              </button>
              <button
                className="session-list__action session-list__action--delete"
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                title="Delete this session"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
