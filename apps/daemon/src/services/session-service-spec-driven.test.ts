import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository } from "@council/storage";
import { createSessionService } from "./session-service";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
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
  async function waitForSettledSession(
    service: ReturnType<typeof createSessionService>,
    id: string,
    attempts = 20
  ) {
    for (let i = 0; i < attempts; i++) {
      const current = await service.getSession(id);
      if (current && !current.activeRun) {
        return current;
      }
      await delay(10);
    }

    throw new Error(`Session ${id} did not settle in time`);
  }

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

    expect(result.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, result.session.id);
    expect(settled.session.phase).toBe("interview");
    expect(settled.session.status).toBe("interviewing");
    expect((settled as Record<string, unknown>).analysisResult).toBeDefined();
    expect((settled as Record<string, unknown>).interviewState).toBeDefined();
  });

  it("handles interview answers and advances to approach_debate", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    const initial = await waitForSettledSession(service, created.session.id);
    expect(initial.session.phase).toBe("interview");

    const afterEnough = await service.continueSession({
      id: created.session.id,
      humanResponse: "enough"
    });

    expect(afterEnough?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.phase).toBe("approach_debate");
  });

  it("transitions from approach_debate to spec_generation on continue", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);
    const result = await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });

    expect(result?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.phase).toBe("spec_generation");
  });

  it("finalizes on approve at spec_generation", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec",
      prompt: "Build an app"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });
    await waitForSettledSession(service, created.session.id);

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

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });
    await waitForSettledSession(service, created.session.id);

    const revised = await service.continueSession({
      id: created.session.id,
      humanResponse: "Add more detail about auth"
    });

    expect(revised?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.phase).toBe("spec_generation");
    expect(settled.session.status).toBe("checkpoint");
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

    expect(recovered?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.status).not.toBe("errored");
  });

  it("getSession returns phase and interview data", async () => {
    const service = createService();

    const created = await service.createSession({
      title: "Spec workshop",
      prompt: "Design an app"
    });

    const fetched = await waitForSettledSession(service, created.session.id);
    expect(fetched).not.toBeNull();
    expect((fetched as Record<string, unknown>).interviewState).toBeDefined();
  });
});
