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

  it("launches four child sessions, monitors them into blocked states, and refreshes a resumed child to its next checkpoint", async () => {
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

    expect(started.childSessions).toHaveLength(4);
    expect(started.childSessions.map((child) => child.label)).toEqual([
      "requirements",
      "architecture",
      "release-risk",
      "operability"
    ]);

    const blocked = await waitForWorkflowRun(
      workflowService,
      started.id,
      (run) => run.status === "partially_blocked" && run.summary.humanBlockedChildren === 4
    );

    expect(blocked.summary).toMatchObject({
      totalChildren: 4,
      humanBlockedChildren: 4,
      escalationCount: 4
    });
    expect(blocked.escalations).toHaveLength(4);
    expect(blocked.escalations.map((brief) => brief.questions)).toEqual([
      ["What is the target platform?"],
      ["What is the target platform?"],
      ["What is the target platform?"],
      ["What is the target platform?"]
    ]);

    const requirementsChild = blocked.childSessions.find((child) => child.label === "requirements");
    expect(requirementsChild).toBeDefined();

    await workflowService.handleHumanResponse(
      blocked.id,
      requirementsChild!.sessionId,
      "Target web first."
    );

    const resumed = await waitForWorkflowRun(
      workflowService,
      blocked.id,
      (run) => {
        const child = run.childSessions.find((candidate) => candidate.sessionId === requirementsChild!.sessionId);
        return child?.snapshot.session.status === "checkpoint"
          && child.latestBrief?.questions[0] === "Approve approach to proceed to spec generation";
      }
    );

    const updatedRequirementsChild = resumed.childSessions.find(
      (child) => child.sessionId === requirementsChild!.sessionId
    );
    expect(updatedRequirementsChild?.state).toBe("human_blocked");
    expect(updatedRequirementsChild?.latestBrief).toMatchObject({
      kind: "human_blocked",
      questions: ["Approve approach to proceed to spec generation"]
    });
    expect(resumed.summary).toMatchObject({
      totalChildren: 4,
      humanBlockedChildren: 4
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
      (run) => run.status === "partially_blocked" && run.summary.humanBlockedChildren === 4
    );

    initialWorkflowService.dispose();

    initialWorkflowRepository.updateWorkflowRun({
      id: started.id,
      status: "launching",
      summary: {
        totalChildren: 4,
        runningChildren: 4,
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
        totalChildren: 4,
        humanBlockedChildren: 4,
        escalationCount: 4
      }
    });
    expect(reconciled?.childSessions).toHaveLength(4);

    const listed = await rehydratedWorkflowService.listWorkflowRuns({
      specId: "parallel_existing_spec_review",
      status: "partially_blocked"
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: started.id,
      status: "partially_blocked",
      summary: {
        humanBlockedChildren: 4
      }
    });
  });
});
