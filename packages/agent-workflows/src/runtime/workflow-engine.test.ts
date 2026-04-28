import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionTemplate,
  WorkflowPersistence,
  WorkflowRunView,
  WorkflowRuntime,
  WorkflowSessionSnapshot
} from "../index";
import { createWorkflowEngine, parallelExistingSpecReview } from "../index";

const workflowInput = {
  title: "Checkout spec review",
  prompt: "Prioritize actionable fixes.",
  existingSpec: {
    spec: "# Spec\n\nCurrent checkout draft",
    implementationPlan: "# Plan\n\nShip in two phases"
  }
} as const;

describe("createWorkflowEngine", () => {
  it("launches four child sessions and creates escalation briefs for blocked children", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: buildWorkflowSnapshots("run_a", {
        requirements: {
          status: "grounding",
          currentUnderstanding: "Requirements review is in progress.",
          recommendation: "Continue reviewing the draft."
        },
        architecture: {
          status: "waiting_for_human",
          currentUnderstanding:
            "The service boundary between checkout and payments is unclear.",
          recommendation: "Answer the ownership question directly.",
          openRisks: ["Retry ownership is not defined."],
          currentQuestion: {
            id: "q_architecture",
            text: "Which service owns payment retry orchestration?",
            rationale: "This boundary controls failure handling.",
            recommendation: "Keep retry orchestration inside the payments domain.",
            recommendationReasoning:
              "It keeps retry semantics near the actual payment state machine."
          }
        },
        "release-risk": {
          status: "checkpoint",
          currentUnderstanding:
            "The rollout plan needs an approval gate before production exposure.",
          recommendation: "Approve the staged rollout gate.",
          openRisks: ["Production rollback steps are not explicit."],
          decisionsNeeded: ["Approve the staged rollout gate before implementation begins"]
        },
        operability: {
          status: "finalized",
          currentUnderstanding: "Operability review is complete.",
          recommendation: "Carry the existing test additions into implementation."
        }
      })
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const view = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);

    expect(runtime.createdTemplates).toHaveLength(4);
    expect(runtime.createdTemplates.map((template) => template.label)).toEqual([
      "requirements",
      "architecture",
      "release-risk",
      "operability"
    ]);
    expect(runtime.listRunEventsCalls).toEqual([
      "run_a_requirements",
      "run_a_architecture",
      "run_a_release-risk",
      "run_a_operability"
    ]);

    expect(view.childSessions).toHaveLength(4);
    expect(view.status).toBe("partially_blocked");
    expect(view.summary).toMatchObject({
      totalChildren: 4,
      runningChildren: 1,
      humanBlockedChildren: 2,
      resumingChildren: 0,
      finalizedChildren: 1,
      erroredChildren: 0,
      escalationCount: 2
    });

    expect(view.escalations).toHaveLength(2);
    expect(view.escalations.map((brief) => brief.label)).toEqual([
      "architecture",
      "release-risk"
    ]);

    const architectureChild = view.childSessions.find(
      (child) => child.sessionId === "run_a_architecture"
    );
    expect(architectureChild?.state).toBe("human_blocked");
    expect(architectureChild?.latestBrief).toMatchObject({
      kind: "human_blocked",
      recommendedDirection: "Keep retry orchestration inside the payments domain."
    });
    expect(architectureChild?.latestBrief?.questions).toEqual([
      "Which service owns payment retry orchestration?"
    ]);

    const persisted = await engine.getWorkflowRun(view.id);
    expect(persisted).toEqual(view);

    const listed = await engine.listWorkflowRuns();
    expect(listed).toEqual([view]);
  });

  it("refreshes the chosen child after a human response and updates the latest brief", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: buildWorkflowSnapshots("run_b", {
        requirements: {
          status: "grounding",
          currentUnderstanding: "Requirements review is in progress.",
          recommendation: "Continue reviewing the draft."
        },
        architecture: {
          status: "waiting_for_human",
          currentUnderstanding: "The boundary is still unresolved.",
          recommendation: "Answer the ownership question directly.",
          openRisks: ["Retry ownership is not defined."],
          currentQuestion: {
            id: "q_architecture",
            text: "Which service owns payment retry orchestration?",
            rationale: "This boundary controls failure handling.",
            recommendation: "Keep retry orchestration inside the payments domain.",
            recommendationReasoning:
              "It keeps retry semantics near the actual payment state machine."
          }
        },
        "release-risk": {
          status: "checkpoint",
          currentUnderstanding:
            "The rollout plan needs an approval gate before production exposure.",
          recommendation: "Approve the staged rollout gate.",
          openRisks: ["Production rollback steps are not explicit."],
          decisionsNeeded: ["Approve the staged rollout gate before implementation begins"]
        },
        operability: {
          status: "finalized",
          currentUnderstanding: "Operability review is complete.",
          recommendation: "Carry the existing test additions into implementation."
        }
      }),
      continueOutcomes: {
        run_b_architecture: buildSnapshot({
          sessionId: "run_b_architecture",
          label: "architecture",
          lens: "architecture and boundary quality",
          status: "checkpoint",
          currentUnderstanding: "The workflow now has a proposed boundary split to review.",
          recommendation: "Approve the updated API and payments split.",
          openRisks: ["Rollback ownership still needs to be documented."],
          decisionsNeeded: ["Approve the updated API and payments split"]
        })
      }
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const started = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);
    const updated = await engine.handleHumanResponse(
      started.id,
      "run_b_architecture",
      "Keep retry orchestration in the payments domain.",
      {
        approvedBy: "jenkins",
        decision: "approve"
      }
    );

    expect(runtime.responses).toEqual([
      {
        sessionId: "run_b_architecture",
        response: "Keep retry orchestration in the payments domain."
      }
    ]);
    expect(runtime.listRunEventsCalls).toEqual([
      "run_b_requirements",
      "run_b_architecture",
      "run_b_release-risk",
      "run_b_operability",
      "run_b_architecture"
    ]);

    const architectureChild = updated.childSessions.find(
      (child) => child.sessionId === "run_b_architecture"
    );
    expect(architectureChild?.state).toBe("human_blocked");
    expect(architectureChild?.snapshot.session.status).toBe("checkpoint");
    expect(architectureChild?.latestBrief).toMatchObject({
      kind: "human_blocked",
      recommendedDirection: "Approve the updated API and payments split."
    });
    expect(architectureChild?.latestBrief?.questions).toEqual([
      "Approve the updated API and payments split"
    ]);

    const escalation = updated.escalations.find(
      (candidate) => candidate.label === "architecture"
    );
    expect(escalation?.questions).toEqual([
      "Approve the updated API and payments split"
    ]);

    const persisted = await engine.getWorkflowRun(started.id);
    expect(persisted).toEqual(updated);
  });

  it("rejects a foreign child session before calling continueSession", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: buildWorkflowSnapshots("run_c", {
        requirements: {
          status: "grounding",
          currentUnderstanding: "Requirements review is in progress.",
          recommendation: "Continue reviewing the draft."
        },
        architecture: {
          status: "waiting_for_human",
          currentUnderstanding: "The boundary is still unresolved.",
          recommendation: "Answer the ownership question directly."
        },
        "release-risk": {
          status: "checkpoint",
          currentUnderstanding: "The rollout plan needs approval.",
          recommendation: "Approve the rollout gate."
        },
        operability: {
          status: "finalized",
          currentUnderstanding: "Operability review is complete.",
          recommendation: "Carry the existing test additions into implementation."
        }
      })
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const started = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);

    await expect(
      engine.handleHumanResponse(started.id, "foreign_session", "answer")
    ).rejects.toThrow(
      `Workflow child foreign_session does not belong to workflow run ${started.id}.`
    );
    expect(runtime.responses).toEqual([]);

    const persisted = await engine.getWorkflowRun(started.id);
    expect(persisted?.status).toBe("partially_blocked");
  });

  it("preserves settledAt when refreshing an already settled workflow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T10:00:00.000Z"));

    const runtime = new FakeWorkflowRuntime({
      createOutcomes: buildWorkflowSnapshots("run_d", {
        requirements: {
          status: "finalized",
          currentUnderstanding: "Requirements review is complete.",
          recommendation: "Proceed."
        },
        architecture: {
          status: "finalized",
          currentUnderstanding: "Architecture review is complete.",
          recommendation: "Proceed."
        },
        "release-risk": {
          status: "finalized",
          currentUnderstanding: "Release risk review is complete.",
          recommendation: "Proceed."
        },
        operability: {
          status: "finalized",
          currentUnderstanding: "Operability review is complete.",
          recommendation: "Proceed."
        }
      })
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const started = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);
    const originalSettledAt = started.settledAt;

    vi.setSystemTime(new Date("2026-04-28T11:00:00.000Z"));

    const refreshed = await engine.refreshWorkflow(started.id);

    expect(started.status).toBe("settled");
    expect(originalSettledAt).toBe("2026-04-28T10:00:00.000Z");
    expect(refreshed.status).toBe("settled");
    expect(refreshed.settledAt).toBe(originalSettledAt);
    expect(refreshed.updatedAt).toBe("2026-04-28T11:00:00.000Z");
  });

  it("updates launch failures to a deterministic blocked state instead of leaving launching", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: [
        buildSnapshot({
          sessionId: "run_e_requirements",
          label: "requirements",
          lens: "requirements and ambiguity gaps",
          status: "grounding",
          currentUnderstanding: "Requirements review is in progress.",
          recommendation: "Continue reviewing the draft."
        }),
        new Error("provider failed during architecture launch")
      ]
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    await expect(
      engine.startWorkflow("parallel_existing_spec_review", workflowInput)
    ).rejects.toThrow("provider failed during architecture launch");

    const [run] = await engine.listWorkflowRuns();
    expect(run?.status).toBe("partially_blocked");
    expect(run?.summary).toMatchObject({
      totalChildren: 4,
      runningChildren: 1,
      humanBlockedChildren: 0,
      finalizedChildren: 0,
      erroredChildren: 0
    });
  });

  it("restores the prior workflow status when continueSession fails", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: buildWorkflowSnapshots("run_f", {
        requirements: {
          status: "grounding",
          currentUnderstanding: "Requirements review is in progress.",
          recommendation: "Continue reviewing the draft."
        },
        architecture: {
          status: "waiting_for_human",
          currentUnderstanding: "The boundary is still unresolved.",
          recommendation: "Answer the ownership question directly."
        },
        "release-risk": {
          status: "checkpoint",
          currentUnderstanding: "The rollout plan needs approval.",
          recommendation: "Approve the rollout gate."
        },
        operability: {
          status: "finalized",
          currentUnderstanding: "Operability review is complete.",
          recommendation: "Carry the existing test additions into implementation."
        }
      }),
      continueOutcomes: {
        run_f_architecture: new Error("continue failed")
      }
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const started = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);

    await expect(
      engine.handleHumanResponse(
        started.id,
        "run_f_architecture",
        "Keep retry orchestration in the payments domain."
      )
    ).rejects.toThrow("continue failed");

    const persisted = await engine.getWorkflowRun(started.id);
    expect(persisted?.status).toBe(started.status);
  });

  it("keeps child sessions and escalations scoped to each workflow run", async () => {
    const runtime = new FakeWorkflowRuntime({
      createOutcomes: [
        ...buildWorkflowSnapshots("run_g", {
          requirements: {
            status: "grounding",
            currentUnderstanding: "Run G requirements review is in progress.",
            recommendation: "Continue reviewing the draft."
          },
          architecture: {
            status: "waiting_for_human",
            currentUnderstanding: "Run G architecture needs an answer.",
            recommendation: "Answer the ownership question directly."
          },
          "release-risk": {
            status: "checkpoint",
            currentUnderstanding: "Run G release risk needs approval.",
            recommendation: "Approve the rollout gate."
          },
          operability: {
            status: "finalized",
            currentUnderstanding: "Run G operability review is complete.",
            recommendation: "Carry the existing test additions into implementation."
          }
        }),
        ...buildWorkflowSnapshots("run_h", {
          requirements: {
            status: "finalized",
            currentUnderstanding: "Run H requirements review is complete.",
            recommendation: "Proceed."
          },
          architecture: {
            status: "finalized",
            currentUnderstanding: "Run H architecture review is complete.",
            recommendation: "Proceed."
          },
          "release-risk": {
            status: "finalized",
            currentUnderstanding: "Run H release risk review is complete.",
            recommendation: "Proceed."
          },
          operability: {
            status: "finalized",
            currentUnderstanding: "Run H operability review is complete.",
            recommendation: "Proceed."
          }
        })
      ]
    });
    const persistence = new FakeWorkflowPersistence();
    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime,
      persistence
    });

    const first = await engine.startWorkflow("parallel_existing_spec_review", workflowInput);
    const second = await engine.startWorkflow("parallel_existing_spec_review", {
      ...workflowInput,
      title: "Checkout spec review 2"
    });

    expect(first.childSessions).toHaveLength(4);
    expect(second.childSessions).toHaveLength(4);
    expect(first.childSessions.every((child) => child.sessionId.startsWith("run_g_"))).toBe(true);
    expect(second.childSessions.every((child) => child.sessionId.startsWith("run_h_"))).toBe(true);

    const firstPersisted = await engine.getWorkflowRun(first.id);
    const secondPersisted = await engine.getWorkflowRun(second.id);

    expect(firstPersisted?.childSessions.every((child) => child.sessionId.startsWith("run_g_"))).toBe(
      true
    );
    expect(secondPersisted?.childSessions.every((child) => child.sessionId.startsWith("run_h_"))).toBe(
      true
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
});

