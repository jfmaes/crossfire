import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { FakeProvider } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository } from "@council/storage";
import { afterEach } from "vitest";
import { createSessionService } from "./session-service";

let tempDir: string | undefined;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createDelayedQuestionProvider(name: "gpt" | "claude", delayMs = 25): ProviderAdapter {
  return {
    name,
    async *sendTurn(input: ProviderTurnInput) {
      await delay(delayMs);

      const turn: ModelTurn = {
        actor: name,
        rawText: `${name} delayed response`,
        summary: `${name} delayed summary`,
        newInsights: [`${name} insight`],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: input.phase === "analysis" ? ["What is the target platform?"] : [],
        proposedSpecDelta: input.phase === "spec_generation" ? `${name} spec` : "",
        milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
        implementationPlan: input.phase === "spec_generation" ? `${name} implementation plan` : null,
        proposedQuestions: input.phase === "analysis"
          ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope" }]
          : null,
        synthesizedQuestions: input.phase === "analysis_debate"
          ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope" }]
          : null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: input.phase === "walkthrough" ? [] : null,
        degraded: false
      };

      yield { type: "structured_turn", actor: name, turn, rawResponse: JSON.stringify(turn) } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "delayed provider ready" };
    }
  };
}

function seedSpecCheckpoint(repository: SessionRepository) {
  repository.create({
    id: "sess_spec",
    title: "Spec revision session",
    status: "checkpoint",
    phase: "spec_generation",
    prompt: "Build an app"
  });
  repository.saveSummary({
    sessionId: "sess_spec",
    currentUnderstanding: "Spec ready for review.",
    recommendation: "Approve or revise the specification.",
    changedSinceLastCheckpoint: ["Spec generated"],
    openRisks: [],
    decisionsNeeded: ["Approve or revise"],
    artifactPath: null
  });
  repository.savePhaseResult({
    sessionId: "sess_spec",
    phase: "approach_debate",
    resultJson: JSON.stringify({
      convergedApproach: "Use a simple web architecture.",
      finalApproachHandoff: "Use React and Node."
    })
  });
  repository.savePhaseResult({
    sessionId: "sess_spec",
    phase: "spec_generation",
    resultJson: JSON.stringify({
      spec: "# Current Spec",
      implementationPlan: "# Current Plan",
      summary: "Current spec summary"
    })
  });
}

