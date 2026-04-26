# Large Feedback Spec Revision Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow large spec feedback without degraded structured output while storing the user's feedback verbatim as the authority of record.

**Architecture:** Add persisted revision requests that store raw feedback unchanged. Route spec feedback through a dedicated revision flow that chunks large feedback, extracts a bounded digest with source chunk references, selects exact excerpts, and revises the existing spec/plan instead of appending feedback to `originalProblem`.

**Tech Stack:** TypeScript, Vitest, SQLite via `better-sqlite3`, existing Crossfire provider adapters and phase orchestrator.

---

## Notes Before Starting

- Use @superpowers:test-driven-development for each task.
- Use @superpowers:verification-before-completion before claiming done.
- The current worktree already has unrelated edits. Do not revert them. Stage only the files listed in each task.
- Existing relevant files:
  - `packages/storage/src/database.ts`
  - `packages/storage/src/session-repository.ts`
  - `packages/storage/src/session-repository.test.ts`
  - `packages/adapters/src/prompts/phase-prompts.ts`
  - `packages/adapters/src/prompts/structured-turn.test.ts`
  - `apps/daemon/src/services/phase-validation.ts`
  - `apps/daemon/src/services/phase-validation.test.ts`
  - `apps/daemon/src/services/phase-orchestrator.ts`
  - `apps/daemon/src/services/phase-orchestrator.test.ts`
  - `apps/daemon/src/services/session-service.ts`
  - `apps/daemon/src/services/session-service.test.ts`

### Task 1: Persist Revision Requests

**Files:**
- Modify: `packages/storage/src/database.ts`
- Modify: `packages/storage/src/session-repository.ts`
- Test: `packages/storage/src/session-repository.test.ts`

**Step 1: Write the failing repository test**

Append a test to `packages/storage/src/session-repository.test.ts`:

```ts
it("stores spec revision feedback verbatim by run id", () => {
  const db = createInMemoryDatabase();
  const repo = new SessionRepository(db);

  repo.create({
    id: "sess_1",
    title: "Revision session",
    status: "checkpoint",
    phase: "spec_generation"
  });
  repo.createRun({
    id: "run_1",
    sessionId: "sess_1",
    kind: "revise",
    status: "running",
    phase: "spec_generation",
    startedAt: "2026-04-25T10:00:00.000Z"
  });

  const feedbackRaw = "Line one\\n\\nLine two with exact wording.";
  repo.createRevisionRequest({
    id: "rev_1",
    sessionId: "sess_1",
    runId: "run_1",
    feedbackRaw,
    feedbackChunks: [],
    feedbackDigest: null,
    budgetLedger: null,
    status: "stored",
    createdAt: "2026-04-25T10:00:01.000Z"
  });

  const found = repo.findRevisionRequestByRunId("run_1");
  expect(found?.feedbackRaw).toBe(feedbackRaw);
  expect(found?.status).toBe("stored");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/storage/src/session-repository.test.ts -t "stores spec revision feedback verbatim"`

Expected: FAIL because `createRevisionRequest` does not exist.

**Step 3: Add schema and repository methods**

In `packages/storage/src/database.ts`, add a table inside `applySchema`:

```sql
CREATE TABLE IF NOT EXISTS revision_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  feedback_raw TEXT NOT NULL,
  feedback_chunks_json TEXT NOT NULL,
  feedback_digest_json TEXT,
  budget_ledger_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (run_id) REFERENCES session_runs(id)
);
```

In `packages/storage/src/session-repository.ts`, add:

```ts
export interface RevisionRequestRow {
  id: string;
  sessionId: string;
  runId: string;
  feedbackRaw: string;
  feedbackChunks: Array<Record<string, unknown>>;
  feedbackDigest: Record<string, unknown> | null;
  budgetLedger: Record<string, unknown> | null;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
}
```

Add methods:

