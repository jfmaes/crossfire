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

  it("creates a session and auto-advances to interview", async () => {
    const service = createService();

    const result = await service.createSession({
      title: "Spec workshop",
      prompt: "Design a collaborative editor"
    });

    // Analysis runs and auto-advances to interview — no checkpoint in between
    expect(result.session.phase).toBe("interview");
    expect(result.session.status).toBe("interviewing");
    expect((result as Record<string, unknown>).analysisResult).toBeDefined();
    expect((result as Record<string, unknown>).interviewState).toBeDefined();
  });

  it("handles interview answers and advances to approach_debate", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    // Session starts in interview; send "enough" to skip to approach debate
    expect(created.session.phase).toBe("interview");
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

    // Simulate an error during interview phase
    repository.updateStatus({ id: created.session.id, status: "errored" });
    repository.updatePhase({ id: created.session.id, phase: "interview" });

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
