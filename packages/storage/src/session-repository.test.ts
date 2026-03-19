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
});
