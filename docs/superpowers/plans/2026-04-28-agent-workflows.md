# Crossfire Agent Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal `@council/agent-workflows` package and daemon integration that can launch, persist, monitor, and resume multiple Crossfire existing-spec review sessions as one workflow run.

**Architecture:** Keep Crossfire session execution inside the daemon and add a separate workflow control plane package. The workflow package owns spec expansion, child-session classification, recommendation briefs, workflow state, and generic orchestration, while the daemon supplies a runtime adapter and a storage-backed persistence adapter. V1 ships one built-in workflow, `parallel_existing_spec_review`, with no new public HTTP routes.

**Tech Stack:** TypeScript, Fastify daemon internals, workspace packages, SQLite via `better-sqlite3`, Vitest, fake provider adapters

---

### Task 1: Add Workflow Persistence In `@council/storage`

**Files:**
- Modify: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/src/workflow-run-repository.ts`
- Create: `packages/storage/src/workflow-run-repository.test.ts`

- [ ] **Step 1: Write the failing persistence test**

Create `packages/storage/src/workflow-run-repository.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database";
import { WorkflowRunRepository } from "./workflow-run-repository";

describe("WorkflowRunRepository", () => {
  it("persists workflow runs, child sessions, and escalation briefs", () => {
    const repo = new WorkflowRunRepository(createInMemoryDatabase());

    repo.createWorkflowRun({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      status: "monitoring",
      input: {
        title: "Review auth spec",
        prompt: "Focus on release risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      },
      summary: {
        totalChildren: 4,
        runningChildren: 4,
        blockedChildren: 0,
        finalizedChildren: 0,
        erroredChildren: 0
      },
      createdAt: "2026-04-28T10:00:00.000Z",
      updatedAt: "2026-04-28T10:00:00.000Z",
      settledAt: null
    });

    repo.upsertChildSession({
      workflowRunId: "wf_1",
      sessionId: "sess_1",
      label: "release-risk",
      lens: "implementation and rollout risk",
      state: "human_blocked",
      latestRunId: "run_1",
      escalationId: null,
      createdAt: "2026-04-28T10:00:01.000Z",
      updatedAt: "2026-04-28T10:00:02.000Z"
    });

    repo.createEscalation({
      id: "esc_1",
      workflowRunId: "wf_1",
      sessionId: "sess_1",
      kind: "human_blocked",
      status: "open",
      brief: {
        kind: "human_blocked",
        label: "release-risk",
        lens: "implementation and rollout risk",
        summary: "Crossfire needs a target platform answer.",
        recommendedDirection: "Start with web only.",
        risks: ["Delaying the platform choice delays rollout planning."],
        questions: ["What is the target platform?"]
      },
      createdAt: "2026-04-28T10:00:03.000Z",
      updatedAt: "2026-04-28T10:00:03.000Z",
      resolution: null
    });

    repo.updateWorkflowRun({
      id: "wf_1",
      status: "partially_blocked",
      summary: {
        totalChildren: 4,
        runningChildren: 3,
        blockedChildren: 1,
        finalizedChildren: 0,
        erroredChildren: 0
      },
      updatedAt: "2026-04-28T10:00:04.000Z"
    });

    expect(repo.findWorkflowRunById("wf_1")).toMatchObject({
      id: "wf_1",
      specId: "parallel_existing_spec_review",
      status: "partially_blocked"
    });
    expect(repo.findChildSessions("wf_1")).toEqual([
      expect.objectContaining({
        sessionId: "sess_1",
        state: "human_blocked",
        latestRunId: "run_1"
      })
    ]);
    expect(repo.findEscalations("wf_1")).toEqual([
      expect.objectContaining({
        id: "esc_1",
        kind: "human_blocked",
        status: "open"
      })
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/storage/src/workflow-run-repository.test.ts`

Expected: FAIL with `Cannot find module './workflow-run-repository'` or missing export/schema errors.

- [ ] **Step 3: Add workflow tables to the shared schema**

Update `packages/storage/src/database.ts` by adding the workflow tables inside `applySchema` and matching migration guards inside `migrateIfNeeded`:

```ts
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_child_sessions (
      workflow_run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      lens TEXT NOT NULL,
      state TEXT NOT NULL,
      latest_run_id TEXT,
      escalation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_run_id, session_id),
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_escalations (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      brief_json TEXT NOT NULL,
      resolution_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
```

Add migration guards:

```ts
  const workflowRunColumns = db.pragma("table_info(workflow_runs)") as Array<{ name: string }>;
  const workflowRunColumnNames = workflowRunColumns.map((c) => c.name);
  if (workflowRunColumns.length > 0 && !workflowRunColumnNames.includes("settled_at")) {
    db.exec("ALTER TABLE workflow_runs ADD COLUMN settled_at TEXT");
  }

  const workflowEscalationColumns = db.pragma("table_info(workflow_escalations)") as Array<{ name: string }>;
  const workflowEscalationColumnNames = workflowEscalationColumns.map((c) => c.name);
  if (workflowEscalationColumns.length > 0 && !workflowEscalationColumnNames.includes("resolution_json")) {
    db.exec("ALTER TABLE workflow_escalations ADD COLUMN resolution_json TEXT");
  }
```

- [ ] **Step 4: Implement the new repository and export it**

Create `packages/storage/src/workflow-run-repository.ts`:

```ts
import type Database from "better-sqlite3";

export interface WorkflowRunRow {
  id: string;
  specId: string;
  status: string;
  input: Record<string, unknown>;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  settledAt?: string | null;
}

export interface WorkflowChildSessionRow {
  workflowRunId: string;
  sessionId: string;
  label: string;
  lens: string;
  state: string;
  latestRunId?: string | null;
  escalationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEscalationRow {
  id: string;
  workflowRunId: string;
  sessionId: string;
  kind: string;
  status: string;
  brief: Record<string, unknown>;
  resolution?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export class WorkflowRunRepository {
  constructor(private readonly db: Database.Database) {}

  createWorkflowRun(row: WorkflowRunRow): void {
    this.db.prepare(`
      INSERT INTO workflow_runs (id, spec_id, status, input_json, summary_json, created_at, updated_at, settled_at)
      VALUES (@id, @specId, @status, @inputJson, @summaryJson, @createdAt, @updatedAt, @settledAt)
    `).run({
      ...row,
      inputJson: JSON.stringify(row.input),
      summaryJson: JSON.stringify(row.summary),
      settledAt: row.settledAt ?? null
    });
  }

  updateWorkflowRun(input: {
    id: string;
    status: string;
    summary: Record<string, unknown>;
    updatedAt: string;
    settledAt?: string | null;
  }): void {
    this.db.prepare(`
      UPDATE workflow_runs
      SET status = @status, summary_json = @summaryJson, updated_at = @updatedAt, settled_at = COALESCE(@settledAt, settled_at)
      WHERE id = @id
    `).run({
      ...input,
      summaryJson: JSON.stringify(input.summary),
      settledAt: input.settledAt ?? null
    });
  }

  upsertChildSession(row: WorkflowChildSessionRow): void {
    this.db.prepare(`
      INSERT INTO workflow_child_sessions (
        workflow_run_id, session_id, label, lens, state, latest_run_id, escalation_id, created_at, updated_at
      ) VALUES (
        @workflowRunId, @sessionId, @label, @lens, @state, @latestRunId, @escalationId, @createdAt, @updatedAt
      )
      ON CONFLICT(workflow_run_id, session_id) DO UPDATE SET
        label = excluded.label,
        lens = excluded.lens,
        state = excluded.state,
        latest_run_id = excluded.latest_run_id,
        escalation_id = excluded.escalation_id,
        updated_at = excluded.updated_at
    `).run({
      ...row,
      latestRunId: row.latestRunId ?? null,
      escalationId: row.escalationId ?? null
    });
  }

  createEscalation(row: WorkflowEscalationRow): void {
    this.db.prepare(`
      INSERT INTO workflow_escalations (
        id, workflow_run_id, session_id, kind, status, brief_json, resolution_json, created_at, updated_at
      ) VALUES (
        @id, @workflowRunId, @sessionId, @kind, @status, @briefJson, @resolutionJson, @createdAt, @updatedAt
      )
    `).run({
      ...row,
      briefJson: JSON.stringify(row.brief),
      resolutionJson: row.resolution ? JSON.stringify(row.resolution) : null
    });
  }

  findWorkflowRunById(id: string): WorkflowRunRow | undefined {
    const row = this.db.prepare(`
      SELECT id, spec_id as specId, status, input_json as inputJson, summary_json as summaryJson,
             created_at as createdAt, updated_at as updatedAt, settled_at as settledAt
      FROM workflow_runs WHERE id = ?
    `).get(id) as
      | { id: string; specId: string; status: string; inputJson: string; summaryJson: string; createdAt: string; updatedAt: string; settledAt?: string | null }
      | undefined;

    return row
      ? {
          id: row.id,
          specId: row.specId,
          status: row.status,
          input: JSON.parse(row.inputJson),
          summary: JSON.parse(row.summaryJson),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          settledAt: row.settledAt ?? null
        }
      : undefined;
  }

  findChildSessions(workflowRunId: string): WorkflowChildSessionRow[] {
    return this.db.prepare(`
      SELECT workflow_run_id as workflowRunId, session_id as sessionId, label, lens, state,
             latest_run_id as latestRunId, escalation_id as escalationId, created_at as createdAt, updated_at as updatedAt
      FROM workflow_child_sessions
      WHERE workflow_run_id = ?
      ORDER BY created_at ASC
    `).all(workflowRunId) as WorkflowChildSessionRow[];
  }

  findEscalations(workflowRunId: string): WorkflowEscalationRow[] {
    const rows = this.db.prepare(`
      SELECT id, workflow_run_id as workflowRunId, session_id as sessionId, kind, status,
             brief_json as briefJson, resolution_json as resolutionJson, created_at as createdAt, updated_at as updatedAt
      FROM workflow_escalations
      WHERE workflow_run_id = ?
      ORDER BY created_at ASC
    `).all(workflowRunId) as Array<{
      id: string;
      workflowRunId: string;
      sessionId: string;
      kind: string;
      status: string;
      briefJson: string;
      resolutionJson?: string | null;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      workflowRunId: row.workflowRunId,
      sessionId: row.sessionId,
      kind: row.kind,
      status: row.status,
      brief: JSON.parse(row.briefJson),
      resolution: row.resolutionJson ? JSON.parse(row.resolutionJson) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }
}
```

Modify `packages/storage/src/index.ts`:

```ts
export * from "./database";
export * from "./session-repository";
export * from "./workflow-run-repository";
```

- [ ] **Step 5: Run the focused storage test and then the package test set**

Run: `pnpm vitest run packages/storage/src/workflow-run-repository.test.ts packages/storage/src/session-repository.test.ts`

Expected: PASS with the new workflow repository test green and no storage regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/database.ts packages/storage/src/index.ts packages/storage/src/workflow-run-repository.ts packages/storage/src/workflow-run-repository.test.ts
git commit -m "feat: add workflow persistence repository"
```

### Task 2: Create `@council/agent-workflows` Contracts, Built-In Spec, And Recommendation Helpers

**Files:**
- Create: `packages/agent-workflows/package.json`
- Create: `packages/agent-workflows/src/index.ts`
- Create: `packages/agent-workflows/src/contracts.ts`
- Create: `packages/agent-workflows/src/specs/parallel-existing-spec-review.ts`
- Create: `packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts`
- Create: `packages/agent-workflows/src/runtime/classify-child-session.ts`
- Create: `packages/agent-workflows/src/runtime/classify-child-session.test.ts`
- Create: `packages/agent-workflows/src/runtime/build-recommendation-brief.ts`

- [ ] **Step 1: Write the failing package-level tests**

Create `packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parallelExistingSpecReview } from "./parallel-existing-spec-review";

describe("parallelExistingSpecReview", () => {
  it("builds four existing-spec child session templates with distinct lenses", () => {
    const templates = parallelExistingSpecReview.buildSessionTemplates({
      title: "Review auth spec",
      prompt: "Focus on rollout gaps.",
      existingSpec: {
        spec: "# Existing Spec",
        implementationPlan: "# Existing Plan"
      }
    });

    expect(templates).toHaveLength(4);
    expect(templates.map((template) => template.label)).toEqual([
      "requirements",
      "architecture",
      "release-risk",
      "operability"
    ]);
    expect(templates.every((template) => template.mode === "existing_spec")).toBe(true);
    expect(templates[2]?.prompt).toContain("implementation and rollout risk");
  });
});
```

Create `packages/agent-workflows/src/runtime/classify-child-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildRecommendationBrief } from "./build-recommendation-brief";
import { classifyChildSession } from "./classify-child-session";

const baseSnapshot = {
  sessionId: "sess_1",
  label: "release-risk",
  lens: "implementation and rollout risk",
  session: {
    id: "sess_1",
    title: "Release risk",
    status: "waiting_for_human",
    phase: "analysis"
  },
  summary: {
    currentUnderstanding: "Missing platform scope.",
    recommendation: "Answer the question below.",
    changedSinceLastCheckpoint: [],
    openRisks: ["Platform choice is unresolved."],
    decisionsNeeded: ["Answer the interview question"]
  },
  interviewState: {
    questions: [],
    currentQuestion: {
      id: "q_1",
      text: "What is the target platform?",
      rationale: "Need scope",
      context: "This changes rollout planning.",
      recommendation: "Start with web only.",
      recommendationReasoning: "Smaller first release."
    },
    totalQuestions: 1,
    answeredCount: 0
  },
  activeRun: null,
  recentRuns: []
};

describe("classifyChildSession", () => {
  it("maps waiting_for_human to human_blocked and builds a recommendation brief", () => {
    const classification = classifyChildSession(baseSnapshot, []);
    expect(classification.state).toBe("human_blocked");

    const brief = buildRecommendationBrief(baseSnapshot, classification);
    expect(brief).toMatchObject({
      kind: "human_blocked",
      label: "release-risk",
      recommendedDirection: "Start with web only."
    });
    expect(brief?.questions).toEqual(["What is the target platform?"]);
  });

  it("maps checkpoint to human_blocked when approval is required", () => {
    const checkpoint = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "checkpoint", phase: "approach_debate" },
      interviewState: undefined,
      summary: {
        currentUnderstanding: "Approach is ready.",
        recommendation: "Approve approach to proceed.",
        changedSinceLastCheckpoint: [],
        openRisks: [],
        decisionsNeeded: ["Approve approach to proceed to spec generation"]
      }
    };

    expect(classifyChildSession(checkpoint, []).state).toBe("human_blocked");
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm vitest run packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts packages/agent-workflows/src/runtime/classify-child-session.test.ts`

Expected: FAIL with missing package/source files.

- [ ] **Step 3: Create the package and contracts**

Create `packages/agent-workflows/package.json`:

```json
{
  "name": "@council/agent-workflows",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@council/storage": "workspace:*"
  }
}
```

Create `packages/agent-workflows/src/contracts.ts`:

```ts
export type WorkflowSpecId = "parallel_existing_spec_review";
export type WorkflowRunStatus = "planning" | "launching" | "monitoring" | "partially_blocked" | "resuming" | "settled";
export type WorkflowChildState = "running" | "human_blocked" | "resuming" | "finalized" | "errored";
export type WorkflowErrorState = "recoverable_transient" | "recoverable_operator" | "terminal";

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

export interface WorkflowSessionSnapshot {
  sessionId: string;
  label: string;
  lens: string;
  session: {
    id: string;
    title: string;
    status: string;
    phase?: string | null;
  };
  summary?: {
    currentUnderstanding: string;
    recommendation: string;
    changedSinceLastCheckpoint: string[];
    openRisks: string[];
    decisionsNeeded: string[];
  };
  interviewState?: {
    questions: Array<{ id: string; text: string; answer: string | null }>;
    currentQuestion?: {
      id: string;
      text: string;
      rationale: string;
      context?: string | null;
      recommendation?: string | null;
      recommendationReasoning?: string | null;
    } | null;
    totalQuestions: number;
    answeredCount: number;
  };
  activeRun?: { id: string; status: string; phase?: string | null; errorMessage?: string | null } | null;
  recentRuns?: Array<{ id: string; status: string; phase?: string | null; errorMessage?: string | null }>;
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
```

Create `packages/agent-workflows/src/index.ts`:

```ts
export * from "./contracts";
export * from "./runtime/build-recommendation-brief";
export * from "./runtime/classify-child-session";
export * from "./specs/parallel-existing-spec-review";
```

- [ ] **Step 4: Implement the built-in workflow spec and helpers**

Create `packages/agent-workflows/src/specs/parallel-existing-spec-review.ts`:

```ts
import type { ExistingSpecWorkflowInput, WorkflowSpec } from "../contracts";

const LENSES = [
  { label: "requirements", lens: "requirements and ambiguity gaps" },
  { label: "architecture", lens: "architecture and boundary quality" },
  { label: "release-risk", lens: "implementation and rollout risk" },
  { label: "operability", lens: "testing, failure modes, and operability" }
] as const;

export const parallelExistingSpecReview: WorkflowSpec = {
  id: "parallel_existing_spec_review",
  description: "Launch four concurrent existing-spec review sessions with complementary review lenses.",
  buildSessionTemplates(input: ExistingSpecWorkflowInput) {
    return LENSES.map(({ label, lens }) => ({
      label,
      lens,
      title: `${input.title} (${lens})`,
      mode: "existing_spec" as const,
      prompt: [
        input.prompt?.trim() ? input.prompt.trim() : "Review the supplied specification carefully.",
        "",
        `Primary review lens: ${lens}.`,
        "Do not rewrite the whole document unless the submitted design is fundamentally unsound.",
        "Prioritize surfacing questions, risks, and revision guidance within this lens."
      ].join("\n"),
      existingSpec: input.existingSpec
    }));
  }
};
```

Create `packages/agent-workflows/src/runtime/classify-child-session.ts`:

```ts
import type { WorkflowClassification, WorkflowSessionSnapshot } from "../contracts";

export function classifyChildSession(
  snapshot: WorkflowSessionSnapshot,
  _events: Array<Record<string, unknown>>
): WorkflowClassification {
  const status = snapshot.session.status;

  if (status === "waiting_for_human" || status === "interviewing") {
    return { state: "human_blocked", reason: "Crossfire is waiting for a human answer." };
  }

  if (status === "checkpoint") {
    return { state: "human_blocked", reason: "Crossfire is waiting for a human approval or decision." };
  }

  if (status === "finalized") {
    return { state: "finalized", reason: "Crossfire finalized the child session." };
  }

  if (status === "errored") {
    const recentError = snapshot.activeRun?.errorMessage ?? snapshot.recentRuns?.find((run) => run.errorMessage)?.errorMessage ?? "";
    const transient = /timeout|terminated|provider|failed/i.test(recentError);

    return {
      state: "errored",
      errorState: transient ? "recoverable_transient" : "recoverable_operator",
      reason: recentError || "Crossfire entered an errored state."
    };
  }

  return { state: "running", reason: "Crossfire is actively progressing." };
}
```

Create `packages/agent-workflows/src/runtime/build-recommendation-brief.ts`:

```ts
import type { RecommendationBrief, WorkflowClassification, WorkflowSessionSnapshot } from "../contracts";

export function buildRecommendationBrief(
  snapshot: WorkflowSessionSnapshot,
  classification: WorkflowClassification
): RecommendationBrief | null {
  if (classification.state === "human_blocked") {
    const currentQuestion = snapshot.interviewState?.currentQuestion;
    if (currentQuestion) {
      return {
        kind: "human_blocked",
        label: snapshot.label,
        lens: snapshot.lens,
        summary: snapshot.summary?.currentUnderstanding ?? classification.reason,
        recommendedDirection: currentQuestion.recommendation ?? snapshot.summary?.recommendation ?? "Review the question and answer explicitly.",
        risks: snapshot.summary?.openRisks ?? [],
        questions: [currentQuestion.text]
      };
    }

    return {
      kind: "human_blocked",
      label: snapshot.label,
      lens: snapshot.lens,
      summary: snapshot.summary?.currentUnderstanding ?? classification.reason,
      recommendedDirection: snapshot.summary?.recommendation ?? "Review the checkpoint and decide whether to continue.",
      risks: snapshot.summary?.openRisks ?? [],
      questions: snapshot.summary?.decisionsNeeded ?? []
    };
  }

  if (classification.state === "errored") {
    return {
      kind: "recovery_needed",
      label: snapshot.label,
      lens: snapshot.lens,
      summary: classification.reason,
      recommendedDirection: classification.errorState === "recoverable_transient"
        ? "Retry or restart this child session after reviewing the latest run error."
        : "Inspect the child session manually before continuing.",
      risks: snapshot.summary?.openRisks ?? [],
      questions: []
    };
  }

  return null;
}
```

- [ ] **Step 5: Run the focused package tests**

Run: `pnpm vitest run packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts packages/agent-workflows/src/runtime/classify-child-session.test.ts`

Expected: PASS with the new spec and helper behavior covered.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-workflows/package.json packages/agent-workflows/src/index.ts packages/agent-workflows/src/contracts.ts packages/agent-workflows/src/specs/parallel-existing-spec-review.ts packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts packages/agent-workflows/src/runtime/classify-child-session.ts packages/agent-workflows/src/runtime/classify-child-session.test.ts packages/agent-workflows/src/runtime/build-recommendation-brief.ts
git commit -m "feat: add agent workflow contracts and review spec"
```

### Task 3: Implement The Generic Workflow Engine In `@council/agent-workflows`

**Files:**
- Modify: `packages/agent-workflows/src/contracts.ts`
- Modify: `packages/agent-workflows/src/index.ts`
- Create: `packages/agent-workflows/src/runtime/workflow-engine.ts`
- Create: `packages/agent-workflows/src/runtime/workflow-engine.test.ts`

- [ ] **Step 1: Write the failing engine tests**

Create `packages/agent-workflows/src/runtime/workflow-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createWorkflowEngine } from "./workflow-engine";
import { parallelExistingSpecReview } from "../specs/parallel-existing-spec-review";

describe("createWorkflowEngine", () => {
  it("starts a workflow, launches child sessions, and emits blocked escalations", async () => {
    const createdSessions: string[] = [];
    const snapshots = new Map<string, any>();
    const persisted: Record<string, unknown> = {};

    const engine = createWorkflowEngine({
      specs: [parallelExistingSpecReview],
      runtime: {
        async createSession(template) {
          const sessionId = `sess_${createdSessions.length + 1}`;
          createdSessions.push(sessionId);
          snapshots.set(sessionId, {
            sessionId,
            label: template.label,
            lens: template.lens,
            session: { id: sessionId, title: template.title, status: "waiting_for_human", phase: "analysis" },
            summary: {
              currentUnderstanding: "Need platform scope.",
              recommendation: "Answer the interview question.",
              changedSinceLastCheckpoint: [],
              openRisks: ["Platform choice is unresolved."],
              decisionsNeeded: ["Answer the interview question"]
            },
            interviewState: {
              questions: [],
              currentQuestion: {
                id: "q_1",
                text: "What is the target platform?",
                rationale: "Need scope",
                context: "This drives rollout planning.",
                recommendation: "Start with web only.",
                recommendationReasoning: "That keeps the first release smaller."
              },
              totalQuestions: 1,
              answeredCount: 0
            },
            activeRun: null,
            recentRuns: []
          });
          return snapshots.get(sessionId);
        },
        async continueSession(sessionId) {
          const current = snapshots.get(sessionId);
          snapshots.set(sessionId, {
            ...current,
            session: { ...current.session, status: "checkpoint", phase: "approach_debate" },
            interviewState: undefined,
            summary: {
              currentUnderstanding: "Approach is ready.",
              recommendation: "Approve approach to proceed.",
              changedSinceLastCheckpoint: [],
              openRisks: [],
              decisionsNeeded: ["Approve approach to proceed to spec generation"]
            }
          });
          return snapshots.get(sessionId);
        },
        async getSession(sessionId) {
          return snapshots.get(sessionId);
        },
        async listRunEvents() {
          return [];
        },
        subscribeProgress() {
          return () => {};
        }
      },
      persistence: {
        async createWorkflowRun(row) {
          persisted.run = row;
        },
        async updateWorkflowRun(row) {
          persisted.updatedRun = row;
        },
        async upsertChildSession(row) {
          const children = (persisted.children as Array<unknown> | undefined) ?? [];
          children.push(row);
          persisted.children = children;
        },
        async createEscalation(row) {
          const escalations = (persisted.escalations as Array<unknown> | undefined) ?? [];
          escalations.push(row);
          persisted.escalations = escalations;
        }
      }
    });

    const run = await engine.startWorkflow("parallel_existing_spec_review", {
      title: "Review auth spec",
      prompt: "Focus on rollout gaps.",
      existingSpec: {
        spec: "# Existing Spec",
        implementationPlan: "# Existing Plan"
      }
    });

    expect(run.childSessions).toHaveLength(4);
    expect(run.status).toBe("partially_blocked");
    expect(run.escalations).toHaveLength(4);

    const resumed = await engine.handleHumanResponse(run.id, run.childSessions[0]!.sessionId, "Start with web only.");
    expect(resumed.childSessions[0]!.state).toBe("human_blocked");
    expect(resumed.childSessions[0]!.latestBrief?.questions).toEqual(["Approve approach to proceed to spec generation"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-workflows/src/runtime/workflow-engine.test.ts`

Expected: FAIL with `Cannot find module './workflow-engine'` and missing engine exports.

- [ ] **Step 3: Extend the contracts with runtime and persistence interfaces**

Append to `packages/agent-workflows/src/contracts.ts`:

```ts
export interface WorkflowRunView {
  id: string;
  specId: WorkflowSpecId;
  status: WorkflowRunStatus;
  childSessions: Array<{
    sessionId: string;
    label: string;
    lens: string;
    state: WorkflowChildState;
    latestRunId?: string | null;
    latestBrief?: RecommendationBrief | null;
  }>;
  escalations: RecommendationBrief[];
}

export interface WorkflowRuntime {
  createSession(template: SessionTemplate): Promise<WorkflowSessionSnapshot>;
  continueSession(sessionId: string, humanResponse: string): Promise<WorkflowSessionSnapshot>;
  getSession(sessionId: string): Promise<WorkflowSessionSnapshot>;
  listRunEvents(sessionId: string): Promise<Array<Record<string, unknown>>>;
  subscribeProgress(listener: (event: { sessionId: string; runId?: string }) => void): () => void;
}

export interface WorkflowPersistence {
  createWorkflowRun(row: Record<string, unknown>): Promise<void> | void;
  updateWorkflowRun(row: Record<string, unknown>): Promise<void> | void;
  upsertChildSession(row: Record<string, unknown>): Promise<void> | void;
  createEscalation(row: Record<string, unknown>): Promise<void> | void;
}
```

- [ ] **Step 4: Implement the generic engine and export it**

Create `packages/agent-workflows/src/runtime/workflow-engine.ts`:

```ts
import { randomUUID } from "node:crypto";
import type {
  ExistingSpecWorkflowInput,
  RecommendationBrief,
  WorkflowClassification,
  WorkflowPersistence,
  WorkflowRunView,
  WorkflowRuntime,
  WorkflowSessionSnapshot,
  WorkflowSpec
} from "../contracts";
import { buildRecommendationBrief } from "./build-recommendation-brief";
import { classifyChildSession } from "./classify-child-session";

interface CreateWorkflowEngineInput {
  specs: WorkflowSpec[];
  runtime: WorkflowRuntime;
  persistence: WorkflowPersistence;
}

export function createWorkflowEngine(input: CreateWorkflowEngineInput) {
  const specs = new Map(input.specs.map((spec) => [spec.id, spec]));
  const runs = new Map<string, WorkflowRunView>();

  async function refreshChild(snapshot: WorkflowSessionSnapshot) {
    const events = await input.runtime.listRunEvents(snapshot.sessionId);
    const classification = classifyChildSession(snapshot, events);
    const brief = buildRecommendationBrief(snapshot, classification);
    return { snapshot, classification, brief };
  }

  return {
    async startWorkflow(specId: WorkflowSpec["id"], workflowInput: ExistingSpecWorkflowInput): Promise<WorkflowRunView> {
      const spec = specs.get(specId);
      if (!spec) throw new Error(`Unknown workflow spec: ${specId}`);

      const id = randomUUID();
      const templates = spec.buildSessionTemplates(workflowInput);
      await input.persistence.createWorkflowRun({
        id,
        specId,
        status: "launching",
        input: workflowInput,
        summary: { totalChildren: templates.length, runningChildren: templates.length, blockedChildren: 0, finalizedChildren: 0, erroredChildren: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settledAt: null
      });

      const created = await Promise.all(templates.map(async (template) => {
        const snapshot = await input.runtime.createSession(template);
        const refreshed = await refreshChild(snapshot);
        await input.persistence.upsertChildSession({
          workflowRunId: id,
          sessionId: snapshot.sessionId,
          label: template.label,
          lens: template.lens,
          state: refreshed.classification.state,
          latestRunId: snapshot.activeRun?.id ?? null,
          escalationId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        if (refreshed.brief) {
          await input.persistence.createEscalation({
            id: randomUUID(),
            workflowRunId: id,
            sessionId: snapshot.sessionId,
            kind: refreshed.brief.kind,
            status: "open",
            brief: refreshed.brief,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            resolution: null
          });
        }
        return {
          sessionId: snapshot.sessionId,
          label: template.label,
          lens: template.lens,
          state: refreshed.classification.state,
          latestRunId: snapshot.activeRun?.id ?? null,
          latestBrief: refreshed.brief
        };
      }));

      const escalations = created
        .map((child) => child.latestBrief)
        .filter((brief): brief is RecommendationBrief => brief !== null && brief !== undefined);

      const status = escalations.length > 0 ? "partially_blocked" : "monitoring";
      const view: WorkflowRunView = { id, specId, status, childSessions: created, escalations };
      runs.set(id, view);

      await input.persistence.updateWorkflowRun({
        id,
        status,
        summary: {
          totalChildren: created.length,
          runningChildren: created.filter((child) => child.state === "running").length,
          blockedChildren: created.filter((child) => child.state === "human_blocked").length,
          finalizedChildren: created.filter((child) => child.state === "finalized").length,
          erroredChildren: created.filter((child) => child.state === "errored").length
        },
        updatedAt: new Date().toISOString(),
        settledAt: status === "settled" ? new Date().toISOString() : null
      });

      return view;
    },

    getWorkflowRun(workflowRunId: string): WorkflowRunView | null {
      return runs.get(workflowRunId) ?? null;
    },

    async refreshWorkflow(workflowRunId: string, sessionId?: string): Promise<WorkflowRunView> {
      const current = runs.get(workflowRunId);
      if (!current) throw new Error(`Unknown workflow run: ${workflowRunId}`);

      const nextChildren = await Promise.all(current.childSessions.map(async (child) => {
        if (sessionId && child.sessionId !== sessionId) {
          return child;
        }

        const snapshot = await input.runtime.getSession(child.sessionId);
        const refreshed = await refreshChild(snapshot);
        return {
          ...child,
          state: refreshed.classification.state,
          latestRunId: snapshot.activeRun?.id ?? child.latestRunId ?? null,
          latestBrief: refreshed.brief
        };
      }));

      const nextEscalations = nextChildren
        .map((child) => child.latestBrief)
        .filter((brief): brief is RecommendationBrief => brief !== null && brief !== undefined);

      const nextStatus = nextChildren.every((child) => child.state === "finalized" || child.state === "errored")
        ? "settled"
        : nextEscalations.length > 0
          ? "partially_blocked"
          : "monitoring";

      const nextRun: WorkflowRunView = {
        ...current,
        status: nextStatus,
        childSessions: nextChildren,
        escalations: nextEscalations
      };
      runs.set(workflowRunId, nextRun);
      return nextRun;
    },

    async handleHumanResponse(workflowRunId: string, sessionId: string, response: string): Promise<WorkflowRunView> {
      const current = runs.get(workflowRunId);
      if (!current) throw new Error(`Unknown workflow run: ${workflowRunId}`);

      const updated = await input.runtime.continueSession(sessionId, response);
      const refreshed = await refreshChild(updated);

      const nextChildren = current.childSessions.map((child) =>
        child.sessionId === sessionId
          ? {
              ...child,
              state: refreshed.classification.state,
              latestRunId: updated.activeRun?.id ?? null,
              latestBrief: refreshed.brief
            }
          : child
      );

      const nextEscalations = nextChildren
        .map((child) => child.latestBrief)
        .filter((brief): brief is RecommendationBrief => brief !== null && brief !== undefined);

      const nextStatus = nextChildren.every((child) => child.state === "finalized" || child.state === "errored")
        ? "settled"
        : nextEscalations.length > 0
          ? "partially_blocked"
          : "monitoring";

      const nextRun: WorkflowRunView = {
        ...current,
        status: nextStatus,
        childSessions: nextChildren,
        escalations: nextEscalations
      };
      runs.set(workflowRunId, nextRun);
      return nextRun;
    }
  };
}
```

Modify `packages/agent-workflows/src/index.ts`:

```ts
export * from "./contracts";
export * from "./runtime/build-recommendation-brief";
export * from "./runtime/classify-child-session";
export * from "./runtime/workflow-engine";
export * from "./specs/parallel-existing-spec-review";
```

- [ ] **Step 5: Run the engine tests**

Run: `pnpm vitest run packages/agent-workflows/src/runtime/workflow-engine.test.ts packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts packages/agent-workflows/src/runtime/classify-child-session.test.ts`

Expected: PASS with the engine starting workflows, storing child state, and re-blocking resumed children at the next human gate.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-workflows/src/contracts.ts packages/agent-workflows/src/index.ts packages/agent-workflows/src/runtime/workflow-engine.ts packages/agent-workflows/src/runtime/workflow-engine.test.ts
git commit -m "feat: add generic workflow engine"
```

### Task 4: Integrate The Engine Into The Daemon And Prove End-To-End Monitoring

**Files:**
- Modify: `apps/daemon/package.json`
- Modify: `apps/daemon/src/main.ts`
- Create: `apps/daemon/src/services/workflow-service.ts`
- Create: `apps/daemon/src/services/workflow-service.test.ts`

- [ ] **Step 1: Write the failing daemon integration test**

Create `apps/daemon/src/services/workflow-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository, WorkflowRunRepository } from "@council/storage";
import { createSessionService } from "./session-service";
import { createWorkflowService } from "./workflow-service";

function createPhaseAwareProvider(name: "gpt" | "claude"): ProviderAdapter {
  return {
    name,
    async *sendTurn(input: ProviderTurnInput) {
      const turn: ModelTurn = {
        actor: name,
        rawText: `${name} response`,
        summary: `${name} summary`,
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: input.phase === "analysis" ? ["What is the target platform?"] : [],
        proposedSpecDelta: input.phase === "spec_generation" ? `${name} spec` : "",
        milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
        implementationPlan: input.phase === "spec_generation" ? `${name} plan` : null,
        proposedQuestions: input.phase === "analysis" ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope", recommendation: "Start with web only." }] : null,
        synthesizedQuestions: input.phase === "analysis_debate" ? [{ text: "What is the target platform?", priority: 1, rationale: "Need scope", recommendation: "Start with web only." }] : null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: input.phase === "walkthrough" ? [] : null,
        degraded: false
      };
      yield { type: "structured_turn", actor: name, turn, rawResponse: JSON.stringify(turn) } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

async function waitFor(condition: () => Promise<boolean>, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}

describe("createWorkflowService", () => {
  it("starts a multi-session workflow, persists child state, and keeps monitoring after human resume", async () => {
    const db = createInMemoryDatabase();
    const sessionRepository = new SessionRepository(db);
    const workflowRepository = new WorkflowRunRepository(db);
    const sessionService = createSessionService({
      repository: sessionRepository,
      gpt: createPhaseAwareProvider("gpt"),
      claude: createPhaseAwareProvider("claude")
    });
    const workflowService = createWorkflowService({
      sessionService,
      sessionRepository,
      workflowRepository
    });

    const started = await workflowService.startParallelExistingSpecReview({
      title: "Review auth spec",
      prompt: "Focus on rollout gaps.",
      existingSpec: {
        spec: "# Existing Spec",
        implementationPlan: "# Existing Plan"
      }
    });

    await waitFor(async () => {
      const current = await workflowService.getWorkflowRun(started.id);
      return Boolean(current && current.escalations.length === 4);
    });

    const blocked = await workflowService.getWorkflowRun(started.id);
    expect(blocked?.status).toBe("partially_blocked");
    expect(blocked?.childSessions).toHaveLength(4);
    expect(blocked?.childSessions.every((child) => child.state === "human_blocked")).toBe(true);

    const resumed = await workflowService.handleHumanResponse(
      started.id,
      blocked!.childSessions[0]!.sessionId,
      "Start with web only."
    );

    expect(resumed.childSessions[0]?.state).toBe("human_blocked");
    expect(resumed.childSessions[0]?.latestBrief?.questions).toEqual([
      "Approve approach to proceed to spec generation"
    ]);
  });
});
```

- [ ] **Step 2: Run the daemon integration test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/workflow-service.test.ts`

Expected: FAIL with `Cannot find module './workflow-service'` or missing daemon/package integration.

- [ ] **Step 3: Add the daemon workflow service and wire package dependencies**

Modify `apps/daemon/package.json`:

```json
{
  "name": "@council/daemon",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@council/adapters": "workspace:*",
    "@council/agent-workflows": "workspace:*",
    "@council/core": "workspace:*",
    "@council/storage": "workspace:*",
    "fastify": "^5.6.1",
    "fastify-plugin": "^5.1.0"
  }
}
```

Create `apps/daemon/src/services/workflow-service.ts`:

```ts
import { createWorkflowEngine, parallelExistingSpecReview, type ExistingSpecWorkflowInput } from "@council/agent-workflows";
import type { SessionRepository, WorkflowRunRepository } from "@council/storage";
import type { ProgressEvent } from "./progress";
import { onProgress } from "./progress";

interface SessionServiceLike {
  createSession(input: {
    title: string;
    prompt: string;
    mode: "existing_spec";
    existingSpec: {
      spec: string;
      implementationPlan?: string;
    };
  }): Promise<Record<string, unknown>>;
  continueSession(input: { id: string; humanResponse: string }): Promise<Record<string, unknown> | null>;
  getSession(id: string): Promise<Record<string, unknown> | null>;
  listRunEvents(runId: string): Array<unknown>;
}

export function createWorkflowService(input: {
  sessionService: SessionServiceLike;
  sessionRepository: SessionRepository;
  workflowRepository: WorkflowRunRepository;
}) {
  const engine = createWorkflowEngine({
    specs: [parallelExistingSpecReview],
    runtime: {
      async createSession(template) {
        const created = await input.sessionService.createSession({
          title: template.title,
          prompt: template.prompt,
          mode: "existing_spec",
          existingSpec: template.existingSpec
        });
        return normalizeSnapshot(created as Record<string, unknown>, template.label, template.lens);
      },
      async continueSession(sessionId, humanResponse) {
        const updated = await input.sessionService.continueSession({ id: sessionId, humanResponse });
        if (!updated) throw new Error(`Unknown session: ${sessionId}`);
        const child = findWorkflowChildBySessionId(updated as Record<string, unknown>, sessionId);
        return normalizeSnapshot(updated as Record<string, unknown>, child?.label ?? "session", child?.lens ?? "review");
      },
      async getSession(sessionId) {
        const payload = await input.sessionService.getSession(sessionId);
        if (!payload) throw new Error(`Unknown session: ${sessionId}`);
        return normalizeSnapshot(payload as Record<string, unknown>, "session", "review");
      },
      async listRunEvents(sessionId) {
        const payload = await input.sessionService.getSession(sessionId);
        const activeRun = payload && typeof payload === "object" ? (payload as { activeRun?: { id?: string } }).activeRun : undefined;
        return activeRun?.id ? input.sessionService.listRunEvents(activeRun.id) as Array<Record<string, unknown>> : [];
      },
      subscribeProgress(listener) {
        return onProgress((event: ProgressEvent) => {
          listener({ sessionId: event.sessionId, runId: event.runId });
        });
      }
    },
    persistence: {
      createWorkflowRun: (row) => input.workflowRepository.createWorkflowRun(row as never),
      updateWorkflowRun: (row) => input.workflowRepository.updateWorkflowRun(row as never),
      upsertChildSession: (row) => input.workflowRepository.upsertChildSession(row as never),
      createEscalation: (row) => input.workflowRepository.createEscalation(row as never)
    }
  });
  const childToWorkflowRun = new Map<string, string>();

  onProgress((event: ProgressEvent) => {
    const workflowRunId = childToWorkflowRun.get(event.sessionId);
    if (!workflowRunId) return;
    void engine.refreshWorkflow(workflowRunId, event.sessionId);
  });

  return {
    async startParallelExistingSpecReview(inputData: ExistingSpecWorkflowInput) {
      const run = await engine.startWorkflow("parallel_existing_spec_review", inputData);
      for (const child of run.childSessions) {
        childToWorkflowRun.set(child.sessionId, run.id);
      }
      return run;
    },
    getWorkflowRun(id: string) {
      return engine.getWorkflowRun(id);
    },
    handleHumanResponse(workflowRunId: string, sessionId: string, response: string) {
      return engine.handleHumanResponse(workflowRunId, sessionId, response);
    }
  };
}

function normalizeSnapshot(payload: Record<string, unknown>, label: string, lens: string) {
  const session = payload.session as Record<string, unknown>;
  return {
    sessionId: String(session.id),
    label,
    lens,
    session: {
      id: String(session.id),
      title: String(session.title),
      status: String(session.status),
      phase: typeof session.phase === "string" ? session.phase : null
    },
    summary: payload.summary as Record<string, unknown> | undefined,
    interviewState: payload.interviewState as Record<string, unknown> | undefined,
    activeRun: payload.activeRun as Record<string, unknown> | null | undefined,
    recentRuns: payload.recentRuns as Array<Record<string, unknown>> | undefined
  };
}

function findWorkflowChildBySessionId(_payload: Record<string, unknown>, _sessionId: string) {
  return null;
}
```

Modify `apps/daemon/src/main.ts` to instantiate the new repository and service:

```ts
import { createDatabase, createInMemoryDatabase, SessionRepository, WorkflowRunRepository } from "@council/storage";
import { createWorkflowService } from "./services/workflow-service";

const db = providerMode === "fake" ? createInMemoryDatabase() : createDatabase(databasePath);
const repository = new SessionRepository(db);
const workflowRepository = new WorkflowRunRepository(db);

const workflowService = createWorkflowService({
  sessionService,
  sessionRepository: repository,
  workflowRepository
});

void workflowService;
```

- [ ] **Step 4: Make the daemon integration actually work**

Refine `apps/daemon/src/services/workflow-service.ts` so that:

```ts
const workflowRuns = new Map<string, ReturnType<typeof engine.startWorkflow> extends Promise<infer T> ? T : never>();

// After startWorkflow resolves:
workflowRuns.set(run.id, run);

// In getWorkflowRun:
return workflowRuns.get(id) ?? null;

// In handleHumanResponse:
const updated = await engine.handleHumanResponse(workflowRunId, sessionId, response);
workflowRuns.set(workflowRunId, updated);
return updated;
```

Also replace the placeholder child lookup with repository-backed metadata:

```ts
function findChildMetadata(workflowRepository: WorkflowRunRepository, workflowRunId: string, sessionId: string) {
  return workflowRepository.findChildSessions(workflowRunId).find((child) => child.sessionId === sessionId) ?? null;
}
```

Use that metadata when normalizing resumed sessions so the label/lens remain stable.

- [ ] **Step 5: Run focused verification and then a build**

Run: `pnpm vitest run apps/daemon/src/services/workflow-service.test.ts packages/agent-workflows/src/runtime/workflow-engine.test.ts packages/storage/src/workflow-run-repository.test.ts`

Expected: PASS with one workflow run launching four children, persisting escalations, and re-entering monitoring after a human response.

Run: `pnpm --filter @council/daemon build`

Expected: PASS with the daemon typechecking against the new workspace package and storage repository.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/package.json apps/daemon/src/main.ts apps/daemon/src/services/workflow-service.ts apps/daemon/src/services/workflow-service.test.ts
git commit -m "feat: integrate agent workflows into daemon"
```

### Task 5: Final Verification Across The Full Change Set

**Files:**
- Modify: `docs/superpowers/plans/2026-04-28-agent-workflows.md`

- [ ] **Step 1: Run the complete targeted verification set**

Run:

```bash
pnpm vitest run \
  packages/storage/src/workflow-run-repository.test.ts \
  packages/agent-workflows/src/specs/parallel-existing-spec-review.test.ts \
  packages/agent-workflows/src/runtime/classify-child-session.test.ts \
  packages/agent-workflows/src/runtime/workflow-engine.test.ts \
  apps/daemon/src/services/workflow-service.test.ts \
  apps/daemon/src/services/session-service-spec-driven.test.ts
```

Expected: PASS with no failures.

- [ ] **Step 2: Run the full daemon build**

Run: `pnpm --filter @council/daemon build`

Expected: PASS with zero TypeScript errors.

- [ ] **Step 3: Mark the finished plan checkboxes and commit the plan update**

Update this plan file so completed steps are checked off, then commit:

```bash
git add docs/superpowers/plans/2026-04-28-agent-workflows.md
git commit -m "docs: update agent workflows implementation plan status"
```
