import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository } from "@council/storage";
import { createSessionService } from "./session-service";

function createPhaseAwareProvider(name: "gpt" | "claude"): ProviderAdapter {
  return {
    name,
    async *sendTurn(_input: ProviderTurnInput) {
      const turn: ModelTurn = {
        actor: name,
        rawText: `${name} analysis response`,
        summary: `${name} summary`,
        newInsights: [`${name} insight`],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [`What is the target platform?`],
        proposedSpecDelta: "",
        milestoneReached: null,
        degraded: false
      };
      yield { type: "structured_turn", actor: name, turn } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

describe("session-service spec-driven lifecycle", () => {
  function createService() {
    return createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: createPhaseAwareProvider("gpt"),
      claude: createPhaseAwareProvider("claude")
    });
  }

  it("creates a session with analysis + question debate in one step", async () => {
    const service = createService();

    const result = await service.createSession({
      title: "Spec workshop",
      prompt: "Design a collaborative editor"
    });

    // The analysis phase includes both independent analysis AND question debate
    expect(result.session.phase).toBe("analysis");
    expect(result.session.status).toBe("checkpoint");
    expect((result as Record<string, unknown>).phaseResult).toBeDefined();
    expect((result as Record<string, unknown>).interviewState).toBeDefined();
  });

  it("transitions from analysis directly to interview on continue", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec workshop",
      prompt: "Design an API"
    });

    // analysis → interview
    const continued = await service.continueSession({
      id: created.session.id,
      humanResponse: "Start the interview"
    });

    expect(continued).not.toBeNull();
    expect(continued!.session.phase).toBe("interview");
    expect(continued!.session.status).toBe("interviewing");
  });

  it("handles interview answers and advances to approach_debate", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    // analysis → interview
    await service.continueSession({
      id: created.session.id,
      humanResponse: "Start"
    });

    // interview → send "enough" to skip
    const afterEnough = await service.continueSession({
      id: created.session.id,
      humanResponse: "enough"
    });

    expect(afterEnough).not.toBeNull();
    expect(afterEnough!.session.phase).toBe("approach_debate");
  });

  it("transitions from approach_debate to spec_generation on continue", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    await service.continueSession({ id: created.session.id, humanResponse: "Start" });
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    const result = await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });

    expect(result).not.toBeNull();
    expect(result!.session.phase).toBe("spec_generation");
  });

  it("finalizes on approve at spec_generation", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    await service.continueSession({ id: created.session.id, humanResponse: "Start" });
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });

    const finalized = await service.continueSession({ id: created.session.id, humanResponse: "approve" });

    expect(finalized).not.toBeNull();
    expect(finalized!.session.status).toBe("finalized");
  });

  it("revises spec on non-approve feedback", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    await service.continueSession({ id: created.session.id, humanResponse: "Start" });
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });

    const revised = await service.continueSession({
      id: created.session.id,
      humanResponse: "Add more detail about auth"
    });

    expect(revised).not.toBeNull();
    expect(revised!.session.phase).toBe("spec_generation");
    expect(revised!.session.status).toBe("checkpoint");
  });

  it("persists the full prompt", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    const service = createSessionService({
      repository,
      gpt: createPhaseAwareProvider("gpt"),
      claude: createPhaseAwareProvider("claude")
    });

    const longPrompt = "Design a system with real-time collaboration, offline mode, and end-to-end encryption";
    const created = await service.createSession({
      title: longPrompt.slice(0, 80),
      prompt: longPrompt
    });

    const session = repository.findById(created.session.id);
    expect(session!.prompt).toBe(longPrompt);
  });

  it("recovers from errored state", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    const service = createSessionService({
      repository,
      gpt: createPhaseAwareProvider("gpt"),
      claude: createPhaseAwareProvider("claude")
    });

    const created = await service.createSession({
      title: "Error test",
      prompt: "Test error recovery"
    });

    repository.updateStatus({ id: created.session.id, status: "errored" });

    const recovered = await service.continueSession({
      id: created.session.id,
      humanResponse: "retry"
    });

    expect(recovered).not.toBeNull();
    expect(recovered!.session.status).not.toBe("errored");
  });

  it("getSession returns phase and interview data", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec workshop",
      prompt: "Design an app"
    });

    const fetched = await service.getSession(created.session.id);
    expect(fetched).not.toBeNull();
    expect((fetched as Record<string, unknown>).interviewState).toBeDefined();
  });
});
