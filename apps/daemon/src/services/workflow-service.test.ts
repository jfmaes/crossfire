import { afterEach, describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository, WorkflowRunRepository } from "@council/storage";
import { createSessionService } from "./session-service";
import { createWorkflowService } from "./workflow-service";

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

async function waitForWorkflowRun(
  service: ReturnType<typeof createWorkflowService>,
  workflowRunId: string,
  predicate: (run: NonNullable<Awaited<ReturnType<typeof service.getWorkflowRun>>>) => boolean,
  attempts = 80
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await service.getWorkflowRun(workflowRunId);
    if (run && predicate(run)) {
      return run;
    }

    await delay(25);
  }

  throw new Error(`Workflow run ${workflowRunId} did not reach the expected state in time.`);
}

describe("createWorkflowService", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it("launches one child session, monitors it into a blocked state, and refreshes it to its next checkpoint", async () => {
    const db = createInMemoryDatabase();
    const sessionService = createSessionService({
      repository: new SessionRepository(db),
      gpt: createDelayedQuestionProvider("gpt"),
      claude: createDelayedQuestionProvider("claude")
    });
    const workflowService = createWorkflowService({
      sessionService,
      workflowRunRepository: new WorkflowRunRepository(db)
    });
    disposers.push(() => workflowService.dispose());

    const started = await workflowService.startParallelExistingSpecReview({
      title: "Existing spec review",
      prompt: "Focus on actionable feedback.",
      existingSpec: {
        spec: "# Existing Spec",
        implementationPlan: "# Existing Plan"
      }
    });

    expect(started.childSessions).toHaveLength(1);
    expect(started.childSessions.map((child) => child.label)).toEqual([
      "existing-spec-review"
    ]);

    const blocked = await waitForWorkflowRun(
      workflowService,
      started.id,
      (run) => run.status === "partially_blocked" && run.summary.humanBlockedChildren === 1
    );

    expect(blocked.summary).toMatchObject({
      totalChildren: 1,
      humanBlockedChildren: 1,
      escalationCount: 1
    });
    expect(blocked.escalations).toHaveLength(1);
    expect(blocked.escalations.map((brief) => brief.questions)).toEqual([
      ["What is the target platform?"]
    ]);

    const reviewChild = blocked.childSessions[0];
    expect(reviewChild).toBeDefined();

    await workflowService.handleHumanResponse(
      blocked.id,
      reviewChild!.sessionId,
      "Target web first."
    );

    const resumed = await waitForWorkflowRun(
      workflowService,
      blocked.id,
      (run) => {
        const child = run.childSessions.find((candidate) => candidate.sessionId === reviewChild!.sessionId);
        return child?.snapshot.session.status === "checkpoint"
          && child.latestBrief?.questions[0] === "Approve approach to proceed to spec generation";
      }
    );

    const updatedReviewChild = resumed.childSessions.find(
      (child) => child.sessionId === reviewChild!.sessionId
    );
    expect(updatedReviewChild?.state).toBe("human_blocked");
    expect(updatedReviewChild?.latestBrief).toMatchObject({
      kind: "human_blocked",
      questions: ["Approve approach to proceed to spec generation"]
    });
    expect(resumed.summary).toMatchObject({
      totalChildren: 1,
      humanBlockedChildren: 1
    });
  });

  it("rehydrates workflow membership and reconciles stale top-level workflow rows on read", async () => {
    const db = createInMemoryDatabase();
    const initialSessionRepository = new SessionRepository(db);
    const initialWorkflowRepository = new WorkflowRunRepository(db);
    const initialWorkflowService = createWorkflowService({
      sessionService: createSessionService({
        repository: initialSessionRepository,
        gpt: createDelayedQuestionProvider("gpt"),
        claude: createDelayedQuestionProvider("claude")
      }),
      workflowRunRepository: initialWorkflowRepository
    });
    disposers.push(() => initialWorkflowService.dispose());

    const started = await initialWorkflowService.startParallelExistingSpecReview({
      title: "Existing spec review",
      prompt: "Focus on actionable feedback.",
      existingSpec: {
        spec: "# Existing Spec",
        implementationPlan: "# Existing Plan"
      }
    });

    await waitForWorkflowRun(
      initialWorkflowService,
      started.id,
      (run) => run.status === "partially_blocked" && run.summary.humanBlockedChildren === 1
    );

    initialWorkflowService.dispose();

    initialWorkflowRepository.updateWorkflowRun({
      id: started.id,
      status: "launching",
      summary: {
        totalChildren: 1,
        runningChildren: 1,
        humanBlockedChildren: 0,
        resumingChildren: 0,
        finalizedChildren: 0,
        erroredChildren: 0,
        escalationCount: 0
      },
      updatedAt: "2026-04-28T12:00:00.000Z"
    });

    const rehydratedWorkflowService = createWorkflowService({
      sessionService: createSessionService({
        repository: new SessionRepository(db),
        gpt: createDelayedQuestionProvider("gpt"),
        claude: createDelayedQuestionProvider("claude")
      }),
      workflowRunRepository: new WorkflowRunRepository(db)
    });
    disposers.push(() => rehydratedWorkflowService.dispose());

    const reconciled = await rehydratedWorkflowService.getWorkflowRun(started.id);
    expect(reconciled).not.toBeNull();
    expect(reconciled).toMatchObject({
      id: started.id,
      status: "partially_blocked",
      summary: {
        totalChildren: 1,
        humanBlockedChildren: 1,
        escalationCount: 1
      }
    });
    expect(reconciled?.childSessions).toHaveLength(1);

    const listed = await rehydratedWorkflowService.listWorkflowRuns({
      specId: "parallel_existing_spec_review",
      status: "partially_blocked"
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: started.id,
      status: "partially_blocked",
      summary: {
        humanBlockedChildren: 1
      }
    });
  });
});
