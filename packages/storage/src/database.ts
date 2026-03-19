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
      prompt TEXT
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
}

export function createInMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

export function createDatabase(filePath: string): Database.Database {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  applySchema(db);
  return db;
}