class FakeWorkflowRuntime implements WorkflowRuntime {
  readonly createdTemplates: SessionTemplate[] = [];
  readonly listRunEventsCalls: string[] = [];
  readonly responses: Array<{ sessionId: string; response: string }> = [];
  private readonly snapshotsBySessionId = new Map<string, WorkflowSessionSnapshot>();
  private createOutcomes: Array<WorkflowSessionSnapshot | Error>;
  private readonly continueOutcomes: Map<string, WorkflowSessionSnapshot | Error>;

  constructor(input: {
    createOutcomes: Array<WorkflowSessionSnapshot | Error>;
    continueOutcomes?: Record<string, WorkflowSessionSnapshot | Error>;
  }) {
    this.createOutcomes = input.createOutcomes.slice();
    this.continueOutcomes = new Map(Object.entries(input.continueOutcomes ?? {}));
  }

  async createSession(template: SessionTemplate) {
    this.createdTemplates.push(template);
    const outcome = this.createOutcomes.shift();

    if (!outcome) {
      throw new Error(`No fake create outcome configured for template ${template.label}.`);
    }

    if (outcome instanceof Error) {
      throw outcome;
    }

    const snapshot = outcome;

    expect(snapshot.label).toBe(template.label);

    this.snapshotsBySessionId.set(snapshot.sessionId, snapshot);

    return {
      snapshot
    };
  }