describe("createSessionService", () => {
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

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates a session and advances past analysis", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await service.createSession({
      title: "Spec a local collaboration tool",
      prompt: "Help me design a dual-LLM planning app"
    });

    expect(result.session.id).toBeTruthy();
    // FakeProvider produces no questions, so analysis skips interview
    // and goes straight to approach debate checkpoint.
    expect(await service.getSession(result.session.id)).not.toBeNull();
  });

  it("progresses through phases via continueSession", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const created = await service.createSession({
      title: "Continuable session",
      prompt: "Initial problem"
    });

    const initial = await waitForSettledSession(service, created.session.id);
    expect(initial.session.phase).toBe("approach_debate");

    const continued = await service.continueSession({
      id: created.session.id,
      humanResponse: "Proceed to spec"
    });

    expect(continued?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.id).toBe(created.session.id);
    expect(settled.summary.currentUnderstanding).toBeTruthy();
  });

  it("returns null when continuing a nonexistent session", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await service.continueSession({
      id: "nonexistent",
      humanResponse: "Hello"
    });

    expect(result).toBeNull();
  });

  it("stores large spec feedback verbatim and revises from the existing spec", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    seedSpecCheckpoint(repository);
    const prompts: ProviderTurnInput[] = [];
    const provider: ProviderAdapter = {
      name: "gpt",
      async *sendTurn(input: ProviderTurnInput) {
        prompts.push(input);
        const turn: ModelTurn = {
          actor: "gpt",
          rawText: "ok",
          summary: "ok",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: input.phase === "feedback_digest"
            ? "- change: tighten auth\n  sourceChunkIds: [feedback-chunk-1]"
            : "# Revised Spec",
          milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
          implementationPlan: input.phase === "spec_generation" ? "# Revised Plan" : null,
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: input.phase === "walkthrough" ? [] : null,
          degraded: false
        };
        yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
        yield { type: "done" } as const;
      },
      async healthCheck() {
        return { ok: true, detail: "ready" };
      }
    };
    const service = createSessionService({
      repository,
      gpt: provider,
      claude: provider
    });

    const feedback = "Please tighten auth. ".repeat(1_000);
    const started = await service.continueSession({ id: "sess_spec", humanResponse: feedback });
    expect(started?.activeRun).toBeDefined();
    const runId = started!.activeRun!.id;

    const settled = await waitForSettledSession(service, "sess_spec");
    const revisionRequest = repository.findRevisionRequestByRunId(runId);
    const specResult = JSON.parse(repository.findPhaseResult("sess_spec", "spec_generation")!.resultJson);

    expect(settled.session.status).toBe("checkpoint");
    expect(revisionRequest?.feedbackRaw).toBe(feedback);
    expect(revisionRequest?.status).toBe("applied");
    expect(specResult.spec).toBe("# Revised Spec");
    expect(specResult.implementationPlan).toBe("# Revised Plan");
    expect(prompts.some((prompt) => prompt.prompt.includes("HUMAN REVISION FEEDBACK:"))).toBe(false);
    expect(prompts.some((prompt) => prompt.prompt.includes("CURRENT SPECIFICATION:"))).toBe(true);
  });

  it("keeps previous spec result when spec revision provider fails", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    seedSpecCheckpoint(repository);
    const provider: ProviderAdapter = {
      name: "gpt",
      async *sendTurn(input: ProviderTurnInput) {
        const turn: Partial<ModelTurn> = {
          actor: "gpt",
          rawText: "invalid revision",
          summary: "invalid revision",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: input.phase === "feedback_digest"
            ? "- change: tighten auth\n  sourceChunkIds: [feedback-chunk-1]"
            : "# Broken Spec",
          milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
          implementationPlan: input.phase === "feedback_digest" ? null : undefined,
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        };
        yield { type: "structured_turn", actor: "gpt", turn: turn as ModelTurn, rawResponse: JSON.stringify(turn) } as const;
        yield { type: "done" } as const;
      },
      async healthCheck() {
        return { ok: true, detail: "ready" };
      }
    };
    const service = createSessionService({
      repository,
      gpt: provider,
      claude: provider
    });

    const started = await service.continueSession({
      id: "sess_spec",
      humanResponse: "Please tighten auth. ".repeat(1_000)
    });
    const runId = started!.activeRun!.id;
    const settled = await waitForSettledSession(service, "sess_spec");
    const specResult = JSON.parse(repository.findPhaseResult("sess_spec", "spec_generation")!.resultJson);
    const revisionRequest = repository.findRevisionRequestByRunId(runId);

    expect(settled.session.status).toBe("errored");
    expect(specResult.spec).toBe("# Current Spec");
    expect(specResult.implementationPlan).toBe("# Current Plan");
    expect(revisionRequest?.status).toBe("failed");
  });

  it("injects grounding context into the first prompt when configured", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-session-grounding-"));
    await writeFile(path.join(tempDir, "README.md"), "# Grounded context\n");

    let seenPrompt = "";

    class CapturingProvider implements ProviderAdapter {
      readonly name = "gpt" as const;

      async *sendTurn(input: ProviderTurnInput) {
        if (!seenPrompt) {
          seenPrompt = input.prompt;
        }

        const turn: ModelTurn = {
          actor: "gpt",
          rawText: "grounded response",
          summary: "grounded response",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: input.phase === "analysis" ? ["What is the target platform?"] : [],
          proposedSpecDelta: input.phase === "spec_generation" ? "grounded spec" : "",
          milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
          implementationPlan: input.phase === "spec_generation" ? "grounded implementation plan" : null,
          proposedQuestions: input.phase === "analysis" ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope" }] : null,
          synthesizedQuestions: input.phase === "analysis_debate" ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope" }] : null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: input.phase === "walkthrough" ? [] : null,
          degraded: false
        };

        yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
        yield { type: "done" } as const;
      }

      async healthCheck() {
        return { ok: true, detail: "capturing provider ready" };
      }
    }

    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new CapturingProvider(),
      claude: new FakeProvider("claude"),
      grounding: {
        rootDir: tempDir,
        maxFiles: 1,
        includeExtensions: [".md"]
      }
    });

    await service.createSession({
      title: "Grounded session",
      prompt: "Use repo context"
    });

    expect(seenPrompt).toContain("Grounding context:");
    expect(seenPrompt).toContain("# Grounded context");
  });

  it("restarts non-finalized sessions in place asynchronously from phase 0", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude")
    });

    const created = await service.createSession({
      title: "Restartable session",
      prompt: "Help me design a dual-LLM planning app"
    });

    const initial = await waitForSettledSession(service, created.session.id);
    expect(initial.session.phase).toBe("interview");

    const restarted = await service.restartSession(created.session.id);
    expect(restarted).not.toBeNull();
    expect(restarted!.session.id).toBe(created.session.id);
    expect(restarted!.session.phase).toBe("analysis");
    expect(restarted!.session.status).toBe("debating");
    expect(restarted!.interviewState?.questions).toHaveLength(0);

    let rerun: Awaited<ReturnType<typeof service.getSession>> = await waitForSettledSession(service, created.session.id);
    for (let i = 0; rerun?.session.phase !== "interview" && i < 20; i++) {
      await delay(25);
      rerun = await service.getSession(created.session.id);
      if (rerun?.activeRun) {
        rerun = await waitForSettledSession(service, created.session.id);
      }
    }
    expect(rerun).not.toBeNull();
    expect(rerun!.session.phase).toBe("interview");
    expect(rerun!.interviewState?.questions.length).toBeGreaterThan(0);
  });

  it("restarts finalized sessions as brand-new sessions", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude")
    });

    const created = await service.createSession({
      title: "Finalizable session",
      prompt: "Design a system"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });
    await waitForSettledSession(service, created.session.id);
    const finalized = await service.continueSession({ id: created.session.id, humanResponse: "approve" });

    expect(finalized?.session.status).toBe("finalized");

    const restarted = await service.restartSession(created.session.id);
    expect(restarted).not.toBeNull();
    expect(restarted!.session.id).not.toBe(created.session.id);
    expect(restarted!.session.phase).toBe("analysis");
    expect(restarted!.session.status).toBe("debating");

    const original = await service.getSession(created.session.id);
    expect(original?.session.status).toBe("finalized");
  });

  it("rewinds approach debate back to interview without restarting the whole session", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude")
    });

    const created = await service.createSession({
      title: "Rewindable debate",
      prompt: "Design a system"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);

    const rewound = await service.rewindSession(created.session.id);

    expect(rewound).not.toBeNull();
    expect(rewound!.session.phase).toBe("interview");
    expect(rewound!.session.status).toBe("interviewing");
    expect(rewound!.interviewState?.questions.length).toBeGreaterThan(0);
  });

  it("rewinds spec generation back to the saved approach debate checkpoint", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    const service = createSessionService({
      repository,
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude")
    });

    const created = await service.createSession({
      title: "Rewindable spec",
      prompt: "Design a system"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });
    await waitForSettledSession(service, created.session.id);

    expect(repository.findPhaseResult(created.session.id, "spec_generation")).toBeDefined();

    const rewound = await service.rewindSession(created.session.id);

    expect(rewound).not.toBeNull();
    expect(rewound!.session.phase).toBe("approach_debate");
    expect(["checkpoint", "waiting_for_human"]).toContain(rewound!.session.status);
    expect(repository.findPhaseResult(created.session.id, "spec_generation")).toBeUndefined();
  });

  it("marks a background run errored when post-processing fails", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-artifact-failure-"));
    const artifactDirectory = path.join(tempDir, "not-a-directory");
    await writeFile(artifactDirectory, "occupied");

    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude"),
      artifactsDirectory: artifactDirectory
    });

    const created = await service.createSession({
      title: "Artifact failure",
      prompt: "Design a system"
    });

    await waitForSettledSession(service, created.session.id);
    await service.continueSession({ id: created.session.id, humanResponse: "enough" });
    await waitForSettledSession(service, created.session.id);

    const started = await service.continueSession({
      id: created.session.id,
      humanResponse: "Looks good"
    });
    expect(started?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, created.session.id);
    expect(settled.session.status).toBe("errored");
  });
});
