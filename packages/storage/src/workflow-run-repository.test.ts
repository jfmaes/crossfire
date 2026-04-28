import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, createInMemoryDatabase } from "./database";
import { SessionRepository } from "./session-repository";
import { WorkflowRunRepository } from "./workflow-run-repository";

let tempDir: string | undefined;

describe("WorkflowRunRepository", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("persists workflow runs, child sessions, and escalations", () => {
    const db = createInMemoryDatabase();
    const sessionRepo = new SessionRepository(db);
    const repo = new WorkflowRunRepository(db);

    sessionRepo.create({
      id: "sess_1",
      title: "Child session",
      status: "waiting_for_human"
    });
    sessionRepo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "create",
      status: "running",
      phase: "analysis",
      startedAt: "2026-04-28T10:00:00.000Z"
    });
    sessionRepo.createRun({
      id: "run_2",
      sessionId: "sess_1",
      kind: "resume",
      status: "running",
      phase: "analysis",
      startedAt: "2026-04-28T10:00:02.000Z"
    });

    repo.createWorkflowRun({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      status: "monitoring",
      input: {
        title: "Review auth spec",
        prompt: "Focus on release risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      },
      summary: {
        totalChildren: 1,
        runningChildren: 1,
        blockedChildren: 0,
        finalizedChildren: 0,
        erroredChildren: 0
      },
      createdAt: "2026-04-28T10:00:00.000Z",
      updatedAt: "2026-04-28T10:00:00.000Z",
      settledAt: null
    });

    repo.upsertChildSession({
      workflowRunId: "wf_1",
      sessionId: "sess_1",
      label: "release-risk",
      lens: "implementation and rollout risk",
      state: "running",
      latestRunId: "run_1",
      escalationId: null,
      createdAt: "2026-04-28T10:00:01.000Z",
      updatedAt: "2026-04-28T10:00:02.000Z"
    });

    repo.createEscalation({
      id: "esc_1",
      workflowRunId: "wf_1",
      sessionId: "sess_1",
      kind: "human_blocked",
      status: "open",
      brief: {
        kind: "human_blocked",
        label: "release-risk",
        lens: "implementation and rollout risk",
        summary: "Crossfire needs a target platform answer.",
        recommendedDirection: "Start with web only.",
        risks: ["Delaying the platform choice delays rollout planning."],
        questions: ["What is the target platform?"]
      },
      resolution: {
        resolvedBy: "human",
        decision: "Start with web only."
      },
      createdAt: "2026-04-28T10:00:03.000Z",
      updatedAt: "2026-04-28T10:00:05.000Z"
    });

    repo.upsertChildSession({
      workflowRunId: "wf_1",
      sessionId: "sess_1",
      label: "release-risk",
      lens: "implementation and rollout risk",
      state: "human_blocked",
      latestRunId: "run_2",
      escalationId: "esc_1",
      createdAt: "2026-04-28T10:00:01.000Z",
      updatedAt: "2026-04-28T10:00:06.000Z"
    });

    repo.updateWorkflowRun({
      id: "wf_1",
      status: "partially_blocked",
      summary: {
        totalChildren: 1,
        runningChildren: 0,
        blockedChildren: 1,
        finalizedChildren: 0,
        erroredChildren: 0
      },
      updatedAt: "2026-04-28T10:00:04.000Z"
    });
    repo.updateWorkflowRun({
      id: "wf_1",
      status: "settled",
      summary: {
        totalChildren: 1,
        runningChildren: 0,
        blockedChildren: 0,
        finalizedChildren: 1,
        erroredChildren: 0
      },
      updatedAt: "2026-04-28T10:00:07.000Z",
      settledAt: "2026-04-28T10:00:07.000Z"
    });

    expect(repo.findWorkflowRunById("wf_1")).toMatchObject({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      status: "settled",
      input: {
        title: "Review auth spec",
        prompt: "Focus on release risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      },
      summary: {
        totalChildren: 1,
        finalizedChildren: 1
      },
      updatedAt: "2026-04-28T10:00:07.000Z",
      settledAt: "2026-04-28T10:00:07.000Z"
    });
    expect(repo.findChildSessions("wf_1")).toEqual([
      {
        workflowRunId: "wf_1",
        sessionId: "sess_1",
        label: "release-risk",
        lens: "implementation and rollout risk",
        state: "human_blocked",
        latestRunId: "run_2",
        escalationId: "esc_1",
        createdAt: "2026-04-28T10:00:01.000Z",
        updatedAt: "2026-04-28T10:00:06.000Z"
      }
    ]);
    expect(repo.findEscalations("wf_1")).toEqual([
      expect.objectContaining({
        id: "esc_1",
        workflowRunId: "wf_1",
        sessionId: "sess_1",
        kind: "human_blocked",
        status: "open",
        brief: expect.objectContaining({
          recommendedDirection: "Start with web only."
        }),
        resolution: {
          resolvedBy: "human",
          decision: "Start with web only."
        }
      })
    ]);
  });

  it("rejects child sessions without a real run, with a run from another session, and escalations without a matching child session", () => {
    const db = createInMemoryDatabase();
    const sessionRepo = new SessionRepository(db);
    const repo = new WorkflowRunRepository(db);

    sessionRepo.create({
      id: "sess_1",
      title: "Child session",
      status: "waiting_for_human"
    });
    sessionRepo.create({
      id: "sess_2",
      title: "Other child session",
      status: "waiting_for_human"
    });
    sessionRepo.createRun({
      id: "run_other_session",
      sessionId: "sess_2",
      kind: "create",
      status: "running",
      phase: "analysis",
      startedAt: "2026-04-28T10:00:00.000Z"
    });

    repo.createWorkflowRun({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      status: "monitoring",
      input: {
        title: "Review auth spec",
        prompt: "Focus on release risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      },
      summary: {
        totalChildren: 1,
        runningChildren: 1,
        blockedChildren: 0,
        finalizedChildren: 0,
        erroredChildren: 0
      },
      createdAt: "2026-04-28T10:00:00.000Z",
      updatedAt: "2026-04-28T10:00:00.000Z",
      settledAt: null
    });

    expect(() =>
      repo.upsertChildSession({
        workflowRunId: "wf_1",
        sessionId: "sess_1",
        label: "release-risk",
        lens: "implementation and rollout risk",
        state: "running",
        latestRunId: "run_missing",
        escalationId: null,
        createdAt: "2026-04-28T10:00:01.000Z",
        updatedAt: "2026-04-28T10:00:01.000Z"
      })
    ).toThrow();

    expect(() =>
      repo.upsertChildSession({
        workflowRunId: "wf_1",
        sessionId: "sess_1",
        label: "release-risk",
        lens: "implementation and rollout risk",
        state: "running",
        latestRunId: "run_other_session",
        escalationId: null,
        createdAt: "2026-04-28T10:00:01.000Z",
        updatedAt: "2026-04-28T10:00:01.000Z"
      })
    ).toThrow();

    expect(() =>
      repo.createEscalation({
        id: "esc_1",
        workflowRunId: "wf_1",
        sessionId: "sess_1",
        kind: "human_blocked",
        status: "open",
        brief: {
          kind: "human_blocked",
          label: "release-risk",
          lens: "implementation and rollout risk",
          summary: "Crossfire needs a target platform answer.",
          recommendedDirection: "Start with web only.",
          risks: ["Delaying the platform choice delays rollout planning."],
          questions: ["What is the target platform?"]
        },
        resolution: {
          resolvedBy: "human",
          decision: "Start with web only."
        },
        createdAt: "2026-04-28T10:00:03.000Z",
        updatedAt: "2026-04-28T10:00:03.000Z"
      })
    ).toThrow();
  });

  it("migrates a legacy workflow database without resolution_json or the new workflow foreign keys", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-storage-"));
    const databasePath = path.join(tempDir, "legacy-workflow.sqlite");

    const legacyDb = new Database(databasePath);
    legacyDb.pragma("foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT,
        prompt TEXT,
        execution_policy TEXT
      );

      CREATE TABLE session_summaries (
        session_id TEXT PRIMARY KEY,
        current_understanding TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        changed_since_last_checkpoint TEXT NOT NULL,
        open_risks TEXT NOT NULL,
        decisions_needed TEXT NOT NULL,
        artifact_path TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE interview_questions (
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

      CREATE TABLE phase_results (
        session_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (session_id, phase),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE session_runs (
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

      CREATE TABLE revision_requests (
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

      CREATE UNIQUE INDEX revision_requests_run_id_unique
        ON revision_requests(run_id);

      CREATE TABLE session_run_events (
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

      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT
      );

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
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE workflow_escalations (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        brief_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    legacyDb
      .prepare("INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)")
      .run("sess_1", "Legacy session", "waiting_for_human");
    legacyDb
      .prepare("INSERT INTO sessions (id, title, status) VALUES (?, ?, ?)")
      .run("sess_2", "Legacy other session", "waiting_for_human");
    legacyDb
      .prepare(`
        INSERT INTO session_runs (id, session_id, kind, status, phase, started_at, finished_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("run_1", "sess_1", "create", "running", "analysis", "2026-04-28T10:00:00.000Z", null, null);
    legacyDb
      .prepare(`
        INSERT INTO session_runs (id, session_id, kind, status, phase, started_at, finished_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("run_other_session", "sess_2", "create", "running", "analysis", "2026-04-28T10:00:01.000Z", null, null);
    legacyDb
      .prepare(`
        INSERT INTO workflow_runs (id, spec_id, status, input_json, summary_json, created_at, updated_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "wf_1",
        "parallel_existing_spec_review",
        "monitoring",
        JSON.stringify({
          title: "Review auth spec",
          prompt: "Focus on release risk.",
          existingSpec: {
            spec: "# Existing Spec",
            implementationPlan: "# Existing Plan"
          }
        }),
        JSON.stringify({
          totalChildren: 1,
          runningChildren: 1,
          blockedChildren: 0,
          finalizedChildren: 0,
          erroredChildren: 0
        }),
        "2026-04-28T10:00:00.000Z",
        "2026-04-28T10:00:00.000Z",
        null
      );
    legacyDb
      .prepare(`
        INSERT INTO workflow_child_sessions (
          workflow_run_id, session_id, label, lens, state, latest_run_id, escalation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "wf_1",
        "sess_1",
        "release-risk",
        "implementation and rollout risk",
        "human_blocked",
        "run_other_session",
        "esc_1",
        "2026-04-28T10:00:01.000Z",
        "2026-04-28T10:00:02.000Z"
      );
    legacyDb
      .prepare(`
        INSERT INTO workflow_escalations (
          id, workflow_run_id, session_id, kind, status, brief_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "esc_1",
        "wf_1",
        "sess_1",
        "human_blocked",
        "open",
        JSON.stringify({
          kind: "human_blocked",
          label: "release-risk",
          lens: "implementation and rollout risk",
          summary: "Crossfire needs a target platform answer.",
          recommendedDirection: "Start with web only.",
          risks: ["Delaying the platform choice delays rollout planning."],
          questions: ["What is the target platform?"]
        }),
        "2026-04-28T10:00:03.000Z",
        "2026-04-28T10:00:03.000Z"
      );
    legacyDb
      .prepare(`
        INSERT INTO workflow_escalations (
          id, workflow_run_id, session_id, kind, status, brief_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "esc_orphan",
        "wf_1",
        "sess_2",
        "human_blocked",
        "open",
        JSON.stringify({
          kind: "human_blocked",
          label: "orphan",
          lens: "missing child",
          summary: "This escalation has no child row.",
          recommendedDirection: "Drop it during migration.",
          risks: ["Stale workflow state."],
          questions: ["Why is this orphaned?"]
        }),
        "2026-04-28T10:00:04.000Z",
        "2026-04-28T10:00:04.000Z"
      );
    legacyDb.close();

    const migratedDb = createDatabase(databasePath);
    const repo = new WorkflowRunRepository(migratedDb);

    expect(repo.findWorkflowRunById("wf_1")).toMatchObject({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      input: {
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      }
    });
    expect(repo.findChildSessions("wf_1")).toEqual([
      expect.objectContaining({
        sessionId: "sess_1",
        latestRunId: null,
        escalationId: "esc_1"
      })
    ]);
    expect(repo.findEscalations("wf_1")).toEqual([
      expect.objectContaining({
        id: "esc_1",
        resolution: null
      })
    ]);
    expect(repo.findEscalations("wf_1").map((row) => row.id)).not.toContain("esc_orphan");

    migratedDb.close();
  });
});
