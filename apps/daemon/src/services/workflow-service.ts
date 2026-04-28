import { randomUUID } from "node:crypto";
import {
  buildRecommendationBrief,
  classifyChildSession,
  createWorkflowEngine,
  parallelExistingSpecReview,
  type ExistingSpecWorkflowInput,
  type RecommendationBrief,
  type WorkflowChildView,
  type WorkflowPersistence,
  type WorkflowRunFilter,
  type WorkflowRunRecord,
  type WorkflowRunView,
  type WorkflowSessionResult,
  type WorkflowSessionSnapshot
} from "@council/agent-workflows";
import { WorkflowRunRepository } from "@council/storage";
import { onProgress } from "./progress";
import { createSessionService } from "./session-service";

interface CreateWorkflowServiceInput {
  sessionService: ReturnType<typeof createSessionService>;
  workflowRunRepository: WorkflowRunRepository;
}

export function createWorkflowService(input: CreateWorkflowServiceInput) {
  const childSessionToWorkflowRunId = new Map<string, string>();
  const refreshQueues = new Map<string, Promise<WorkflowRunView | null>>();
  hydrateMembershipMap();

  const runtime = {
    async createSession(template: {
      label: string;
      lens: string;
      title: string;
      mode: "existing_spec";
      prompt: string;
      existingSpec: {
        spec: string;
        implementationPlan?: string;
      };
    }): Promise<WorkflowSessionResult> {
      const created = await input.sessionService.createSession({
        title: template.title,
        prompt: template.prompt,
        mode: template.mode,
        existingSpec: template.existingSpec
      });

      return {
        snapshot: toWorkflowSessionSnapshot(created, template.label, template.lens)
      };
    },

    async getSession(sessionId: string): Promise<WorkflowSessionResult> {
      return getWorkflowSessionResult(sessionId);
    },

    async continueSession(sessionId: string, response: string): Promise<WorkflowSessionResult> {
      const continued = await input.sessionService.continueSession({
        id: sessionId,
        humanResponse: response
      });

      if (!continued) {
        throw new Error(`Crossfire session ${sessionId} was not found.`);
      }

      const child = findPersistedChildSession(sessionId);
      return {
        snapshot: toWorkflowSessionSnapshot(
          continued,
          child?.label ?? "workflow-child",
          child?.lens ?? "workflow child"
        )
      };
    },

    async listRunEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
      const session = await input.sessionService.getSession(sessionId);
      const runId = session?.activeRun?.id ?? session?.recentRuns?.[0]?.id;

      if (!runId) {
        return [];
      }

      return input.sessionService
        .listRunEvents(runId)
        .map((event) => ({ ...event })) as Array<Record<string, unknown>>;
    },

    subscribeProgress(listener: (event: { sessionId: string; runId?: string }) => void) {
      return onProgress((event) => listener({ sessionId: event.sessionId, runId: event.runId }));
    }
  };

  const persistence: WorkflowPersistence = {
    async createWorkflowRun(run: WorkflowRunRecord) {
      input.workflowRunRepository.createWorkflowRun({
        id: run.id,
        specId: run.specId,
        status: run.status,
        input: asRecord(run.input),
        summary: asRecord(run.summary),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        settledAt: run.settledAt ?? null
      });
    },

    async updateWorkflowRun(run: WorkflowRunRecord) {
      input.workflowRunRepository.updateWorkflowRun({
        id: run.id,
        status: run.status,
        summary: asRecord(run.summary),
        updatedAt: run.updatedAt,
        settledAt: run.settledAt
      });
    },

    async upsertChildSession(workflowRunId: string, childSession: WorkflowChildView) {
      childSessionToWorkflowRunId.set(childSession.sessionId, workflowRunId);
      input.workflowRunRepository.upsertChildSession({
        workflowRunId,
        sessionId: childSession.sessionId,
        label: childSession.label,
        lens: childSession.lens,
        state: childSession.state,
        latestRunId: childSession.latestRunId ?? null,
        escalationId: null,
        createdAt: childSession.createdAt,
        updatedAt: childSession.updatedAt
      });
    },

    async createEscalation(workflowRunId: string, sessionId: string, brief: RecommendationBrief) {
      input.workflowRunRepository.createEscalation({
        id: randomUUID(),
        workflowRunId,
        sessionId,
        kind: brief.kind,
        status: "open",
        brief: asRecord(brief),
        resolution: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    },

    async clearEscalations(workflowRunId: string) {
      input.workflowRunRepository.clearEscalations(workflowRunId);
    },

    async getWorkflowRun(workflowRunId: string): Promise<WorkflowRunRecord | null> {
      const run = input.workflowRunRepository.findWorkflowRunById(workflowRunId);
      return run ? toWorkflowRunRecord(run) : null;
    },

    async listWorkflowRuns(filter?: WorkflowRunFilter): Promise<WorkflowRunRecord[]> {
      return input.workflowRunRepository.listWorkflowRuns(filter).map(toWorkflowRunRecord);
    },

    async getWorkflowChildren(workflowRunId: string): Promise<WorkflowChildView[]> {
      const childRows = input.workflowRunRepository.findChildSessions(workflowRunId);
      return Promise.all(
        childRows.map(async (childRow) => {
          childSessionToWorkflowRunId.set(childRow.sessionId, workflowRunId);
          return loadWorkflowChildView(childRow);
        })
      );
    },

    async getWorkflowEscalations(workflowRunId: string): Promise<RecommendationBrief[]> {
      return input.workflowRunRepository
        .findEscalations(workflowRunId)
        .map((row) => toRecommendationBrief(row.brief));
    }
  };

  const engine = createWorkflowEngine({
    specs: [parallelExistingSpecReview],
    runtime,
    persistence
  });

  const unsubscribeProgress = runtime.subscribeProgress(({ sessionId }) => {
    const workflowRunId = childSessionToWorkflowRunId.get(sessionId);

    if (!workflowRunId) {
      return;
    }

    void reconcileWorkflowRun(workflowRunId, {
      sessionId,
      suppressErrors: true
    });
  });

  return {
    startParallelExistingSpecReview(inputValue: ExistingSpecWorkflowInput) {
      return engine.startWorkflow("parallel_existing_spec_review", inputValue);
    },

    async getWorkflowRun(id: string) {
      const persisted = input.workflowRunRepository.findWorkflowRunById(id);

      if (!persisted) {
        return null;
      }

      if (persisted.status !== "settled") {
        return reconcileWorkflowRun(id);
      }

      return engine.getWorkflowRun(id);
    },

    async listWorkflowRuns(filter?: WorkflowRunFilter) {
      const persistedRuns = input.workflowRunRepository.listWorkflowRuns(
        filter?.specId ? { specId: filter.specId } : undefined
      );

      for (const run of persistedRuns) {
        if (run.status !== "settled") {
          await reconcileWorkflowRun(run.id);
        }
      }

      const listedRuns = await engine.listWorkflowRuns(
        filter?.specId ? { specId: filter.specId } : undefined
      );

      return listedRuns.filter((run) => {
        if (filter?.status && run.status !== filter.status) {
          return false;
        }

        return true;
      });
    },

    handleHumanResponse(
      workflowRunId: string,
      sessionId: string,
      response: string,
      approvalMetadata?: Record<string, unknown>
    ) {
      return engine.handleHumanResponse(
        workflowRunId,
        sessionId,
        response,
        approvalMetadata
      );
    },

    dispose() {
      unsubscribeProgress();
    }
  };

  function hydrateMembershipMap() {
    for (const run of input.workflowRunRepository.listWorkflowRuns()) {
      for (const child of input.workflowRunRepository.findChildSessions(run.id)) {
        childSessionToWorkflowRunId.set(child.sessionId, run.id);
      }
    }
  }

  function reconcileWorkflowRun(
    workflowRunId: string,
    options?: { sessionId?: string; suppressErrors?: boolean }
  ): Promise<WorkflowRunView | null> {
    const pending = refreshQueues.get(workflowRunId) ?? Promise.resolve<WorkflowRunView | null>(null);
    const next = pending
      .catch((error) => {
        if (options?.suppressErrors) {
          console.error(
            `Failed to refresh workflow ${workflowRunId}${options.sessionId ? ` for session ${options.sessionId}` : ""}:`,
            error
          );
          return null;
        }

        throw error;
      })
      .then(async () => {
        const latestPersisted = input.workflowRunRepository.findWorkflowRunById(workflowRunId);

        if (!latestPersisted) {
          return null;
        }

        if (latestPersisted.status === "settled") {
          return engine.getWorkflowRun(workflowRunId);
        }

        return engine.refreshWorkflow(workflowRunId, options?.sessionId);
      })
      .finally(() => {
        if (refreshQueues.get(workflowRunId) === next) {
          refreshQueues.delete(workflowRunId);
        }
      });

    refreshQueues.set(workflowRunId, next);
    return next;
  }

  function findPersistedChildSession(sessionId: string) {
    const workflowRunId = childSessionToWorkflowRunId.get(sessionId);

    if (!workflowRunId) {
      return null;
    }

    return input.workflowRunRepository
      .findChildSessions(workflowRunId)
      .find((child) => child.sessionId === sessionId) ?? null;
  }

  async function getWorkflowSessionResult(sessionId: string): Promise<WorkflowSessionResult> {
    const session = await input.sessionService.getSession(sessionId);

    if (!session) {
      throw new Error(`Crossfire session ${sessionId} was not found.`);
    }

    const child = findPersistedChildSession(sessionId);

    return {
      snapshot: toWorkflowSessionSnapshot(
        session,
        child?.label ?? "workflow-child",
        child?.lens ?? "workflow child"
      )
    };
  }

  async function loadWorkflowChildView(childRow: {
    sessionId: string;
    label: string;
    lens: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<WorkflowChildView> {
    const result = await getWorkflowSessionResult(childRow.sessionId);
    const events = await runtime.listRunEvents(childRow.sessionId);
    const classification = classifyChildSession(result.snapshot, events);

    return {
      sessionId: childRow.sessionId,
      label: childRow.label,
      lens: childRow.lens,
      state: classification.state,
      classification,
      latestRunId: result.snapshot.activeRun?.id ?? result.snapshot.recentRuns?.[0]?.id ?? null,
      latestBrief: buildRecommendationBrief(result.snapshot, classification),
      snapshot: result.snapshot,
      createdAt: childRow.createdAt,
      updatedAt: childRow.updatedAt
    };
  }
}

function toWorkflowSessionSnapshot(
  payload: Awaited<ReturnType<ReturnType<typeof createSessionService>["getSession"]>> extends infer T
    ? NonNullable<T>
    : never,
  label: string,
  lens: string
): WorkflowSessionSnapshot {
  return {
    sessionId: payload.session.id,
    label,
    lens,
    session: {
      id: payload.session.id,
      title: payload.session.title,
      status: payload.session.status as WorkflowSessionSnapshot["session"]["status"],
      phase: payload.session.phase ?? null
    },
    summary: payload.summary
      ? {
          currentUnderstanding: payload.summary.currentUnderstanding,
          recommendation: payload.summary.recommendation,
          changedSinceLastCheckpoint: payload.summary.changedSinceLastCheckpoint,
          openRisks: payload.summary.openRisks,
          decisionsNeeded: payload.summary.decisionsNeeded
        }
      : undefined,
    interviewState: payload.interviewState
      ? {
          questions: payload.interviewState.questions.map((question) => ({
            id: question.id,
            text: question.text,
            answer: question.answer
          })),
          currentQuestion: payload.interviewState.currentQuestion
            ? {
                id: payload.interviewState.currentQuestion.id,
                text: payload.interviewState.currentQuestion.text,
                rationale: payload.interviewState.currentQuestion.rationale,
                context: payload.interviewState.currentQuestion.context ?? null,
                recommendation: payload.interviewState.currentQuestion.recommendation ?? null,
                recommendationReasoning:
                  payload.interviewState.currentQuestion.recommendationReasoning ?? null
              }
            : null,
          totalQuestions: payload.interviewState.totalQuestions,
          answeredCount: payload.interviewState.answeredCount
        }
      : undefined,
    activeRun: payload.activeRun ? toWorkflowRunSnapshot(payload.activeRun) : null,
    recentRuns: payload.recentRuns?.map(toWorkflowRunSnapshot) ?? []
  };
}

function toWorkflowRunSnapshot(run: {
  id: string;
  status: string;
  phase?: string | null;
  errorMessage?: string | null;
}) {
  return {
    id: run.id,
    status: run.status === "running"
      ? "running"
      : run.status === "failed"
        ? "errored"
        : "finalized",
    phase: run.phase ?? null,
    errorMessage: run.errorMessage ?? null
  } as const;
}

function toWorkflowRunRecord(run: {
  id: string;
  specId: string;
  status: string;
  input: Record<string, unknown>;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  settledAt?: string | null;
}): WorkflowRunRecord {
  return {
    id: run.id,
    specId: run.specId,
    status: run.status as WorkflowRunView["status"],
    input: run.input,
    summary: toWorkflowRunSummary(run.summary),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    settledAt: run.settledAt ?? null
  };
}

function toRecommendationBrief(value: Record<string, unknown>): RecommendationBrief {
  return value as unknown as RecommendationBrief;
}

function toWorkflowRunSummary(value: Record<string, unknown>): WorkflowRunView["summary"] {
  return value as unknown as WorkflowRunView["summary"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