```ts
createRevisionRequest(row: RevisionRequestRow): void {
  this.db.prepare(`
    INSERT INTO revision_requests (
      id, session_id, run_id, feedback_raw, feedback_chunks_json,
      feedback_digest_json, budget_ledger_json, status, created_at, updated_at
    ) VALUES (
      @id, @sessionId, @runId, @feedbackRaw, @feedbackChunksJson,
      @feedbackDigestJson, @budgetLedgerJson, @status, @createdAt, @updatedAt
    )
  `).run({
    ...row,
    feedbackChunksJson: JSON.stringify(row.feedbackChunks),
    feedbackDigestJson: row.feedbackDigest ? JSON.stringify(row.feedbackDigest) : null,
    budgetLedgerJson: row.budgetLedger ? JSON.stringify(row.budgetLedger) : null,
    updatedAt: row.updatedAt ?? null
  });
}

updateRevisionRequest(input: {
  id: string;
  feedbackChunks?: Array<Record<string, unknown>>;
  feedbackDigest?: Record<string, unknown> | null;
  budgetLedger?: Record<string, unknown> | null;
  status: string;
  updatedAt: string;
}): void {
  this.db.prepare(`
    UPDATE revision_requests
    SET
      feedback_chunks_json = COALESCE(@feedbackChunksJson, feedback_chunks_json),
      feedback_digest_json = @feedbackDigestJson,
      budget_ledger_json = @budgetLedgerJson,
      status = @status,
      updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id: input.id,
    feedbackChunksJson: input.feedbackChunks ? JSON.stringify(input.feedbackChunks) : null,
    feedbackDigestJson: input.feedbackDigest ? JSON.stringify(input.feedbackDigest) : null,
    budgetLedgerJson: input.budgetLedger ? JSON.stringify(input.budgetLedger) : null,
    status: input.status,
    updatedAt: input.updatedAt
  });
}
```

Add `findRevisionRequestByRunId(runId: string)` and parse JSON fields on read. Update `deleteSession` to delete `revision_requests` before deleting runs.

**Step 4: Run storage tests**

Run: `pnpm vitest run packages/storage/src/session-repository.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/storage/src/database.ts packages/storage/src/session-repository.ts packages/storage/src/session-repository.test.ts
git commit -m "feat: persist spec revision requests"
```

### Task 2: Add Feedback Chunking and Excerpt Selection

**Files:**
- Create: `apps/daemon/src/services/revision-feedback.ts`
- Test: `apps/daemon/src/services/revision-feedback.test.ts`

**Step 1: Write failing tests**

Create `apps/daemon/src/services/revision-feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  chunkFeedback,
  selectFeedbackExcerpts,
  buildRevisionBudgetLedger
} from "./revision-feedback";

