import type {
  RecommendationBrief,
  WorkflowChildView,
  WorkflowRunFilter,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowRunView,
  WorkflowRuntime,
  WorkflowSessionResult,
  WorkflowSpec
} from "../contracts";
import { buildRecommendationBrief } from "./build-recommendation-brief";
import { classifyChildSession } from "./classify-child-session";

type AnyWorkflowSpec = WorkflowSpec<string, unknown>;

type WorkflowSpecIdOf<TSpecs extends readonly AnyWorkflowSpec[]> = TSpecs[number]["id"];

type WorkflowInputForId<
  TSpecs extends readonly AnyWorkflowSpec[],
  TSpecId extends WorkflowSpecIdOf<TSpecs>
> = Extract<TSpecs[number], { id: TSpecId }> extends WorkflowSpec<TSpecId, infer TInput>
  ? TInput
  : never;

export function createWorkflowEngine<TSpecs extends readonly AnyWorkflowSpec[]>(input: {
  specs: TSpecs;
  runtime: WorkflowRuntime;
  persistence: WorkflowPersistence;
}) {
  const specsById = new Map<string, AnyWorkflowSpec>(
    input.specs.map((spec) => [spec.id, spec] as const)
  );

  return {
    startWorkflow,
    listWorkflowRuns,
    getWorkflowRun,
    refreshWorkflow,
    handleHumanResponse
  };

  async function requireWorkflowRun(workflowRunId: string) {
    const workflowRun = await input.persistence.getWorkflowRun(workflowRunId);

    if (!workflowRun) {
      throw new Error(`Workflow run ${workflowRunId} was not found.`);
    }

    return workflowRun;
  }

  async function startWorkflow<TSpecId extends WorkflowSpecIdOf<TSpecs>>(
    specId: TSpecId,
    workflowInput: WorkflowInputForId<TSpecs, TSpecId>
  ): Promise<WorkflowRunView<TSpecId, WorkflowInputForId<TSpecs, TSpecId>>> {
    const spec = specsById.get(specId) as WorkflowSpec<TSpecId, WorkflowInputForId<TSpecs, TSpecId>> | undefined;

    if (!spec) {
      throw new Error(`Unknown workflow spec: ${specId}`);
    }

    const templates = spec.buildSessionTemplates(workflowInput);
    const workflowRunId = crypto.randomUUID();
    const startedAt = nowIso();
    const initialRun: WorkflowRunRecord<TSpecId, WorkflowInputForId<TSpecs, TSpecId>> = {
      id: workflowRunId,
      specId,
      status: "launching",
      input: workflowInput,
      summary: buildSummary([], templates.length, 0),
      createdAt: startedAt,
      updatedAt: startedAt,
      settledAt: null
    };

    await input.persistence.createWorkflowRun(initialRun);

    const childSessions: WorkflowChildView[] = [];
    try {
      for (const template of templates) {
        const result = await input.runtime.createSession(template);
        const childSession = await buildChildView(input.runtime, result, template, null);
        childSessions.push(childSession);
        await input.persistence.upsertChildSession(workflowRunId, childSession);
      }

      const escalations = buildEscalations(childSessions);
      const finalizedRun = buildRunRecord(initialRun, childSessions, escalations, templates.length);

      await persistEscalations(workflowRunId, childSessions);
      await input.persistence.updateWorkflowRun(finalizedRun);

      return {
        ...finalizedRun,
        childSessions,
        escalations
      };
    } catch (error) {
      const failedRun = buildRunRecord(
        initialRun,
        childSessions,
        buildEscalations(childSessions),
        templates.length,
        "partially_blocked"
      );

      await persistEscalations(workflowRunId, childSessions);
      await input.persistence.updateWorkflowRun(failedRun);

      throw error;
    }
  }

  async function getWorkflowRun(
    workflowRunId: string
  ): Promise<WorkflowRunView | null> {
    const run = await input.persistence.getWorkflowRun(workflowRunId);

    if (!run) {
      return null;
    }

    const [children, escalations] = await Promise.all([
      input.persistence.getWorkflowChildren(workflowRunId),
      input.persistence.getWorkflowEscalations(workflowRunId)
    ]);

    return {
      ...run,
      childSessions: children,
      escalations
    };
  }

  async function listWorkflowRuns(filter?: WorkflowRunFilter): Promise<WorkflowRunView[]> {
    const runs = await input.persistence.listWorkflowRuns(filter);

    return Promise.all(
      runs.map(async (run) => {
        const [childSessions, escalations] = await Promise.all([
          input.persistence.getWorkflowChildren(run.id),
          input.persistence.getWorkflowEscalations(run.id)
        ]);

        return {
          ...run,
          childSessions,
          escalations
        };
      })
    );
  }

  async function refreshWorkflow(
    workflowRunId: string,
    sessionId?: string
  ): Promise<WorkflowRunView> {
    return refreshWorkflowInternal(workflowRunId, { sessionId });
  }

  async function handleHumanResponse(
    workflowRunId: string,
    sessionId: string,
    response: string,
    _approvalMetadata?: Record<string, unknown>
  ): Promise<WorkflowRunView> {
    const existingRun = await requireWorkflowRun(workflowRunId);
    const existingChildren = await input.persistence.getWorkflowChildren(workflowRunId);
    const selectedChild = existingChildren.find((candidate) => candidate.sessionId === sessionId);

    if (!selectedChild) {
      throw new Error(
        `Workflow child ${sessionId} does not belong to workflow run ${workflowRunId}.`
      );
    }

    await input.persistence.updateWorkflowRun({
      ...existingRun,
      status: "resuming",
      updatedAt: nowIso()
    });

    try {
      const continued = await input.runtime.continueSession(sessionId, response);

      return refreshWorkflowInternal(workflowRunId, {
        sessionId: selectedChild.sessionId,
        prefetchedResult: continued
      });
    } catch (error) {
      await input.persistence.updateWorkflowRun({
        ...existingRun,
        updatedAt: nowIso()
      });

      throw error;
    }
  }

  async function refreshWorkflowInternal(
    workflowRunId: string,
    options: {
      sessionId?: string;
      prefetchedResult?: WorkflowSessionResult | void;
    }
  ): Promise<WorkflowRunView> {
    const existingRun = await requireWorkflowRun(workflowRunId);
    const existingChildren = await input.persistence.getWorkflowChildren(workflowRunId);

    if (options.sessionId) {
      const child = existingChildren.find((candidate) => candidate.sessionId === options.sessionId);

      if (!child) {
        throw new Error(
          `Workflow child ${options.sessionId} does not belong to workflow run ${workflowRunId}.`
        );
      }
    }

    const refreshedChildren = await Promise.all(
      existingChildren.map(async (child) => {
        if (options.sessionId && child.sessionId !== options.sessionId) {
          return child;
        }

        const result =
          options.sessionId && child.sessionId === options.sessionId && options.prefetchedResult
            ? options.prefetchedResult
            : await input.runtime.getSession(child.sessionId);

        return await buildChildView(
          input.runtime,
          result,
          {
            label: child.label,
            lens: child.lens
          },
          child
        );
      })
    );

    const escalations = buildEscalations(refreshedChildren);
    const updatedRun = buildRunRecord(
      existingRun,
      refreshedChildren,
      escalations,
      existingRun.summary.totalChildren
    );

    for (const childSession of refreshedChildren) {
      await input.persistence.upsertChildSession(workflowRunId, childSession);
    }
    await persistEscalations(workflowRunId, refreshedChildren);
    await input.persistence.updateWorkflowRun(updatedRun);

    return {
      ...updatedRun,
      childSessions: refreshedChildren,
      escalations
    };
  }

  async function persistEscalations(workflowRunId: string, childSessions: WorkflowChildView[]) {
    await input.persistence.clearEscalations(workflowRunId);
    for (const childSession of childSessions) {
      if (childSession.latestBrief) {
        await input.persistence.createEscalation(
          workflowRunId,
          childSession.sessionId,
          childSession.latestBrief
        );
      }
    }
  }
}