  async getSession(sessionId: string) {
    return {
      snapshot: this.requireSnapshot(sessionId)
    };
  }

  async listRunEvents(sessionId: string) {
    this.listRunEventsCalls.push(sessionId);
    return [];
  }

  subscribeProgress(_listener: (event: { sessionId: string; runId?: string }) => void) {
    return () => {};
  }

  async continueSession(sessionId: string, response: string) {
    this.responses.push({ sessionId, response });
    const outcome = this.continueOutcomes.get(sessionId);

    if (!outcome) {
      throw new Error(`No fake continued snapshot configured for session ${sessionId}.`);
    }

    if (outcome instanceof Error) {
      throw outcome;
    }

    const nextSnapshot = outcome;

    this.snapshotsBySessionId.set(sessionId, nextSnapshot);

    return {
      snapshot: nextSnapshot
    };
  }

  private requireSnapshot(sessionId: string): WorkflowSessionSnapshot {
    const snapshot = this.snapshotsBySessionId.get(sessionId);

    if (!snapshot) {
      throw new Error(`Unknown fake session ${sessionId}.`);
    }

    return snapshot;
  }
}

class FakeWorkflowPersistence implements WorkflowPersistence {
  private workflowRuns: Array<Omit<WorkflowRunView, "childSessions" | "escalations">> = [];
  private childSessionsByRunId = new Map<string, WorkflowRunView["childSessions"]>();
  private escalationRecords: Array<{
    workflowRunId: string;
    sessionId: string;
    brief: WorkflowRunView["escalations"][number];
  }> = [];

