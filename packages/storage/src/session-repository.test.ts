import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { createDatabase, createInMemoryDatabase } from "./database";
import { SessionRepository } from "./session-repository";

let tempDir: string | undefined;

describe("SessionRepository", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("persists a new session", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Spec a local dual-LLM tool",
      status: "draft"
    });

    expect(repo.findById("sess_1")?.title).toBe("Spec a local dual-LLM tool");
  });

  it("updates session status and persists summaries", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Spec a local dual-LLM tool",
      status: "draft"
    });
    repo.updateStatus({
      id: "sess_1",
      status: "checkpoint"
    });
    repo.saveSummary({
      sessionId: "sess_1",
      currentUnderstanding: "The app coordinates local providers.",
      recommendation: "Keep the daemon in the middle.",
      changedSinceLastCheckpoint: ["Initial checkpoint"],
      openRisks: ["No explicit disagreements yet"],
      decisionsNeeded: ["Review the first checkpoint"],
      artifactPath: "/tmp/session.md"
    });

    expect(repo.findById("sess_1")?.status).toBe("checkpoint");
    expect(repo.findSummaryBySessionId("sess_1")?.artifactPath).toBe("/tmp/session.md");
  });

  it("marks unfinished debating session runs failed during startup recovery", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Interrupted session",
      status: "debating",
      phase: "analysis"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "create",
      status: "running",
      phase: "analysis",
      startedAt: "2026-04-25T09:00:00.000Z"
    });

    expect(repo.recoverStaleDebatingSessions()).toBe(1);

    const recoveredSession = repo.findById("sess_1");
    const recoveredRun = repo.findRunById("run_1");
    expect(recoveredSession?.status).toBe("errored");
    expect(recoveredRun?.status).toBe("failed");
    expect(recoveredRun?.finishedAt).toBeTruthy();
    expect(recoveredRun?.errorMessage).toContain("daemon stopped");
    expect(repo.findActiveRun("sess_1")).toBeUndefined();
  });

  it("persists data across file-backed database reopen", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-storage-"));
    const databasePath = path.join(tempDir, "council.sqlite");

    const firstDb = createDatabase(databasePath);
    const firstRepo = new SessionRepository(firstDb);
    firstRepo.create({
      id: "sess_1",
      title: "Persistent session",
      status: "draft"
    });
    firstRepo.saveSummary({
      sessionId: "sess_1",
      currentUnderstanding: "Persist me",
      recommendation: "Use SQLite on disk",
      changedSinceLastCheckpoint: ["Created once"],
      openRisks: ["None"],
      decisionsNeeded: ["Verify reopen"],
      artifactPath: null
    });

    firstDb.close();

    const reopenedDb = createDatabase(databasePath);
    const reopenedRepo = new SessionRepository(reopenedDb);

    expect(reopenedRepo.findById("sess_1")?.title).toBe("Persistent session");
    expect(reopenedRepo.findSummaryBySessionId("sess_1")?.recommendation).toBe("Use SQLite on disk");
    reopenedDb.close();
  });

  it("stores spec revision feedback verbatim by run id", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Revision session",
      status: "checkpoint",
      phase: "spec_generation"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "revise",
      status: "running",
      phase: "spec_generation",
      startedAt: "2026-04-25T10:00:00.000Z"
    });

    const feedbackRaw = "Line one\n\nLine two with exact wording.";
    repo.createRevisionRequest({
      id: "rev_1",
      sessionId: "sess_1",
      runId: "run_1",
      feedbackRaw,
      feedbackChunks: [],
      feedbackDigest: null,
      budgetLedger: null,
      status: "stored",
      createdAt: "2026-04-25T10:00:01.000Z"
    });

    const found = repo.findRevisionRequestByRunId("run_1");
    expect(found?.feedbackRaw).toBe(feedbackRaw);
    expect(found?.status).toBe("stored");
  });

  it("rejects duplicate revision requests for the same run", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Revision session",
      status: "checkpoint",
      phase: "spec_generation"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "revise",
      status: "running",
      phase: "spec_generation",
      startedAt: "2026-04-25T10:00:00.000Z"
    });

    repo.createRevisionRequest({
      id: "rev_1",
      sessionId: "sess_1",
      runId: "run_1",
      feedbackRaw: "First request",
      feedbackChunks: [],
      feedbackDigest: null,
      budgetLedger: null,
      status: "stored",
      createdAt: "2026-04-25T10:00:01.000Z"
    });

    expect(() =>
      repo.createRevisionRequest({
        id: "rev_2",
        sessionId: "sess_1",
        runId: "run_1",
        feedbackRaw: "Second request",
        feedbackChunks: [],
        feedbackDigest: null,
        budgetLedger: null,
        status: "stored",
        createdAt: "2026-04-25T10:00:02.000Z"
      })
    ).toThrow();
  });

  it("preserves revision request JSON fields when omitted from updates", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Revision session",
      status: "checkpoint",
      phase: "spec_generation"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "revise",
      status: "running",
      phase: "spec_generation",
      startedAt: "2026-04-25T10:00:00.000Z"
    });

    const feedbackRaw = "Line one\n\nLine two with exact wording.";
    const feedbackChunks = [{ text: "Line one", source: "user" }];
    const feedbackDigest = { summary: "Keep exact wording" };
    const budgetLedger = { inputTokens: 123, outputTokens: 45 };
    repo.createRevisionRequest({
      id: "rev_1",
      sessionId: "sess_1",
      runId: "run_1",
      feedbackRaw,
      feedbackChunks,
      feedbackDigest,
      budgetLedger,
      status: "stored",
      createdAt: "2026-04-25T10:00:01.000Z"
    });

    repo.updateRevisionRequest({
      id: "rev_1",
      status: "processed",
      updatedAt: "2026-04-25T10:00:02.000Z"
    });

    const found = repo.findRevisionRequestByRunId("run_1");
    expect(found?.feedbackRaw).toBe(feedbackRaw);
    expect(found?.feedbackChunks).toEqual(feedbackChunks);
    expect(found?.feedbackDigest).toEqual(feedbackDigest);
    expect(found?.budgetLedger).toEqual(budgetLedger);
    expect(found?.status).toBe("processed");
    expect(found?.updatedAt).toBe("2026-04-25T10:00:02.000Z");
  });

  it("deleteSession removes revision requests for the session", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Revision session",
      status: "checkpoint",
      phase: "spec_generation"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "revise",
      status: "running",
      phase: "spec_generation",
      startedAt: "2026-04-25T10:00:00.000Z"
    });
    repo.createRevisionRequest({
      id: "rev_1",
      sessionId: "sess_1",
      runId: "run_1",
      feedbackRaw: "Revision request",
      feedbackChunks: [],
      feedbackDigest: null,
      budgetLedger: null,
      status: "stored",
      createdAt: "2026-04-25T10:00:01.000Z"
    });

    repo.deleteSession("sess_1");

    expect(repo.findRevisionRequestByRunId("run_1")).toBeUndefined();
  });

  it("clears revision request digest and budget ledger when updated to null", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Revision session",
      status: "checkpoint",
      phase: "spec_generation"
    });
    repo.createRun({
      id: "run_1",
      sessionId: "sess_1",
      kind: "revise",
      status: "running",
      phase: "spec_generation",
      startedAt: "2026-04-25T10:00:00.000Z"
    });

    const feedbackChunks = [{ text: "Line one", source: "user" }];
    repo.createRevisionRequest({
      id: "rev_1",
      sessionId: "sess_1",
      runId: "run_1",
      feedbackRaw: "Line one",
      feedbackChunks,
      feedbackDigest: { summary: "Keep exact wording" },
      budgetLedger: { inputTokens: 123, outputTokens: 45 },
      status: "stored",
      createdAt: "2026-04-25T10:00:01.000Z"
    });

    repo.updateRevisionRequest({
      id: "rev_1",
      feedbackDigest: null,
      budgetLedger: null,
      status: "processed",
      updatedAt: "2026-04-25T10:00:02.000Z"
    });

    const found = repo.findRevisionRequestByRunId("run_1");
    expect(found?.feedbackChunks).toEqual(feedbackChunks);
    expect(found?.feedbackDigest).toBeNull();
    expect(found?.budgetLedger).toBeNull();
    expect(found?.status).toBe("processed");
    expect(found?.updatedAt).toBe("2026-04-25T10:00:02.000Z");
  });
});
