import type Database from "better-sqlite3";

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  phase?: string | null;
  prompt?: string | null;
}

export interface InterviewQuestionRow {
  id: string;
  sessionId: string;
  text: string;
  priority: number;
  rationale: string;
  proposedBy: string;
  answer: string | null;
  sortOrder: number;
}

export interface PhaseResultRow {
  sessionId: string;
  phase: string;
  resultJson: string;
}

interface SessionSummaryRow {
  sessionId: string;
  currentUnderstanding: string;
  recommendation: string;
  changedSinceLastCheckpoint: string[];
  openRisks: string[];
  decisionsNeeded: string[];
  artifactPath?: string | null;
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(session: SessionRow): void {
    this.db
      .prepare("INSERT INTO sessions (id, title, status, phase, prompt) VALUES (@id, @title, @status, @phase, @prompt)")
      .run({
        id: session.id,
        title: session.title,
        status: session.status,
        phase: session.phase ?? null,
        prompt: session.prompt ?? null
      });
  }

  updateStatus(input: { id: string; status: string }): void {
    this.db
      .prepare("UPDATE sessions SET status = @status WHERE id = @id")
      .run(input);
  }

  updatePhase(input: { id: string; phase: string }): void {
    this.db
      .prepare("UPDATE sessions SET phase = @phase WHERE id = @id")
      .run(input);
  }

  findById(id: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT id, title, status, phase, prompt FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
  }

  findAll(): SessionRow[] {
    return this.db
      .prepare("SELECT id, title, status, phase FROM sessions ORDER BY rowid DESC")
      .all() as SessionRow[];
  }

  saveSummary(summary: SessionSummaryRow): void {
    this.db
      .prepare(`
        INSERT INTO session_summaries (
          session_id,
          current_understanding,
          recommendation,
          changed_since_last_checkpoint,
          open_risks,
          decisions_needed,
          artifact_path
        ) VALUES (
          @sessionId,
          @currentUnderstanding,
          @recommendation,
          @changedSinceLastCheckpoint,
          @openRisks,
          @decisionsNeeded,
          @artifactPath
        )
        ON CONFLICT(session_id) DO UPDATE SET
          current_understanding = excluded.current_understanding,
          recommendation = excluded.recommendation,
          changed_since_last_checkpoint = excluded.changed_since_last_checkpoint,
          open_risks = excluded.open_risks,
          decisions_needed = excluded.decisions_needed,
          artifact_path = excluded.artifact_path
      `)
      .run({
        sessionId: summary.sessionId,
        currentUnderstanding: summary.currentUnderstanding,
        recommendation: summary.recommendation,
        changedSinceLastCheckpoint: JSON.stringify(summary.changedSinceLastCheckpoint),
        openRisks: JSON.stringify(summary.openRisks),
        decisionsNeeded: JSON.stringify(summary.decisionsNeeded),
        artifactPath: summary.artifactPath ?? null
      });
  }

  findSummaryBySessionId(sessionId: string): SessionSummaryRow | undefined {
    const row = this.db
      .prepare(`
        SELECT
          session_id as sessionId,
          current_understanding as currentUnderstanding,
          recommendation,
          changed_since_last_checkpoint as changedSinceLastCheckpoint,
          open_risks as openRisks,
          decisions_needed as decisionsNeeded,
          artifact_path as artifactPath
        FROM session_summaries
        WHERE session_id = ?
      `)
      .get(sessionId) as
      | (Omit<SessionSummaryRow, "changedSinceLastCheckpoint" | "openRisks" | "decisionsNeeded"> & {
          changedSinceLastCheckpoint: string;
          openRisks: string;
          decisionsNeeded: string;
        })
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      ...row,
      changedSinceLastCheckpoint: JSON.parse(row.changedSinceLastCheckpoint),
      openRisks: JSON.parse(row.openRisks),
      decisionsNeeded: JSON.parse(row.decisionsNeeded)
    };
  }

  saveInterviewQuestions(questions: InterviewQuestionRow[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO interview_questions (id, session_id, text, priority, rationale, proposed_by, answer, sort_order)
      VALUES (@id, @sessionId, @text, @priority, @rationale, @proposedBy, @answer, @sortOrder)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        priority = excluded.priority,
        rationale = excluded.rationale,
        proposed_by = excluded.proposed_by,
        answer = excluded.answer,
        sort_order = excluded.sort_order
    `);

    const runAll = this.db.transaction((rows: InterviewQuestionRow[]) => {
      for (const q of rows) {
        stmt.run({
          id: q.id,
          sessionId: q.sessionId,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          proposedBy: q.proposedBy,
          answer: q.answer,
          sortOrder: q.sortOrder
        });
      }
    });

    runAll(questions);
  }

  findInterviewQuestions(sessionId: string): InterviewQuestionRow[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          session_id as sessionId,
          text,
          priority,
          rationale,
          proposed_by as proposedBy,
          answer,
          sort_order as sortOrder
        FROM interview_questions
        WHERE session_id = ?
        ORDER BY sort_order ASC
      `)
      .all(sessionId) as InterviewQuestionRow[];

    return rows;
  }

  deleteInterviewQuestions(sessionId: string): void {
    this.db
      .prepare("DELETE FROM interview_questions WHERE session_id = ?")
      .run(sessionId);
  }

  deletePhaseResults(sessionId: string): void {
    this.db
      .prepare("DELETE FROM phase_results WHERE session_id = ?")
      .run(sessionId);
  }

  recoverStaleDebatingSessions(): number {
    const result = this.db
      .prepare("UPDATE sessions SET status = 'errored' WHERE status = 'debating'")
      .run();
    return result.changes;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM interview_questions WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM phase_results WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  updateInterviewAnswer(input: { id: string; answer: string }): void {
    this.db
      .prepare("UPDATE interview_questions SET answer = @answer WHERE id = @id")
      .run(input);
  }

  savePhaseResult(input: PhaseResultRow): void {
    this.db
      .prepare(`
        INSERT INTO phase_results (session_id, phase, result_json)
        VALUES (@sessionId, @phase, @resultJson)
        ON CONFLICT(session_id, phase) DO UPDATE SET
          result_json = excluded.result_json
      `)
      .run({
        sessionId: input.sessionId,
        phase: input.phase,
        resultJson: input.resultJson
      });
  }

  findPhaseResult(sessionId: string, phase: string): PhaseResultRow | undefined {
    return this.db
      .prepare(`
        SELECT
          session_id as sessionId,
          phase,
          result_json as resultJson
        FROM phase_results
        WHERE session_id = ? AND phase = ?
      `)
      .get(sessionId, phase) as PhaseResultRow | undefined;
  }

  findAllPhaseResults(sessionId: string): PhaseResultRow[] {
    return this.db
      .prepare(`
        SELECT
          session_id as sessionId,
          phase,
          result_json as resultJson
        FROM phase_results
        WHERE session_id = ?
      `)
      .all(sessionId) as PhaseResultRow[];
  }
}