  async createWorkflowRun(run: Omit<WorkflowRunView, "childSessions" | "escalations">) {
    this.workflowRuns.push(clone(run));
  }

  async updateWorkflowRun(run: Omit<WorkflowRunView, "childSessions" | "escalations">) {
    const existingIndex = this.workflowRuns.findIndex((candidate) => candidate.id === run.id);

    if (existingIndex >= 0) {
      this.workflowRuns[existingIndex] = clone(run);
      return;
    }

    this.workflowRuns.push(clone(run));
  }

  async upsertChildSession(workflowRunId: string, childSession: WorkflowRunView["childSessions"][number]) {
    const childSessions = this.childSessionsByRunId.get(workflowRunId) ?? [];
    const existingIndex = childSessions.findIndex(
      (candidate) => candidate.sessionId === childSession.sessionId
    );

    if (existingIndex >= 0) {
      childSessions[existingIndex] = clone(childSession);
      this.childSessionsByRunId.set(workflowRunId, childSessions);
      return;
    }

    childSessions.push(clone(childSession));
    this.childSessionsByRunId.set(workflowRunId, childSessions);
  }

  async createEscalation(
    workflowRunId: string,
    sessionId: string,
    brief: WorkflowRunView["escalations"][number]
  ) {
    const existingIndex = this.escalationRecords.findIndex(
      (candidate) => candidate.sessionId === sessionId
    );
    const record = {
      workflowRunId,
      sessionId,
      brief: clone(brief)
    };

    if (existingIndex >= 0) {
      this.escalationRecords[existingIndex] = record;
      return;
    }

    this.escalationRecords.push(record);
  }

