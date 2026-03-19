import type { RuntimeStatus } from "../lib/api";

export function RuntimeStatusCard(input: { status: RuntimeStatus | null }) {
  const gptOk = input.status?.providers.gpt.ok ?? false;
  const claudeOk = input.status?.providers.claude.ok ?? false;

  return (
    <article className="card">
      <div className="card__header">
        <h2>Runtime status</h2>
      </div>
      <div className="status-grid">
        <div className="status-row">
          <span className="status-label">Provider mode</span>
          <span className="status-badge">{input.status?.providerMode ?? "unavailable"}</span>
        </div>
        <div className="status-row">
          <span className="status-label">
            <span className={`status-dot ${gptOk ? "status-dot--ok" : "status-dot--err"}`} />
            GPT
          </span>
          <span className="status-detail">{input.status?.providers.gpt.detail ?? "not connected"}</span>
        </div>
        <div className="status-row">
          <span className="status-label">
            <span className={`status-dot ${claudeOk ? "status-dot--ok" : "status-dot--err"}`} />
            Claude
          </span>
          <span className="status-detail">{input.status?.providers.claude.detail ?? "not connected"}</span>
        </div>
      </div>
    </article>
  );
}