describe("revision-feedback", () => {
  it("chunks feedback with stable offsets and verbatim text", () => {
    const raw = "A".repeat(10) + "B".repeat(10) + "C".repeat(10);
    const chunks = chunkFeedback(raw, { chunkSize: 12, overlap: 2 });

    expect(chunks[0]).toMatchObject({
      id: "feedback-chunk-1",
      index: 0,
      startOffset: 0,
      endOffset: 12,
      text: raw.slice(0, 12)
    });
    expect(chunks[1].startOffset).toBe(10);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain("BBBB");
  });

  it("selects exact excerpts for requested source chunks within budget", () => {
    const chunks = chunkFeedback("alpha beta gamma delta epsilon", { chunkSize: 12, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1"] }],
      budgetChars: 50
    });

    expect(excerpts.blocked).toBe(false);
    expect(excerpts.text).toContain("feedback-chunk-1");
    expect(excerpts.text).toContain(chunks[0].text);
  });

  it("blocks when selected excerpts exceed budget", () => {
    const chunks = chunkFeedback("x".repeat(100), { chunkSize: 50, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "All", sourceChunkIds: ["feedback-chunk-1", "feedback-chunk-2"] }],
      budgetChars: 20
    });

    expect(excerpts.blocked).toBe(true);
  });

  it("builds a budget ledger", () => {
    const ledger = buildRevisionBudgetLedger({
      feedbackRaw: "raw",
      feedbackDigest: "digest",
      feedbackExcerpts: "excerpt",
      currentSpec: "spec",
      currentPlan: "plan"
    });

    expect(ledger.feedbackRawChars).toBe(3);
    expect(ledger.currentSpecChars).toBe(4);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/daemon/src/services/revision-feedback.test.ts`

Expected: FAIL because the module does not exist.

**Step 3: Implement helper**

Create `apps/daemon/src/services/revision-feedback.ts`:

```ts
export interface FeedbackChunk {
  id: string;
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface RequestedFeedbackChange {
  summary: string;
  sourceChunkIds: string[];
}

export function chunkFeedback(
  raw: string,
  options: { chunkSize?: number; overlap?: number } = {}
): FeedbackChunk[] {
  const chunkSize = options.chunkSize ?? 4_000;
  const overlap = options.overlap ?? 300;
  const chunks: FeedbackChunk[] = [];
  let start = 0;

  while (start < raw.length) {
    const end = Math.min(raw.length, start + chunkSize);
    chunks.push({
      id: `feedback-chunk-${chunks.length + 1}`,
      index: chunks.length,
      startOffset: start,
      endOffset: end,
      text: raw.slice(start, end)
    });
    if (end === raw.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function selectFeedbackExcerpts(input: {
  chunks: FeedbackChunk[];
  requestedChanges: RequestedFeedbackChange[];
  budgetChars: number;
}): { blocked: boolean; text: string; selectedChunkIds: string[] } {
  const requested = new Set(input.requestedChanges.flatMap((change) => change.sourceChunkIds));
  const selected = input.chunks.filter((chunk) => requested.has(chunk.id));
  const text = selected
    .map((chunk) => `### ${chunk.id} [${chunk.startOffset}-${chunk.endOffset}]\\n${chunk.text}`)
    .join("\\n\\n");

  return {
    blocked: text.length > input.budgetChars,
    text,
    selectedChunkIds: selected.map((chunk) => chunk.id)
  };
}

export function buildRevisionBudgetLedger(input: {
  feedbackRaw: string;
  feedbackDigest: string;
  feedbackExcerpts: string;
  currentSpec: string;
  currentPlan: string;
}) {
  return {
    feedbackRawChars: input.feedbackRaw.length,
    feedbackDigestChars: input.feedbackDigest.length,
    feedbackExcerptsChars: input.feedbackExcerpts.length,
    currentSpecChars: input.currentSpec.length,
    currentPlanChars: input.currentPlan.length
  };
}
```

**Step 4: Run helper tests**

Run: `pnpm vitest run apps/daemon/src/services/revision-feedback.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/services/revision-feedback.ts apps/daemon/src/services/revision-feedback.test.ts
git commit -m "feat: add revision feedback slicing helpers"
```

### Task 3: Add Feedback Digest and Spec Revision Prompts

**Files:**
- Modify: `packages/adapters/src/prompts/phase-prompts.ts`
- Test: `packages/adapters/src/prompts/structured-turn.test.ts`

**Step 1: Write failing prompt tests**

Add tests under `describe("phase prompt contracts", ...)`:

```ts
it("builds a feedback digest prompt with verbatim chunks", () => {
  const prompt = buildFeedbackDigestPrompt({
    originalProblem: "Build retrieval",
    feedbackChunks: [
      { id: "feedback-chunk-1", startOffset: 0, endOffset: 12, text: "Make it safer" }
    ]
  });

  expect(prompt).toContain("PHASE: FEEDBACK DIGEST");
  expect(prompt).toContain("feedback-chunk-1");
  expect(prompt).toContain("Make it safer");
  expect(prompt).toContain("sourceChunkIds");
});

it("builds a spec revision prompt from existing spec and exact excerpts", () => {
  const prompt = buildSpecRevisionPrompt({
    originalProblem: "Build retrieval",
    interviewResults: [{ question: "Cloud?", answer: "Allowed" }],
    approachResult: "Use hybrid retrieval",
    currentSpec: "# Current Spec",
    currentImplementationPlan: "# Current Plan",
    feedbackDigest: "- request: update auth",
    feedbackExcerpts: "### feedback-chunk-1\\nAdd bearer auth."
  });

  expect(prompt).toContain("PHASE: SPEC REVISION");
  expect(prompt).toContain("CURRENT SPECIFICATION:");
  expect(prompt).toContain("# Current Spec");
  expect(prompt).toContain("EXACT FEEDBACK EXCERPTS");
  expect(prompt).toContain("excerpt wins");
});
```

Import `buildFeedbackDigestPrompt` and `buildSpecRevisionPrompt` at the top of the test file.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts -t "feedback digest|spec revision"`

Expected: FAIL because the functions do not exist.

**Step 3: Implement prompt builders**

In `packages/adapters/src/prompts/phase-prompts.ts`, export:

```ts
export function buildFeedbackDigestPrompt(input: {
  originalProblem: string;
  feedbackChunks: Array<{ id: string; startOffset: number; endOffset: number; text: string }>;
}): string {
  const chunks = input.feedbackChunks
    .map((chunk) => `### ${chunk.id} [${chunk.startOffset}-${chunk.endOffset}]\\n${chunk.text}`)
    .join("\\n\\n");

  return [
    "PHASE: FEEDBACK DIGEST",
    "",
    "Extract concrete requested changes from the human feedback chunks.",
    "The raw feedback chunks are authoritative. Preserve traceability.",
    "Every requested change MUST include sourceChunkIds.",
    "",
    "Respond ONLY with a JSON object:",
    "{",
    "  \"rawText\": \"markdown digest\",",
    "  \"summary\": \"one sentence summary\",",
    "  \"proposedSpecDelta\": \"markdown digest with source chunk ids\"",
    "}",
    "",
    "---",
    "",
    "ORIGINAL PROBLEM:",
    input.originalProblem,
    "",
    "---",
    "",
    "FEEDBACK CHUNKS:",
    chunks
  ].join("\\n");
}
```

Also export:

```ts
export function buildSpecRevisionPrompt(input: {
  originalProblem: string;
  interviewResults: Array<{ question: string; answer: string }>;
  approachResult: string;
  currentSpec: string;
  currentImplementationPlan: string;
  feedbackDigest: string;
  feedbackExcerpts: string;
}): string {
  const interviewContext = input.interviewResults
    .map((qa) => `Q: ${qa.question}\\nA: ${qa.answer}`)
    .join("\\n\\n");

  return [
    getPersona("claude"),
    "",
    ANTI_SYCOPHANCY,
    "",
    "PHASE: SPEC REVISION",
    "Revise the existing specification and implementation plan using the human feedback.",
    "Do not restart the architecture from scratch unless the exact feedback asks for that.",
    "The exact feedback excerpts are authoritative. If the digest and an excerpt conflict, the excerpt wins.",
    "",
    "Respond ONLY with a JSON object:",
    "{",
    "  \"rawText\": \"brief overview of the revision\",",
    "  \"summary\": \"one paragraph summary\",",
    "  \"proposedSpecDelta\": \"the full revised specification in markdown\",",
    "  \"milestoneReached\": \"implementation_plan_ready\",",
    "  \"implementationPlan\": \"the full revised implementation plan in markdown\"",
    "}",
    "",
    "---",
    "",
    "ORIGINAL PROBLEM:",
    input.originalProblem,
    "",
    "---",
    "",
    "INTERVIEW RESULTS:",
    interviewContext,
    "",
    "---",
    "",
    "CONVERGED APPROACH:",
    input.approachResult,
    "",
    "---",
    "",
    "CURRENT SPECIFICATION:",
    input.currentSpec,
    "",
    "---",
    "",
    "CURRENT IMPLEMENTATION PLAN:",
    input.currentImplementationPlan,
    "",
    "---",
    "",
    "FEEDBACK DIGEST:",
    input.feedbackDigest,
    "",
    "---",
    "",
    "EXACT FEEDBACK EXCERPTS:",
    input.feedbackExcerpts
  ].join("\\n");
}
```

**Step 4: Run prompt tests**

Run: `pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/adapters/src/prompts/phase-prompts.ts packages/adapters/src/prompts/structured-turn.test.ts
git commit -m "feat: add spec revision prompts"
```

### Task 4: Add Feedback Digest Phase Validation

**Files:**
- Modify: `apps/daemon/src/services/phase-validation.ts`
- Test: `apps/daemon/src/services/phase-validation.test.ts`

**Step 1: Write failing test**

Add to `phase-validation.test.ts`:

```ts
it("requires digest fields for feedback digest turns", () => {
  const result = validatePhaseTurn("feedback_digest", {
    rawText: "digest",
    summary: "summary",
    proposedSpecDelta: "- request"
  });

  expect(result.ok).toBe(true);
  expect(result.missingFields).toEqual([]);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/phase-validation.test.ts -t "feedback digest"`

Expected: FAIL because `feedback_digest` is not a valid phase.

**Step 3: Implement phase**

In `phase-validation.ts`, add `"feedback_digest"` to `PhaseValidationPhase` and:

```ts
feedback_digest: ["rawText", "summary", "proposedSpecDelta"]
```

Also update the existing "includes rawText and summary" test phase list.

**Step 4: Run validation tests**

Run: `pnpm vitest run apps/daemon/src/services/phase-validation.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/services/phase-validation.ts apps/daemon/src/services/phase-validation.test.ts
git commit -m "feat: validate feedback digest phase"
```

### Task 5: Add Dedicated Spec Revision Orchestrator Path

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Test: `apps/daemon/src/services/phase-orchestrator.test.ts`

**Step 1: Write failing orchestrator tests**

Add tests under `describe("runSpecGeneration", ...)` or a new `describe("runSpecRevision", ...)`:

```ts
it("revises from existing spec and digests large feedback before prompting", async () => {
  const gptPrompts: ProviderTurnInput[] = [];
  const claudePrompts: ProviderTurnInput[] = [];

  const gpt: ProviderAdapter = {
    name: "gpt",
    async *sendTurn(input: ProviderTurnInput) {
      gptPrompts.push(input);
      const turn: ModelTurn = {
        actor: "gpt",
        rawText: "Digest",
        summary: "Digest summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "- change: tighten auth\\n  sourceChunkIds: [feedback-chunk-1]",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
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
      claudePrompts.push(input);
      const turn: ModelTurn = {
        actor: "claude",
        rawText: "Revision done",
        summary: "Revision summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "# Revised Spec",
        milestoneReached: "implementation_plan_ready",
        implementationPlan: "# Revised Plan",
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      };
      yield { type: "structured_turn", actor: "claude", turn, rawResponse: JSON.stringify(turn) } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };

  const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
    "sess_1",
    {
      originalProblem: "Original problem",
      interviewResults: [],
      finalApproachHandoff: "Approach",
      currentSpec: "# Current Spec",
      currentImplementationPlan: "# Current Plan",
      feedbackRaw: "Tighten auth. ".repeat(1_000),
      rawFeedbackBudgetChars: 500,
      excerptBudgetChars: 10_000
    },
    "run_1"
  );

  expect(result.spec).toBe("# Revised Spec");
  expect(result.implementationPlan).toBe("# Revised Plan");
  expect(result.trace.feedbackDigest).toBeDefined();
  expect(gptPrompts[0].phase).toBe("feedback_digest");
  expect(claudePrompts[0].prompt).toContain("CURRENT SPECIFICATION:");
  expect(claudePrompts[0].prompt).toContain("EXACT FEEDBACK EXCERPTS:");
  expect(claudePrompts[0].prompt).not.toContain("HUMAN REVISION FEEDBACK:");
});
```

Add a second test:

```ts
it("blocks revision when exact feedback excerpts exceed budget", async () => {
  const provider = createAnalysisProvider("gpt");
  const result = await createPhaseOrchestrator({ gpt: provider, claude: createAnalysisProvider("claude") }).runSpecRevision(
    "sess_1",
    {
      originalProblem: "Original problem",
      interviewResults: [],
      finalApproachHandoff: "Approach",
      currentSpec: "# Current Spec",
      currentImplementationPlan: "# Current Plan",
      feedbackRaw: "x".repeat(20_000),
      rawFeedbackBudgetChars: 500,
      excerptBudgetChars: 10
    },
    "run_1"
  );

  expect(result.blockedReason).toBe("feedback_input_too_large");
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts -t "runSpecRevision|digests large feedback|feedback excerpts"`

Expected: FAIL because `runSpecRevision` does not exist.

**Step 3: Implement `runSpecRevision`**

In `phase-orchestrator.ts`:

- Import `buildFeedbackDigestPrompt` and `buildSpecRevisionPrompt`.
- Import `chunkFeedback`, `selectFeedbackExcerpts`, and `buildRevisionBudgetLedger`.
- Add trace types:

```ts
interface SpecRevisionResult {
  spec: string;
  implementationPlan: string;
  summary: string;
  blockedReason?: "feedback_input_too_large";
  revisionRequest: {
    feedbackChunks: Array<Record<string, unknown>>;
    feedbackDigest: Record<string, unknown> | null;
    budgetLedger: Record<string, unknown>;
  };
  trace: {
    feedbackDigest?: TurnTrace;
    revision?: TurnTrace;
  };
}
```

Add a method to the returned orchestrator object:

```ts
async runSpecRevision(
  sessionId: string,
  input: {
    originalProblem: string;
    interviewResults: Array<{ question: string; answer: string }>;
    finalApproachHandoff: string;
    currentSpec: string;
    currentImplementationPlan: string;
    feedbackRaw: string;
    rawFeedbackBudgetChars?: number;
    excerptBudgetChars?: number;
  },
  runId?: string
): Promise<SpecRevisionResult> {
  emitProgress({ sessionId, runId, type: "phase_start", phase: "spec_generation", message: "Spec Revision (store feedback -> digest -> exact excerpts -> revise)" });

  const rawFeedbackBudgetChars = input.rawFeedbackBudgetChars ?? 12_000;
  const excerptBudgetChars = input.excerptBudgetChars ?? 30_000;
  const feedbackChunks = chunkFeedback(input.feedbackRaw);
  let feedbackDigestText = input.feedbackRaw;
  let feedbackDigestTrace: TurnTrace | undefined;

  if (input.feedbackRaw.length > rawFeedbackBudgetChars) {
    const digestResult = await collectTurnOutput(thisOrchestratorGptOrInputGpt, ...);
  }

  // Use a local helper to parse sourceChunkIds from digest text.
  // If parsing finds none, include all chunks until budget and block if too large.
  const requestedChanges = extractRequestedFeedbackChanges(feedbackDigestText, feedbackChunks);
  const excerpts = selectFeedbackExcerpts({ chunks: feedbackChunks, requestedChanges, budgetChars: excerptBudgetChars });
  const budgetLedger = buildRevisionBudgetLedger({ ... });

  if (excerpts.blocked) {
    return { spec: input.currentSpec, implementationPlan: input.currentImplementationPlan, summary: "Feedback is too large to revise safely.", blockedReason: "feedback_input_too_large", revisionRequest: { ... }, trace: { feedbackDigest: feedbackDigestTrace } };
  }

  const revisionResult = await collectTurnOutput(input.claude, {
    sessionId,
    runId,
    prompt: buildSpecRevisionPrompt(...),
    phase: "spec_generation",
    promptLedger: [...]
  });

  return { spec, implementationPlan, summary, revisionRequest: { ... }, trace: { feedbackDigest: feedbackDigestTrace, revision: revisionResult.trace } };
}
```

Implementation detail: because methods in the returned object do not currently use `this`, use `input.gpt` and `input.claude` from the closure. Do not use `thisOrchestratorGptOrInputGpt`; that placeholder means `input.gpt`.

Add a small private helper:

```ts
function extractRequestedFeedbackChanges(
  digestText: string,
  chunks: FeedbackChunk[]
): RequestedFeedbackChange[] {
  const ids = [...digestText.matchAll(/feedback-chunk-\d+/g)].map((match) => match[0]);
  const sourceChunkIds = ids.length ? [...new Set(ids)] : chunks.map((chunk) => chunk.id);
  return [{ summary: digestText, sourceChunkIds }];
}
```

**Step 4: Run orchestrator tests**

Run: `pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/services/phase-orchestrator.ts apps/daemon/src/services/phase-orchestrator.test.ts
git commit -m "feat: add bounded spec revision orchestration"
```

### Task 6: Wire Session Service Revision Flow

**Files:**
- Modify: `apps/daemon/src/services/session-service.ts`
- Test: `apps/daemon/src/services/session-service.test.ts`

**Step 1: Write failing service tests**

Add a test that verifies large feedback is stored verbatim and not sent as original problem:

```ts
it("stores large spec feedback verbatim and revises from existing spec", async () => {
  const repository = new SessionRepository(createInMemoryDatabase());
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
          ? "- change: tighten auth\\n  sourceChunkIds: [feedback-chunk-1]"
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

  const created = await service.createSession({ title: "Spec", prompt: "Build an app" });
  await waitForSettledSession(service, created.session.id);
  await service.continueSession({ id: created.session.id, humanResponse: "Looks good" });
  await waitForSettledSession(service, created.session.id);

  const feedback = "Please tighten auth. ".repeat(1_000);
  const started = await service.continueSession({ id: created.session.id, humanResponse: feedback });
  expect(started?.activeRun).toBeDefined();
  const runId = started!.activeRun!.id;

  await waitForSettledSession(service, created.session.id);
  expect(repository.findRevisionRequestByRunId(runId)?.feedbackRaw).toBe(feedback);
  expect(prompts.some((prompt) => prompt.prompt.includes("HUMAN REVISION FEEDBACK:"))).toBe(false);
});
```

Add a second test:

```ts
it("keeps previous spec result when spec revision provider fails", async () => {
  // Use a provider that succeeds until revision, then yields an invalid/degraded spec_generation turn.
  // Assert repository.findPhaseResult(id, "spec_generation") still contains the previous spec JSON.
});
```

Write this fully during implementation using the existing `createDelayedQuestionProvider` and `createInvalidPhaseProvider` patterns from `phase-orchestrator.test.ts`.

**Step 2: Run service tests to verify they fail**

Run: `pnpm vitest run apps/daemon/src/services/session-service.test.ts -t "large spec feedback|previous spec result"`

Expected: FAIL because `reviseSpec` still appends feedback to the original prompt and does not create revision requests.

**Step 3: Implement service wiring**

In `reviseSpec`:

1. Load the current `spec_generation` phase result before starting.
2. Create a revision request immediately:

```ts
const revisionRequestId = randomUUID();
input.repository.createRevisionRequest({
  id: revisionRequestId,
  sessionId: id,
  runId: runId ?? revisionRequestId,
  feedbackRaw: feedback,
  feedbackChunks: [],
  feedbackDigest: null,
  budgetLedger: null,
  status: "stored",
  createdAt: new Date().toISOString()
});
```

3. Call `phaseOrchestrator.runSpecRevision(...)` instead of `runSpecGeneration(...)`.
4. Pass:
   - `originalProblem`
   - `interviewResults`
   - `finalApproachHandoff`
   - `currentSpec`
   - `currentImplementationPlan`
   - `feedbackRaw: feedback`
5. After the orchestrator returns, update the revision request with chunks, digest, ledger, and status `applied` or `blocked`.
6. If `blockedReason === "feedback_input_too_large"`, do not overwrite the previous `spec_generation` result. Set session status to `checkpoint` and save a summary asking the user to prioritize feedback.
7. On thrown provider errors, set session status to `errored`, update revision request to `failed`, and do not overwrite the previous spec result.

**Step 4: Run service tests**

Run: `pnpm vitest run apps/daemon/src/services/session-service.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/daemon/src/services/session-service.ts apps/daemon/src/services/session-service.test.ts
git commit -m "feat: route spec feedback through revision requests"
```

### Task 7: Surface Revision Trace in Runs and UI Copy

**Files:**
- Modify: `apps/web/src/components/progress-feed.tsx`
- Test: `apps/web/src/components/progress-feed.test.tsx`
- Optional Modify: `apps/web/src/lib/api.ts`

**Step 1: Write failing progress-feed test**

Add a test showing revision metadata:

```tsx
it("labels feedback digest and oversized feedback events", () => {
  render(
    <ProgressFeed
      events={[
        {
          id: "event_1",
          runId: "run_1",
          sessionId: "sess_1",
          type: "info",
          phase: "feedback_digest",
          message: "Extracting requested changes from large feedback",
          createdAt: "2026-04-25T10:00:00.000Z",
          metadata: { outputStatus: "ok" }
        },
        {
          id: "event_2",
          runId: "run_1",
          sessionId: "sess_1",
          type: "info",
          phase: "spec_generation",
          message: "feedback input too large",
          createdAt: "2026-04-25T10:00:01.000Z",
          metadata: { blockedReason: "feedback_input_too_large" }
        }
      ]}
    />
  );

  expect(screen.getByText("Extracting requested changes from large feedback")).toBeTruthy();
  expect(screen.getByText("blocked: feedback too large")).toBeTruthy();
});
```

Adjust prop names to match the current `ProgressFeed` test setup.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/components/progress-feed.test.tsx -t "feedback digest|feedback too large"`

Expected: FAIL if labels are missing.

**Step 3: Implement UI copy**

In `progress-feed.tsx`:

- Add `feedback_digest` to phase label handling as "Extracting feedback changes".
- Add `feedback_input_too_large` to blocked reason handling as "blocked: feedback too large".
- Keep old `spec_generation_input_too_large` and `revision_input_too_large` behavior unchanged.

**Step 4: Run web component tests**

Run: `pnpm vitest run apps/web/src/components/progress-feed.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/components/progress-feed.tsx apps/web/src/components/progress-feed.test.tsx apps/web/src/lib/api.ts
git commit -m "feat: surface large feedback revision progress"
```

### Task 8: End-to-End Verification

**Files:**
- No required file changes unless tests reveal issues.

**Step 1: Run targeted tests**

Run:

```bash
pnpm vitest run packages/storage/src/session-repository.test.ts
pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts
pnpm vitest run apps/daemon/src/services/revision-feedback.test.ts
pnpm vitest run apps/daemon/src/services/phase-validation.test.ts
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
pnpm vitest run apps/daemon/src/services/session-service.test.ts
pnpm vitest run apps/web/src/components/progress-feed.test.tsx
```

Expected: all PASS.

**Step 2: Run full test suite**

Run: `pnpm test`

Expected: all PASS.

**Step 3: Run build**

Run: `pnpm build`

Expected: daemon and web builds pass.

**Step 4: Commit any verification fixes**

If fixes were needed:

```bash
git add <exact files>
git commit -m "fix: stabilize large feedback revision flow"
```

**Step 5: Final verification note**

Record:

- Which tests passed.
- Whether `pnpm build` passed.
- Any remaining risk, especially around model digest quality and future applied/unapplied feedback reporting.
