import type Database from "better-sqlite3";

export interface WorkflowRunRow {
  id: string;
  specId: string;
  status: string;
  input: Record<string, unknown>;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  settledAt?: string | null;
}

export interface WorkflowChildSessionRow {
  workflowRunId: string;
  sessionId: string;
  label: string;
  lens: string;
  state: string;
  latestRunId?: string | null;
  escalationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEscalationRow {
  id: string;
  workflowRunId: string;
  sessionId: string;
  kind: string;
  status: string;
  brief: Record<string, unknown>;
  resolution?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

type WorkflowRunRecord = Omit<WorkflowRunRow, "input" | "summary"> & {
  inputJson: string;
  summaryJson: string;
};

type WorkflowEscalationRecord = Omit<WorkflowEscalationRow, "brief" | "resolution"> & {
  briefJson: string;
  resolutionJson?: string | null;
};

export class WorkflowRunRepository {
  constructor(private readonly db: Database.Database) {}

  createWorkflowRun(row: WorkflowRunRow): void {
    this.db
      .prepare(`
        INSERT INTO workflow_runs (id, spec_id, status, input_json, summary_json, created_at, updated_at, settled_at)
        VALUES (@id, @specId, @status, @inputJson, @summaryJson, @createdAt, @updatedAt, @settledAt)
      `)
      .run({
        ...row,
        inputJson: JSON.stringify(row.input),
        summaryJson: JSON.stringify(row.summary),
        settledAt: row.settledAt ?? null
      });
  }

  updateWorkflowRun(input: {
    id: string;
    status: string;
    summary: Record<string, unknown>;
    updatedAt: string;
    settledAt?: string | null;
  }): void {
    this.db
      .prepare(`
        UPDATE workflow_runs
        SET
          status = @status,
          summary_json = @summaryJson,
          updated_at = @updatedAt,
          settled_at = CASE WHEN @hasSettledAt THEN @settledAt ELSE settled_at END
        WHERE id = @id
      `)
      .run({
        id: input.id,
        status: input.status,
        summaryJson: JSON.stringify(input.summary),
        updatedAt: input.updatedAt,
        hasSettledAt: input.settledAt !== undefined ? 1 : 0,
        settledAt: input.settledAt ?? null
      });
  }

  upsertChildSession(row: WorkflowChildSessionRow): void {
    this.db
      .prepare(`
        INSERT INTO workflow_child_sessions (
          workflow_run_id, session_id, label, lens, state, latest_run_id, escalation_id, created_at, updated_at
        ) VALUES (
          @workflowRunId, @sessionId, @label, @lens, @state, @latestRunId, @escalationId, @createdAt, @updatedAt
        )
        ON CONFLICT(workflow_run_id, session_id) DO UPDATE SET
          label = excluded.label,
          lens = excluded.lens,
          state = excluded.state,
          latest_run_id = excluded.latest_run_id,
          escalation_id = excluded.escalation_id,
          updated_at = excluded.updated_at
      `)
      .run({
        ...row,
        latestRunId: row.latestRunId ?? null,
        escalationId: row.escalationId ?? null
      });
  }

  createEscalation(row: WorkflowEscalationRow): void {
    this.db
      .prepare(`
        INSERT INTO workflow_escalations (
          id, workflow_run_id, session_id, kind, status, brief_json, resolution_json, created_at, updated_at
        ) VALUES (
          @id, @workflowRunId, @sessionId, @kind, @status, @briefJson, @resolutionJson, @createdAt, @updatedAt
        )
      `)
      .run({
        ...row,
        briefJson: JSON.stringify(row.brief),
        resolutionJson: row.resolution ? JSON.stringify(row.resolution) : null
      });
  }

  findWorkflowRunById(id: string): WorkflowRunRow | undefined {
    const row = this.db
      .prepare(`
        SELECT
          id,
          spec_id as specId,
          status,
          input_json as inputJson,
          summary_json as summaryJson,
          created_at as createdAt,
          updated_at as updatedAt,
          settled_at as settledAt
        FROM workflow_runs
        WHERE id = ?
      `)
      .get(id) as WorkflowRunRecord | undefined;

    if (!row) {
      return undefined;
    }

    const { inputJson, summaryJson, ...workflowRun } = row;
    return {
      ...workflowRun,
      input: JSON.parse(inputJson) as Record<string, unknown>,
      summary: JSON.parse(summaryJson) as Record<string, unknown>,
      settledAt: workflowRun.settledAt ?? null
    };
  }

  findChildSessions(workflowRunId: string): WorkflowChildSessionRow[] {
    return this.db
      .prepare(`
        SELECT
          workflow_run_id as workflowRunId,
          session_id as sessionId,
          label,
          lens,
          state,
          latest_run_id as latestRunId,
          escalation_id as escalationId,
          created_at as createdAt,
          updated_at as updatedAt
        FROM workflow_child_sessions
        WHERE workflow_run_id = ?
        ORDER BY created_at ASC
      `)
      .all(workflowRunId) as WorkflowChildSessionRow[];
  }

  findEscalations(workflowRunId: string): WorkflowEscalationRow[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          workflow_run_id as workflowRunId,
          session_id as sessionId,
          kind,
          status,
          brief_json as briefJson,
          resolution_json as resolutionJson,
          created_at as createdAt,
          updated_at as updatedAt
        FROM workflow_escalations
        WHERE workflow_run_id = ?
        ORDER BY created_at ASC
      `)
      .all(workflowRunId) as WorkflowEscalationRecord[];

    return rows.map(({ briefJson, resolutionJson, ...escalation }) => ({
      ...escalation,
      brief: JSON.parse(briefJson) as Record<string, unknown>,
      resolution: resolutionJson ? (JSON.parse(resolutionJson) as Record<string, unknown>) : null
    }));
  }
}