async function buildChildView(
  runtime: WorkflowRuntime,
  result: WorkflowSessionResult,
  template: { label: string; lens: string },
  existingChild: WorkflowChildView | null
): Promise<WorkflowChildView> {
  const events = await runtime.listRunEvents(result.snapshot.sessionId);
  const classification = classifyChildSession(result.snapshot, events);
  const latestBrief = buildRecommendationBrief(result.snapshot, classification);
  const timestamp = nowIso();

  return {
    sessionId: result.snapshot.sessionId,
    label: template.label,
    lens: template.lens,
    state: classification.state,
    classification,
    latestRunId: result.snapshot.activeRun?.id ?? result.snapshot.recentRuns?.[0]?.id ?? null,
    latestBrief,
    snapshot: result.snapshot,
    createdAt: existingChild?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function buildEscalations(
  childSessions: WorkflowChildView[]
): RecommendationBrief[] {
  return childSessions.flatMap((childSession) => childSession.latestBrief ?? []);
}

function buildRunRecord<TSpecId extends string, TInput>(
  run: WorkflowRunRecord<TSpecId, TInput>,
  childSessions: WorkflowChildView[],
  escalations: RecommendationBrief[],
  totalChildren: number,
  statusOverride?: WorkflowRunStatus
): WorkflowRunRecord<TSpecId, TInput> {
  const timestamp = nowIso();
  const status = statusOverride ?? getAggregateStatus(childSessions);

  return {
    ...run,
    status,
    summary: buildSummary(childSessions, totalChildren, escalations.length),
    updatedAt: timestamp,
    settledAt: run.settledAt ?? (status === "settled" ? timestamp : null)
  };
}

function buildSummary(
  children: WorkflowChildView[],
  totalChildren: number,
  escalationCount: number
): WorkflowRunSummary {
  return {
    totalChildren,
    runningChildren: countChildren(children, "running"),
    humanBlockedChildren: countChildren(children, "human_blocked"),
    resumingChildren: countChildren(children, "resuming"),
    finalizedChildren: countChildren(children, "finalized"),
    erroredChildren: countChildren(children, "errored"),
    escalationCount
  };
}

function countChildren(children: WorkflowChildView[], state: WorkflowChildView["state"]): number {
  return children.filter((child) => child.state === state).length;
}

function getAggregateStatus(children: WorkflowChildView[]): WorkflowRunStatus {
  if (children.length === 0) {
    return "planning";
  }

  if (children.every((child) => child.state === "finalized" || child.state === "errored")) {
    return "settled";
  }

  if (children.some((child) => child.state === "resuming")) {
    return "resuming";
  }

  if (children.some((child) => child.state === "human_blocked" || child.state === "errored")) {
    return "partially_blocked";
  }

  return "monitoring";
}

function nowIso(): string {
  return new Date().toISOString();
}
