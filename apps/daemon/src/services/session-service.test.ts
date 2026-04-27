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

function seedApproachCheckpoint(repository: SessionRepository, sessionId = "sess_specgen") {
  repository.create({
    id: sessionId,
    title: "Spec generation session",
    status: "checkpoint",
    phase: "approach_debate",
    prompt: "Design a task manager"
  });
  repository.saveSummary({
    sessionId,
    currentUnderstanding: "Approach ready for spec generation.",
    recommendation: "Approve approach to proceed to spec generation.",
    changedSinceLastCheckpoint: ["Approach debate converged"],
    openRisks: [],
    decisionsNeeded: ["Approve approach to proceed to spec generation"],
    artifactPath: null
  });
  repository.savePhaseResult({
    sessionId,
    phase: "approach_debate",
    resultJson: JSON.stringify({
      convergedApproach: "Use a simple web architecture.",
      finalApproachHandoff: "Use React + Node.",
      questionsForHuman: [],
      trace: {
        stopReason: "consensus",
        finalDisagreements: []
      }
    })
  });
}

function createSpecGenerationProviders(mode: "always_fail" | "fail_once_then_succeed"): {
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
} {
  let failedRevisionAttempts = 0;
  const reviewedSpec = "# Reviewed Spec\n\nShip the task manager.";
  const reviewedPlan = "# Reviewed Plan\n\n1. Build the task manager.";
  const degradedRevisionResponse = [
    "Here is the JSON you requested:",
    JSON.stringify({
      actor: "claude",
      rawText: "Revision raw response body",
      summary: "Revision summary",
      newInsights: [],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: "Revised spec content",
      milestoneReached: "implementation_plan_ready",
      implementationPlan: "Revised plan",
      proposedQuestions: null,
      synthesizedQuestions: null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: null,
      degraded: true
    }),
    "Thanks."
  ].join("\n");

  const gpt: ProviderAdapter = {
    name: "gpt",
    async *sendTurn(input: ProviderTurnInput) {
      const isWalkthrough = input.phase === "walkthrough";
      const turn: ModelTurn = {
        actor: "gpt",
        rawText: isWalkthrough ? "GPT found rollback gaps" : "GPT draft",
        summary: isWalkthrough ? "GPT walkthrough" : "GPT draft summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: isWalkthrough ? "" : "Draft spec content",
        milestoneReached: isWalkthrough ? null : "implementation_plan_ready",
        implementationPlan: isWalkthrough ? null : "Draft implementation plan",
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: isWalkthrough
          ? [{ location: "Section 2", issue: "Missing rollback behavior", fix: "Add rollback steps" }]
          : null,
        degraded: false
      };
      yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };

  const claude: ProviderAdapter = {
    name: "claude",
    async *sendTurn(input: ProviderTurnInput) {
      if (input.phase === "walkthrough") {
        const walkthroughTurn: ModelTurn = {
          actor: "claude",
          rawText: "Claude found no extra gaps",
          summary: "Claude walkthrough",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: [],
          degraded: false
        };
        yield {
          type: "structured_turn",
          actor: "claude",
          turn: walkthroughTurn,
          rawResponse: JSON.stringify(walkthroughTurn)
        } as const;
        yield { type: "done" } as const;
        return;
      }

      const isRevision = input.phase === "spec_generation"
        && input.prompt.includes("ADVERSARIAL WALKTHROUGH FINDINGS:");
      if (isRevision) {
        const shouldFail = mode === "always_fail"
          || (mode === "fail_once_then_succeed" && failedRevisionAttempts === 0);

        if (shouldFail) {
          failedRevisionAttempts += 1;
          const degradedTurn: ModelTurn = {
            actor: "claude",
            rawText: degradedRevisionResponse,
            summary: "Revision summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: "",
            milestoneReached: "implementation_plan_ready",
            implementationPlan: null,
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: null,
            degraded: true
          };
          yield {
            type: "structured_turn",
            actor: "claude",
            turn: degradedTurn,
            rawResponse: degradedRevisionResponse
          } as const;
          yield { type: "done" } as const;
          return;
        }

        const revisionTurn: ModelTurn = {
          actor: "claude",
          rawText: "Final revised spec",
          summary: "Revision complete",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "Final revised spec",
          milestoneReached: "implementation_plan_ready",
          implementationPlan: "Final revised plan",
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        };
        yield {
          type: "structured_turn",
          actor: "claude",
          turn: revisionTurn,
          rawResponse: JSON.stringify(revisionTurn)
        } as const;
        yield { type: "done" } as const;
        return;
      }

      const reviewTurn: ModelTurn = {
        actor: "claude",
        rawText: "Claude review",
        summary: "Claude review summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: reviewedSpec,
        milestoneReached: "implementation_plan_ready",
        implementationPlan: reviewedPlan,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      };
      yield {
        type: "structured_turn",
        actor: "claude",
        turn: reviewTurn,
        rawResponse: JSON.stringify(reviewTurn)
      } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };

  return { gpt, claude };
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

  it("persists degraded spec-generation diagnostics on failed runs", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    seedApproachCheckpoint(repository);
    const providers = createSpecGenerationProviders("always_fail");
    const service = createSessionService({
      repository,
      gpt: providers.gpt,
      claude: providers.claude
    });

    const started = await service.continueSession({
      id: "sess_specgen",
      humanResponse: "Proceed to spec generation"
    });
    expect(started?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, "sess_specgen");
    const persistedFailure = repository.findPhaseResult("sess_specgen", "spec_generation_failure");
    const current = await service.getSession("sess_specgen");
    const exported = service.exportSession("sess_specgen");

    expect(settled.session.phase).toBe("spec_generation");
    expect(settled.session.status).toBe("errored");
    expect(persistedFailure).toBeDefined();
    expect(current?.phaseResult).toMatchObject({
      phase: "spec_generation",
      provider: "claude",
      substep: "revision",
      outputStatus: "degraded"
    });
    expect(exported?.phaseResults).toMatchObject({
      spec_generation_failure: {
        phase: "spec_generation",
        provider: "claude",
        substep: "revision",
        outputStatus: "degraded"
      }
    });
  });

  it("clears stale spec-generation failure diagnostics after a successful retry", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    seedApproachCheckpoint(repository);
    const providers = createSpecGenerationProviders("fail_once_then_succeed");
    const service = createSessionService({
      repository,
      gpt: providers.gpt,
      claude: providers.claude
    });

    await service.continueSession({
      id: "sess_specgen",
      humanResponse: "Proceed to spec generation"
    });
    const failed = await waitForSettledSession(service, "sess_specgen");
    expect(failed.session.status).toBe("errored");
    expect(repository.findPhaseResult("sess_specgen", "spec_generation_failure")).toBeDefined();

    const retried = await service.continueSession({
      id: "sess_specgen",
      humanResponse: "Retry the failed spec generation"
    });
    expect(retried?.activeRun).toBeDefined();

    const settled = await waitForSettledSession(service, "sess_specgen");
    const currentSpec = repository.findPhaseResult("sess_specgen", "spec_generation");
    const staleFailure = repository.findPhaseResult("sess_specgen", "spec_generation_failure");
    const exported = service.exportSession("sess_specgen");

    expect(settled.session.status).toBe("checkpoint");
    expect(currentSpec).toBeDefined();
    expect(JSON.parse(currentSpec!.resultJson)).toMatchObject({
      spec: "Final revised spec",
      implementationPlan: "Final revised plan"
    });
    expect(staleFailure).toBeUndefined();
    expect(exported?.phaseResults).not.toHaveProperty("spec_generation_failure");
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

  it("stores existing spec source metadata when creating from paths", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-existing-spec-service-"));
    const specPath = path.join(tempDir, "spec.md");
    await writeFile(specPath, "# Existing Spec", "utf8");
    const repository = new SessionRepository(createInMemoryDatabase());
    const service = createSessionService({
      repository,
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const created = await service.createSession({
      title: "Review from path",
      mode: "existing_spec",
      existingSpec: { specPath }
    });
    await waitForSettledSession(service, created.session.id);

    const session = repository.findById(created.session.id)!;
    const inputPhase = JSON.parse(repository.findPhaseResult(created.session.id, "existing_spec_input")!.resultJson);
    expect(session.executionPolicy?.mode).toBe("existing_spec");
    expect(inputPhase.sources[0].path).toBe(specPath);
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

  it("removes stale spec-generation failure diagnostics when rewinding out of spec generation", async () => {
    const repository = new SessionRepository(createInMemoryDatabase());
    seedApproachCheckpoint(repository);
    const providers = createSpecGenerationProviders("always_fail");
    const service = createSessionService({
      repository,
      gpt: providers.gpt,
      claude: providers.claude
    });

    await service.continueSession({
      id: "sess_specgen",
      humanResponse: "Proceed to spec generation"
    });
    const failed = await waitForSettledSession(service, "sess_specgen");
    expect(failed.session.status).toBe("errored");
    expect(repository.findPhaseResult("sess_specgen", "spec_generation_failure")).toBeDefined();

    const rewound = await service.rewindSession("sess_specgen");
    const exported = service.exportSession("sess_specgen");

    expect(rewound).not.toBeNull();
    expect(rewound!.session.phase).toBe("approach_debate");
    expect(repository.findPhaseResult("sess_specgen", "spec_generation")).toBeUndefined();
    expect(repository.findPhaseResult("sess_specgen", "spec_generation_failure")).toBeUndefined();
    expect(exported?.phaseResults).not.toHaveProperty("spec_generation_failure");
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
