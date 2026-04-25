import type Database from "better-sqlite3";

export interface ExecutionPolicy {
  approachDebateMaxTurns?: number;
}

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  phase?: string | null;
  prompt?: string | null;
  executionPolicy?: ExecutionPolicy | null;
}

export interface InterviewQuestionRow {
  id: string;
  sessionId: string;
  text: string;
  priority: number;
  rationale: string;
  context?: string | null;
  recommendation?: string | null;
  recommendationReasoning?: string | null;
  proposedBy: string;
  answer: string | null;
  sortOrder: number;
}

export interface PhaseResultRow {
  sessionId: string;
  phase: string;
  resultJson: string;
}

export interface SessionRunRow {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  phase?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  errorMessage?: string | null;
}

export interface SessionRunEventRow {
  id: string;
  runId: string;
  sessionId: string;
  type: string;
  message: string;
  model?: string | null;
  phase?: string | null;
  turnNumber?: number | null;
  elapsedMs?: number | null;
  disagreements?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
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
      .prepare("INSERT INTO sessions (id, title, status, phase, prompt, execution_policy) VALUES (@id, @title, @status, @phase, @prompt, @executionPolicy)")
      .run({
        id: session.id,
        title: session.title,
        status: session.status,
        phase: session.phase ?? null,
        prompt: session.prompt ?? null,
        executionPolicy: session.executionPolicy ? JSON.stringify(session.executionPolicy) : null
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
    const row = this.db
      .prepare("SELECT id, title, status, phase, prompt, execution_policy as executionPolicyJson FROM sessions WHERE id = ?")
      .get(id) as (Omit<SessionRow, "executionPolicy"> & { executionPolicyJson?: string | null }) | undefined;

    if (!row) return undefined;

    const { executionPolicyJson, ...session } = row;
    return {
      ...session,
      executionPolicy: executionPolicyJson ? JSON.parse(executionPolicyJson) : null
    };
  }

  findAll(): SessionRow[] {
    const rows = this.db
      .prepare("SELECT id, title, status, phase, execution_policy as executionPolicyJson FROM sessions ORDER BY rowid DESC")
      .all() as Array<Omit<SessionRow, "executionPolicy"> & { executionPolicyJson?: string | null }>;

    return rows.map((row) => {
      const { executionPolicyJson, ...session } = row;
      return {
        ...session,
        executionPolicy: executionPolicyJson ? JSON.parse(executionPolicyJson) : null
      };
    });
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
      INSERT INTO interview_questions (
        id,
        session_id,
        text,
        priority,
        rationale,
        context,
        recommendation,
        recommendation_reasoning,
        proposed_by,
        answer,
        sort_order
      )
      VALUES (
        @id,
        @sessionId,
        @text,
        @priority,
        @rationale,
        @context,
        @recommendation,
        @recommendationReasoning,
        @proposedBy,
        @answer,
        @sortOrder
      )
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        priority = excluded.priority,
        rationale = excluded.rationale,
        context = excluded.context,
        recommendation = excluded.recommendation,
        recommendation_reasoning = excluded.recommendation_reasoning,
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
          context: q.context ?? null,
          recommendation: q.recommendation ?? null,
          recommendationReasoning: q.recommendationReasoning ?? null,
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
          context,
          recommendation,
          recommendation_reasoning as recommendationReasoning,
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

  deletePhaseResult(sessionId: string, phase: string): void {
    this.db
      .prepare("DELETE FROM phase_results WHERE session_id = ? AND phase = ?")
      .run(sessionId, phase);
  }

  recoverStaleDebatingSessions(): number {
    const recover = this.db.transaction(() => {
      const finishedAt = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE session_runs
          SET
            status = 'failed',
            finished_at = @finishedAt,
            error_message = 'daemon stopped before this run completed'
          WHERE finished_at IS NULL
            AND session_id IN (
              SELECT id FROM sessions WHERE status = 'debating'
            )
        `)
        .run({ finishedAt });

      const result = this.db
        .prepare("UPDATE sessions SET status = 'errored' WHERE status = 'debating'")
        .run();

      return result.changes;
    });

    return recover();
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM interview_questions WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM phase_results WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM session_run_events WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM session_runs WHERE session_id = ?").run(id);
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

  createRun(run: SessionRunRow): void {
    this.db
      .prepare(`
        INSERT INTO session_runs (id, session_id, kind, status, phase, started_at, finished_at, error_message)
        VALUES (@id, @sessionId, @kind, @status, @phase, @startedAt, @finishedAt, @errorMessage)
      `)
      .run({
        id: run.id,
        sessionId: run.sessionId,
        kind: run.kind,
        status: run.status,
        phase: run.phase ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        errorMessage: run.errorMessage ?? null
      });
  }

  updateRun(input: { id: string; status: string; phase?: string | null; finishedAt?: string | null; errorMessage?: string | null }): void {
    this.db
      .prepare(`
        UPDATE session_runs
        SET
          status = @status,
          phase = @phase,
          finished_at = @finishedAt,
          error_message = @errorMessage
        WHERE id = @id
      `)
      .run({
        id: input.id,
        status: input.status,
        phase: input.phase ?? null,
        finishedAt: input.finishedAt ?? null,
        errorMessage: input.errorMessage ?? null
      });
  }

  findActiveRun(sessionId: string): SessionRunRow | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          session_id as sessionId,
          kind,
          status,
          phase,
          started_at as startedAt,
          finished_at as finishedAt,
          error_message as errorMessage
        FROM session_runs
        WHERE session_id = ? AND finished_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get(sessionId) as SessionRunRow | undefined;
  }

  findLatestRun(sessionId: string): SessionRunRow | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          session_id as sessionId,
          kind,
          status,
          phase,
          started_at as startedAt,
          finished_at as finishedAt,
          error_message as errorMessage
        FROM session_runs
        WHERE session_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `)
      .get(sessionId) as SessionRunRow | undefined;
  }

  findRunById(id: string): SessionRunRow | undefined {
    return this.db
      .prepare(`
        SELECT
          id,
          session_id as sessionId,
          kind,
          status,
          phase,
          started_at as startedAt,
          finished_at as finishedAt,
          error_message as errorMessage
        FROM session_runs
        WHERE id = ?
      `)
      .get(id) as SessionRunRow | undefined;
  }

  findRunsBySession(sessionId: string, limit = 10): SessionRunRow[] {
    return this.db
      .prepare(`
        SELECT
          id,
          session_id as sessionId,
          kind,
          status,
          phase,
          started_at as startedAt,
          finished_at as finishedAt,
          error_message as errorMessage
        FROM session_runs
        WHERE session_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(sessionId, limit) as SessionRunRow[];
  }

  findRunEvents(runId: string, limit = 100): SessionRunEventRow[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          run_id as runId,
          session_id as sessionId,
          type,
          message,
          model,
          phase,
          turn_number as turnNumber,
          elapsed_ms as elapsedMs,
          disagreements,
          metadata_json as metadataJson,
          created_at as createdAt
        FROM session_run_events
        WHERE run_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(runId, limit) as Array<Omit<SessionRunEventRow, "metadata"> & { metadataJson?: string | null }>;

    return rows.map((row) => {
      const { metadataJson, ...event } = row;
      return {
        ...event,
        metadata: metadataJson ? JSON.parse(metadataJson) : null
      };
    });
  }

  saveRunEvent(event: SessionRunEventRow): void {
    this.db
      .prepare(`
        INSERT INTO session_run_events (
          id, run_id, session_id, type, message, model, phase, turn_number, elapsed_ms, disagreements, metadata_json, created_at
        ) VALUES (
          @id, @runId, @sessionId, @type, @message, @model, @phase, @turnNumber, @elapsedMs, @disagreements, @metadataJson, @createdAt
        )
      `)
      .run({
        id: event.id,
        runId: event.runId,
        sessionId: event.sessionId,
        type: event.type,
        message: event.message,
        model: event.model ?? null,
        phase: event.phase ?? null,
        turnNumber: event.turnNumber ?? null,
        elapsedMs: event.elapsedMs ?? null,
        disagreements: event.disagreements ?? null,
        metadataJson: event.metadata ? JSON.stringify(event.metadata) : null,
        createdAt: event.createdAt
      });
  }
}