  async clearEscalations(workflowRunId: string) {
    this.escalationRecords = this.escalationRecords.filter(
      (candidate) => candidate.workflowRunId !== workflowRunId
    );
  }

  async getWorkflowRun(workflowRunId: string) {
    return clone(
      this.workflowRuns.find((candidate) => candidate.id === workflowRunId) ?? null
    );
  }

  async listWorkflowRuns(filter?: { specId?: string; status?: WorkflowRunView["status"] }) {
    return clone(
      this.workflowRuns.filter((candidate) => {
        if (filter?.specId && candidate.specId !== filter.specId) {
          return false;
        }

        if (filter?.status && candidate.status !== filter.status) {
          return false;
        }

        return true;
      })
    );
  }

  async getWorkflowChildren(workflowRunId: string) {
    if (!this.workflowRuns.some((candidate) => candidate.id === workflowRunId)) {
      return [];
    }

    return clone(this.childSessionsByRunId.get(workflowRunId) ?? []);
  }

  async getWorkflowEscalations(workflowRunId: string) {
    if (!this.workflowRuns.some((candidate) => candidate.id === workflowRunId)) {
      return [];
    }

    return clone(
      this.escalationRecords
        .filter((candidate) => candidate.workflowRunId === workflowRunId)
        .map((candidate) => candidate.brief)
    );
  }
}

function buildWorkflowSnapshots(
  prefix: string,
  input: Record<
    "requirements" | "architecture" | "release-risk" | "operability",
    Omit<Parameters<typeof buildSnapshot>[0], "sessionId" | "label" | "lens">
  >
): WorkflowSessionSnapshot[] {
  return [
    buildSnapshot({
      sessionId: `${prefix}_requirements`,
      label: "requirements",
      lens: "requirements and ambiguity gaps",
      ...input.requirements
    }),
    buildSnapshot({
      sessionId: `${prefix}_architecture`,
      label: "architecture",
      lens: "architecture and boundary quality",
      ...input.architecture
    }),
    buildSnapshot({
      sessionId: `${prefix}_release-risk`,
      label: "release-risk",
      lens: "implementation and rollout risk",
      ...input["release-risk"]
    }),
    buildSnapshot({
      sessionId: `${prefix}_operability`,
      label: "operability",
      lens: "testing, failure modes, and operability",
      ...input.operability
    })
  ];
}

function buildSnapshot(input: {
  sessionId: string;
  label: string;
  lens: string;
  status: WorkflowSessionSnapshot["session"]["status"];
  currentUnderstanding: string;
  recommendation: string;
  openRisks?: string[];
  decisionsNeeded?: string[];
  currentQuestion?: {
    id: string;
    text: string;
    rationale: string;
    recommendation: string;
    recommendationReasoning: string;
  };
}): WorkflowSessionSnapshot {
  return {
    sessionId: input.sessionId,
    label: input.label,
    lens: input.lens,
    session: {
      id: input.sessionId,
      title: `${input.label} review`,
      status: input.status,
      phase: "analysis"
    },
    summary: {
      currentUnderstanding: input.currentUnderstanding,
      recommendation: input.recommendation,
      changedSinceLastCheckpoint: [],
      openRisks: input.openRisks ?? [],
      decisionsNeeded: input.decisionsNeeded ?? []
    },
    interviewState: input.currentQuestion
      ? {
          questions: [],
          currentQuestion: {
            id: input.currentQuestion.id,
            text: input.currentQuestion.text,
            rationale: input.currentQuestion.rationale,
            context: null,
            recommendation: input.currentQuestion.recommendation,
            recommendationReasoning: input.currentQuestion.recommendationReasoning
          },
          totalQuestions: 1,
          answeredCount: 0
        }
      : undefined,
    activeRun: null,
    recentRuns: []
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
