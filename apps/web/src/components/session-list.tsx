import { useState } from "react";
import type { SessionListItem } from "../lib/api";

const STATUS_LABELS: Record<string, string> = {
  checkpoint: "Checkpoint",
  interviewing: "Interviewing",
  debating: "Debating",
  finalized: "Finalized",
  errored: "Errored",
  waiting_for_human: "Waiting"
};

const STATUS_ICONS: Record<string, string> = {
  checkpoint: "||",
  interviewing: "?",
  debating: "~",
  finalized: "\u2713",
  errored: "!",
  waiting_for_human: "\u2026"
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
  onDelete,
  restartingSessionId,
  deletingSessionId
}: {
  sessions: SessionListItem[];
  onSelect: (id: string) => void;
  onRestart: (id: string) => void;
  onDelete: (id: string) => void;
  restartingSessionId?: string | null;
  deletingSessionId?: string | null;
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function handleDeleteClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      onDelete(id);
    } else {
      setConfirmDeleteId(id);
    }
  }

  if (sessions.length === 0) {
    return (
      <div className="session-list">
        <h3 className="session-list__title">Previous sessions</h3>
        <div className="session-list__empty">
          No sessions yet. Describe a problem above to start your first session.
        </div>
      </div>
    );
  }

  return (
    <div className="session-list">
      <h3 className="session-list__title">Previous sessions ({sessions.length})</h3>
      <ul className="session-list__items">
        {sessions.map((s) => (
          <li key={s.id} className="session-list__item">
            <button
              className="session-list__button"
              onClick={() => onSelect(s.id)}
              disabled={restartingSessionId === s.id || deletingSessionId === s.id}
            >
              <span className={`session-list__icon session-list__status--${s.status}`}>
                {STATUS_ICONS[s.status] ?? "\u2022"}
              </span>
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
                disabled={restartingSessionId === s.id || deletingSessionId === s.id}
              >
                {restartingSessionId === s.id ? "Restarting\u2026" : "Restart"}
              </button>
              <button
                className={`session-list__action session-list__action--delete ${confirmDeleteId === s.id ? "session-list__action--confirm" : ""}`}
                onClick={(e) => handleDeleteClick(e, s.id)}
                onBlur={() => setConfirmDeleteId(null)}
                title={confirmDeleteId === s.id ? "Click again to confirm deletion" : "Delete this session"}
                disabled={restartingSessionId === s.id || deletingSessionId === s.id}
              >
                {deletingSessionId === s.id
                  ? "Deleting\u2026"
                  : confirmDeleteId === s.id
                    ? "Confirm?"
                    : "Delete"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
