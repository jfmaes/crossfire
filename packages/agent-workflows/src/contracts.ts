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

export type WorkflowRunStatus = CrossfireSessionStatus;

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

export interface WorkflowRunSnapshot {
  id: string;
  status: WorkflowRunStatus;
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
  activeRun?: WorkflowRunSnapshot | null;
  recentRuns?: WorkflowRunSnapshot[];
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

export interface WorkflowSpec {
  id: WorkflowSpecId;
  description: string;
  buildSessionTemplates(input: ExistingSpecWorkflowInput): SessionTemplate[];
}
