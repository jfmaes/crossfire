import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

function applySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      prompt TEXT,
      execution_policy TEXT
    );

    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      current_understanding TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      changed_since_last_checkpoint TEXT NOT NULL,
      open_risks TEXT NOT NULL,
      decisions_needed TEXT NOT NULL,
      artifact_path TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS interview_questions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      priority INTEGER NOT NULL,
      rationale TEXT NOT NULL,
      context TEXT,
      recommendation TEXT,
      recommendation_reasoning TEXT,
      proposed_by TEXT NOT NULL,
      answer TEXT,
      sort_order INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS phase_results (
      session_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (session_id, phase),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS session_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS session_runs_session_id_id_unique
      ON session_runs(session_id, id);

    CREATE TABLE IF NOT EXISTS revision_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      feedback_raw TEXT NOT NULL,
      feedback_chunks_json TEXT NOT NULL,
      feedback_digest_json TEXT,
      budget_ledger_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (run_id) REFERENCES session_runs(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS revision_requests_run_id_unique
      ON revision_requests(run_id);

    CREATE TABLE IF NOT EXISTS session_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      model TEXT,
      phase TEXT,
      turn_number INTEGER,
      elapsed_ms INTEGER,
      disagreements INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES session_runs(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_child_sessions (
      workflow_run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      lens TEXT NOT NULL,
      state TEXT NOT NULL,
      latest_run_id TEXT,
      escalation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_run_id, session_id),
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (session_id, latest_run_id) REFERENCES session_runs(session_id, id)
    );

    CREATE TABLE IF NOT EXISTS workflow_escalations (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (workflow_run_id, session_id) REFERENCES workflow_child_sessions(workflow_run_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS workflow_escalations_workflow_run_id_idx
      ON workflow_escalations(workflow_run_id);
  `);

  migrateIfNeeded(db);
}

function migrateIfNeeded(db: Database.Database) {
  // Add phase and prompt columns to existing sessions tables
  const columns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
  const columnNames = columns.map((c) => c.name);

  if (!columnNames.includes("phase")) {
    db.exec("ALTER TABLE sessions ADD COLUMN phase TEXT");
  }
  if (!columnNames.includes("prompt")) {
    db.exec("ALTER TABLE sessions ADD COLUMN prompt TEXT");
  }
  if (!columnNames.includes("execution_policy")) {
    db.exec("ALTER TABLE sessions ADD COLUMN execution_policy TEXT");
  }

  const interviewQuestionColumns = db.pragma("table_info(interview_questions)") as Array<{ name: string }>;
  const interviewQuestionColumnNames = interviewQuestionColumns.map((c) => c.name);
  if (!interviewQuestionColumnNames.includes("context")) {
    db.exec("ALTER TABLE interview_questions ADD COLUMN context TEXT");
  }
  if (!interviewQuestionColumnNames.includes("recommendation")) {
    db.exec("ALTER TABLE interview_questions ADD COLUMN recommendation TEXT");
  }
  if (!interviewQuestionColumnNames.includes("recommendation_reasoning")) {
    db.exec("ALTER TABLE interview_questions ADD COLUMN recommendation_reasoning TEXT");
  }

  const runEventColumns = db.pragma("table_info(session_run_events)") as Array<{ name: string }>;
  const runEventColumnNames = runEventColumns.map((c) => c.name);
  if (!runEventColumnNames.includes("metadata_json")) {
    db.exec("ALTER TABLE session_run_events ADD COLUMN metadata_json TEXT");
  }

  const workflowRunColumns = db.pragma("table_info(workflow_runs)") as Array<{ name: string }>;
  const workflowRunColumnNames = workflowRunColumns.map((c) => c.name);
  if (workflowRunColumns.length > 0 && !workflowRunColumnNames.includes("settled_at")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN settled_at TEXT");
  }

  const workflowEscalationColumns = db.pragma("table_info(workflow_escalations)") as Array<{ name: string }>;
  const workflowEscalationColumnNames = workflowEscalationColumns.map((c) => c.name);
  if (workflowEscalationColumns.length > 0 && !workflowEscalationColumnNames.includes("resolution_json")) {
    db.exec("ALTER TABLE workflow_escalations ADD COLUMN resolution_json TEXT");
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS session_runs_session_id_id_unique
      ON session_runs(session_id, id);
  `);

  migrateWorkflowTablesIfNeeded(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS workflow_escalations_workflow_run_id_idx
      ON workflow_escalations(workflow_run_id);
  `);
}

function migrateWorkflowTablesIfNeeded(db: Database.Database) {
  if (
    hasTable(db, "workflow_child_sessions") &&
    !hasCompositeForeignKey(db, "workflow_child_sessions", "session_runs", [
      ["session_id", "session_id"],
      ["latest_run_id", "id"]
    ])
  ) {
    rebuildWorkflowChildSessionsTable(db);
  }

  if (
    hasTable(db, "workflow_escalations") &&
    !hasCompositeForeignKey(db, "workflow_escalations", "workflow_child_sessions", [
      ["workflow_run_id", "workflow_run_id"],
      ["session_id", "session_id"]
    ])
  ) {
    rebuildWorkflowEscalationsTable(db);
  }
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;

  return row !== undefined;
}

function hasCompositeForeignKey(
  db: Database.Database,
  tableName: string,
  referencedTable: string,
  pairs: Array<[from: string, to: string]>
): boolean {
  const foreignKeys = db.pragma(`foreign_key_list(${tableName})`) as Array<{
    id: number;
    table: string;
    from: string;
    to: string;
  }>;
  const groups = new Map<number, typeof foreignKeys>();

  for (const foreignKey of foreignKeys) {
    const group = groups.get(foreignKey.id);
    if (group) {
      group.push(foreignKey);
    } else {
      groups.set(foreignKey.id, [foreignKey]);
    }
  }

  for (const group of groups.values()) {
    if (group[0]?.table !== referencedTable || group.length !== pairs.length) {
      continue;
    }

    const matchesAllPairs = pairs.every(([from, to]) =>
      group.some((foreignKey) => foreignKey.from === from && foreignKey.to === to)
    );
    if (matchesAllPairs) {
      return true;
    }
  }

  return false;
}

function rebuildWorkflowChildSessionsTable(db: Database.Database) {
  const rebuild = db.transaction(() => {
    db.exec("ALTER TABLE workflow_child_sessions RENAME TO workflow_child_sessions_old");
    db.exec(`
      CREATE TABLE workflow_child_sessions (
        workflow_run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL,
        lens TEXT NOT NULL,
        state TEXT NOT NULL,
        latest_run_id TEXT,
        escalation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workflow_run_id, session_id),
        FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (session_id, latest_run_id) REFERENCES session_runs(session_id, id)
      )
    `);
    db.exec(`
      INSERT INTO workflow_child_sessions (
        workflow_run_id, session_id, label, lens, state, latest_run_id, escalation_id, created_at, updated_at
      )
      SELECT
        old.workflow_run_id,
        old.session_id,
        old.label,
        old.lens,
        old.state,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM session_runs
            WHERE session_runs.session_id = old.session_id
              AND session_runs.id = old.latest_run_id
          )
          THEN old.latest_run_id
          ELSE NULL
        END,
        old.escalation_id,
        old.created_at,
        old.updated_at
      FROM workflow_child_sessions_old
      AS old
    `);
    db.exec("DROP TABLE workflow_child_sessions_old");
  });

  rebuild();
}

function rebuildWorkflowEscalationsTable(db: Database.Database) {
  const rebuild = db.transaction(() => {
    db.exec("ALTER TABLE workflow_escalations RENAME TO workflow_escalations_old");
    db.exec(`
      CREATE TABLE workflow_escalations (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        brief_json TEXT NOT NULL,
        resolution_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (workflow_run_id, session_id) REFERENCES workflow_child_sessions(workflow_run_id, session_id)
      )
    `);
    db.exec(`
      INSERT INTO workflow_escalations (
        id, workflow_run_id, session_id, kind, status, brief_json, resolution_json, created_at, updated_at
      )
      SELECT
        old.id,
        old.workflow_run_id,
        old.session_id,
        old.kind,
        old.status,
        old.brief_json,
        old.resolution_json,
        old.created_at,
        old.updated_at
      FROM workflow_escalations_old AS old
      WHERE EXISTS (
        SELECT 1
        FROM workflow_child_sessions
        WHERE workflow_child_sessions.workflow_run_id = old.workflow_run_id
          AND workflow_child_sessions.session_id = old.session_id
      )
    `);
    db.exec("DROP TABLE workflow_escalations_old");
  });

  rebuild();
}

export function createInMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

export function createDatabase(filePath: string): Database.Database {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}
