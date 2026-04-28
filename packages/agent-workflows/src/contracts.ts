export type WorkflowSpecId = "parallel_existing_spec_review";

export type CrossfireSessionStatus =
  | "draft"
  | "grounding"
  | "debating"
  | "checkpoint"
  | "waiting_for_human"
  | "interviewing"
  | "finalized"
  | "errored";

export type CrossfireRunStatus = "running" | "finalized" | "errored";

export type WorkflowRunStatus =
  | "planning"
  | "launching"
  | "monitoring"
  | "partially_blocked"
  | "resuming"
  | "settled";

export type WorkflowChildState =
  | "running"
  | "human_blocked"
  | "resuming"
  | "finalized"
  | "errored";

export type WorkflowErrorState =
  | "recoverable_transient"
  | "recoverable_operator"
  | "terminal";

export interface ExistingSpecWorkflowInput {
  title: string;
  prompt?: string;
  existingSpec: {
    spec: string;
    implementationPlan?: string;
  };
}

export interface SessionTemplate {
  label: string;
  lens: string;
  title: string;
  mode: "existing_spec";
  prompt: string;
  existingSpec: {
    spec: string;
    implementationPlan?: string;
  };
}

export interface WorkflowSessionSummary {
  currentUnderstanding: string;
  recommendation: string;
  changedSinceLastCheckpoint: string[];
  openRisks: string[];
  decisionsNeeded: string[];
}

export interface WorkflowInterviewQuestion {
  id: string;
  text: string;
  answer: string | null;
}

export interface WorkflowCurrentQuestion {
  id: string;
  text: string;
  rationale: string;
  context?: string | null;
  recommendation?: string | null;
  recommendationReasoning?: string | null;
}

export interface WorkflowInterviewState {
  questions: WorkflowInterviewQuestion[];
  currentQuestion?: WorkflowCurrentQuestion | null;
  totalQuestions: number;
  answeredCount: number;
}

export interface CrossfireRunSnapshot {
  id: string;
  status: CrossfireRunStatus;
  phase?: string | null;
  errorMessage?: string | null;
}

export interface WorkflowSessionSnapshot {
  sessionId: string;
  label: string;
  lens: string;
  session: {
    id: string;
    title: string;
    status: CrossfireSessionStatus;
    phase?: string | null;
  };
  summary?: WorkflowSessionSummary;
  interviewState?: WorkflowInterviewState;
  activeRun?: CrossfireRunSnapshot | null;
  recentRuns?: CrossfireRunSnapshot[];
}

export interface WorkflowClassification {
  state: WorkflowChildState;
  errorState?: WorkflowErrorState;
  reason: string;
}

export interface RecommendationBrief {
  kind: "human_blocked" | "recovery_needed";
  label: string;
  lens: string;
  summary: string;
  recommendedDirection: string;
  risks: string[];
  questions: string[];
}

export interface WorkflowChildView {
  sessionId: string;
  label: string;
  lens: string;
  state: WorkflowChildState;
  classification: WorkflowClassification;
  latestRunId?: string | null;
  latestBrief?: RecommendationBrief | null;
  snapshot: WorkflowSessionSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEscalationView {
  id: string;
  workflowRunId: string;
  sessionId: string;
  kind: RecommendationBrief["kind"];
  brief: RecommendationBrief;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunSummary {
  totalChildren: number;
  runningChildren: number;
  humanBlockedChildren: number;
  resumingChildren: number;
  finalizedChildren: number;
  erroredChildren: number;
  escalationCount: number;
}

export interface WorkflowRunRecord<TSpecId extends string = string, TInput = unknown> {
  id: string;
  specId: TSpecId;
  status: WorkflowRunStatus;
  input: TInput;
  summary: WorkflowRunSummary;
  createdAt: string;
  updatedAt: string;
  settledAt?: string | null;
}

export interface WorkflowRunFilter {
  specId?: string;
  status?: WorkflowRunStatus;
}

export interface WorkflowRunView<TSpecId extends string = string, TInput = unknown>
  extends WorkflowRunRecord<TSpecId, TInput> {
  childSessions: WorkflowChildView[];
  escalations: RecommendationBrief[];
}

export interface WorkflowSessionResult {
  snapshot: WorkflowSessionSnapshot;
}

export type Awaitable<T> = T | Promise<T>;

export interface WorkflowRuntime {
  createSession(template: SessionTemplate): Awaitable<WorkflowSessionResult>;
  getSession(sessionId: string): Awaitable<WorkflowSessionResult>;
  continueSession(sessionId: string, response: string): Awaitable<WorkflowSessionResult | void>;
  listRunEvents(sessionId: string): Awaitable<Array<Record<string, unknown>>>;
  subscribeProgress(listener: (event: { sessionId: string; runId?: string }) => void): () => void;
}

export interface WorkflowPersistence {
  createWorkflowRun(run: WorkflowRunRecord): Awaitable<void>;
  updateWorkflowRun(run: WorkflowRunRecord): Awaitable<void>;
  upsertChildSession(workflowRunId: string, childSession: WorkflowChildView): Awaitable<void>;
  createEscalation(
    workflowRunId: string,
    sessionId: string,
    brief: RecommendationBrief
  ): Awaitable<void>;
  clearEscalations(workflowRunId: string): Awaitable<void>;
  getWorkflowRun(workflowRunId: string): Awaitable<WorkflowRunRecord | null>;
  listWorkflowRuns(filter?: WorkflowRunFilter): Awaitable<WorkflowRunRecord[]>;
  getWorkflowChildren(workflowRunId: string): Awaitable<WorkflowChildView[]>;
  getWorkflowEscalations(workflowRunId: string): Awaitable<RecommendationBrief[]>;
}

export interface WorkflowSpec<TSpecId extends string = WorkflowSpecId, TInput = ExistingSpecWorkflowInput> {
  id: TSpecId;
  description: string;
  buildSessionTemplates(input: TInput): SessionTemplate[];
}
