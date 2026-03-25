import { describe, expect, it } from "vitest";
import { buildServer } from "../server";

const fakeSession = {
  session: {
    id: "sess_1",
    title: "New session",
    status: "checkpoint"
  },
  summary: {
    currentUnderstanding: "The models agree on the first pass.",
    recommendation: "Proceed with the daemon-backed loop.",
    changedSinceLastCheckpoint: ["Initialized the session"],
    openRisks: ["No explicit disagreements yet"],
    decisionsNeeded: ["Review the first checkpoint"]
  }
};

const fakeService = {
  async createSession() {
    return fakeSession;
  },
  async continueSession() {
    return fakeSession;
  },
  async restartSession() {
    return fakeSession;
  },
  deleteSession() {},
  listSessions() {
    return [{ id: "sess_1", title: "New session", status: "checkpoint", phase: "analysis" }];
  },
  async getSession() {
    return fakeSession;
  },
  getRun() {
    return {
      id: "run_1",
      sessionId: "sess_1",
      kind: "restart",
      status: "running",
      phase: "analysis",
      startedAt: new Date().toISOString()
    };
  },
  listRunEvents() {
    return [
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "phase_start",
        message: "Phase 1 started",
        createdAt: new Date().toISOString()
      }
    ];
  }
};

describe("session routes", () => {
  it("creates a session and returns the first checkpoint payload", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { "x-council-token": "secret-token" },
      payload: {
        title: "New session",
        prompt: "Help me spec a local app"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().summary.recommendation).toBe("Proceed with the daemon-backed loop.");
    await app.close();
  });

  it("returns 400 when title or prompt is missing", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { "x-council-token": "secret-token" },
      payload: { title: "New session" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("title and prompt are required");
    await app.close();
  });

  it("continues a session and returns updated checkpoint", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions/sess_1/continue",
      headers: { "x-council-token": "secret-token" },
      payload: { humanResponse: "Yes, include mobile support" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.id).toBe("sess_1");
    await app.close();
  });

  it("returns 400 when humanResponse is missing for continue", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions/sess_1/continue",
      headers: { "x-council-token": "secret-token" },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("humanResponse is required");
    await app.close();
  });

  it("returns a stored session payload", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "GET",
      url: "/sessions/sess_1",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.id).toBe("sess_1");
    await app.close();
  });

  it("restarts a session asynchronously", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "POST",
      url: "/sessions/sess_1/restart",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().session.id).toBe("sess_1");
    await app.close();
  });

  it("returns a run payload", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "GET",
      url: "/runs/run_1",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("run_1");
    await app.close();
  });

  it("returns run events", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      sessionService: fakeService
    });

    const response = await app.inject({
      method: "GET",
      url: "/runs/run_1/events",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0].runId).toBe("run_1");
    await app.close();
  });
});
