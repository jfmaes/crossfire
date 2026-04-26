# Existing Spec Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class Crossfire flow for adversarial review and revision of existing specs and implementation plans, including uploaded text files and daemon-local file paths.

**Architecture:** Reuse the existing session lifecycle and add an `existing_spec` session mode carried through `executionPolicy`. The daemon resolves existing document sources before creating the session, stores source metadata in `phase_results`, and runs the same phases with existing-spec prompt framing. The web app adds a tabbed empty state and a dedicated form that reads browser uploads as text or sends daemon path references.

**Tech Stack:** TypeScript, Fastify, React 19, Vite, SQLite via `@council/storage`, Vitest, Testing Library, Playwright.

---

### Task 1: Add Shared Existing-Spec Types

**Files:**
- Modify: `packages/storage/src/session-repository.ts`
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Write the failing type-level usage test**

No runtime test is needed for this task. The verification is `tsc`, and later tasks will exercise the types through daemon and web tests.

**Step 2: Extend storage execution policy types**

In `packages/storage/src/session-repository.ts`, change:

```ts
export interface ExecutionPolicy {
  approachDebateMaxTurns?: number;
}
```

to:

```ts
export type SessionMode = "new_spec" | "existing_spec";

export interface ExistingSpecSourceMetadata {
  label: "spec" | "implementationPlan";
  sourceType: "text" | "path";
  path?: string | null;
  fileName?: string | null;
  chars: number;
}

export interface ExecutionPolicy {
  approachDebateMaxTurns?: number;
  mode?: SessionMode;
  existingSpecSources?: ExistingSpecSourceMetadata[];
}
```

**Step 3: Extend web API request and payload types**

In `apps/web/src/lib/api.ts`, add:

```ts
export type SessionMode = "new_spec" | "existing_spec";

export interface ExistingSpecInput {
  spec?: string;
  specPath?: string;
  specFileName?: string;
  implementationPlan?: string;
  implementationPlanPath?: string;
  implementationPlanFileName?: string;
}
```

Extend `SessionPayload.session.executionPolicy` with:

```ts
mode?: SessionMode;
existingSpecSources?: Array<{
  label: "spec" | "implementationPlan";
  sourceType: "text" | "path";
  path?: string | null;
  fileName?: string | null;
  chars: number;
}>;
```

Extend `createSession` input with:

```ts
mode?: SessionMode;
existingSpec?: ExistingSpecInput;
```

and include `mode` and `existingSpec` in the request body.

**Step 4: Run type check**

Run: `pnpm build`

Expected: Type errors until later tasks add daemon route/service support. This is acceptable if the errors point only at the new fields not yet consumed.

**Step 5: Commit**

Do not commit after this task unless it is implemented together with Task 2 and the repo builds.

---

### Task 2: Resolve Existing-Spec Inputs In The Daemon

**Files:**
- Create: `apps/daemon/src/services/existing-spec-input.ts`
- Create: `apps/daemon/src/services/existing-spec-input.test.ts`

**Step 1: Write failing validation tests**

Create `apps/daemon/src/services/existing-spec-input.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExistingSpecInput } from "./existing-spec-input";

let tempDir: string | undefined;

describe("resolveExistingSpecInput", () => {
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("requires a spec text or path", async () => {
    await expect(resolveExistingSpecInput({ existingSpec: {} }))
      .rejects.toThrow("existingSpec.spec or existingSpec.specPath is required");
  });

  it("rejects text and path for the same spec", async () => {
    await expect(resolveExistingSpecInput({
      existingSpec: { spec: "# Spec", specPath: "/tmp/spec.md" }
    })).rejects.toThrow("Provide either spec text or specPath, not both");
  });

  it("reads daemon-local markdown paths", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-existing-spec-"));
    const specPath = path.join(tempDir, "spec.md");
    const planPath = path.join(tempDir, "plan.txt");
    await writeFile(specPath, "# Existing Spec", "utf8");
    await writeFile(planPath, "# Existing Plan", "utf8");

    const resolved = await resolveExistingSpecInput({
      prompt: "Focus on rollout risk.",
      existingSpec: { specPath, implementationPlanPath: planPath }
    });

    expect(resolved.spec).toBe("# Existing Spec");
    expect(resolved.implementationPlan).toBe("# Existing Plan");
    expect(resolved.prompt).toContain("Focus on rollout risk.");
    expect(resolved.prompt).toContain("EXISTING SPECIFICATION");
    expect(resolved.sources).toEqual([
      { label: "spec", sourceType: "path", path: specPath, fileName: "spec.md", chars: 15 },
      { label: "implementationPlan", sourceType: "path", path: planPath, fileName: "plan.txt", chars: 15 }
    ]);
  });

  it("rejects unsupported extensions and directories", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-existing-spec-"));
    const unsupported = path.join(tempDir, "spec.pdf");
    const directory = path.join(tempDir, "docs");
    await writeFile(unsupported, "not really pdf", "utf8");
    await mkdir(directory);

    await expect(resolveExistingSpecInput({ existingSpec: { specPath: unsupported } }))
      .rejects.toThrow("Unsupported spec file extension");
    await expect(resolveExistingSpecInput({ existingSpec: { specPath: directory } }))
      .rejects.toThrow("spec path must be a file");
  });

  it("rejects oversized text before model calls", async () => {
    await expect(resolveExistingSpecInput({
      existingSpec: { spec: "x".repeat(250_001) }
    })).rejects.toThrow("spec exceeds");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/existing-spec-input.test.ts`

Expected: FAIL because `existing-spec-input.ts` does not exist.

**Step 3: Implement resolver**

Create `apps/daemon/src/services/existing-spec-input.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExistingSpecSourceMetadata } from "@council/storage";

export interface ExistingSpecRequestInput {
  prompt?: string;
  existingSpec?: {
    spec?: string;
    specPath?: string;
    specFileName?: string;
    implementationPlan?: string;
    implementationPlanPath?: string;
    implementationPlanFileName?: string;
  };
}

interface ResolvedDocument {
  text: string;
  source: ExistingSpecSourceMetadata;
}

const MAX_DOCUMENT_CHARS = 250_000;
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export async function resolveExistingSpecInput(input: ExistingSpecRequestInput) {
  const existingSpec = input.existingSpec ?? {};
  const spec = await resolveDocument({
    label: "spec",
    text: existingSpec.spec,
    filePath: existingSpec.specPath,
    fileName: existingSpec.specFileName,
    required: true
  });
  const implementationPlan = await resolveDocument({
    label: "implementationPlan",
    text: existingSpec.implementationPlan,
    filePath: existingSpec.implementationPlanPath,
    fileName: existingSpec.implementationPlanFileName,
    required: false
  });

  const prompt = [
    input.prompt?.trim() ? `HUMAN REVIEW CONTEXT:\n${input.prompt.trim()}` : "HUMAN REVIEW CONTEXT:\nNo additional context supplied.",
    "",
    "EXISTING SPECIFICATION:",
    spec.text,
    "",
    implementationPlan
      ? ["EXISTING IMPLEMENTATION PLAN:", implementationPlan.text].join("\n")
      : "EXISTING IMPLEMENTATION PLAN:\nNo implementation plan was supplied."
  ].join("\n");

  return {
    prompt,
    spec: spec.text,
    implementationPlan: implementationPlan?.text ?? null,
    sources: [spec.source, ...(implementationPlan ? [implementationPlan.source] : [])]
  };
}

async function resolveDocument(input: {
  label: "spec" | "implementationPlan";
  text?: string;
  filePath?: string;
  fileName?: string;
  required: boolean;
}): Promise<ResolvedDocument | null> {
  const text = input.text?.trim();
  const filePath = input.filePath?.trim();

  if (text && filePath) {
    throw new Error(`Provide either ${input.label} text or ${input.label === "spec" ? "specPath" : "implementationPlanPath"}, not both`);
  }
  if (!text && !filePath) {
    if (input.required) {
      throw new Error("existingSpec.spec or existingSpec.specPath is required");
    }
    return null;
  }
  if (text) {
    ensureDocumentSize(input.label, text);
    return {
      text,
      source: {
        label: input.label,
        sourceType: "text",
        path: null,
        fileName: input.fileName?.trim() || null,
        chars: text.length
      }
    };
  }

  const resolvedPath = path.resolve(filePath!);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported ${input.label} file extension: ${extension || "(none)"}`);
  }

  const stats = await stat(resolvedPath).catch((error: unknown) => {
    throw new Error(`Unable to read ${input.label} path: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!stats.isFile()) {
    throw new Error(`${input.label} path must be a file`);
  }

  const content = await readFile(resolvedPath, "utf8");
  ensureDocumentSize(input.label, content);

  return {
    text: content,
    source: {
      label: input.label,
      sourceType: "path",
      path: resolvedPath,
      fileName: path.basename(resolvedPath),
      chars: content.length
    }
  };
}

function ensureDocumentSize(label: "spec" | "implementationPlan", text: string): void {
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new Error(`${label} exceeds ${MAX_DOCUMENT_CHARS} character limit`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/daemon/src/services/existing-spec-input.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/storage/src/session-repository.ts apps/web/src/lib/api.ts apps/daemon/src/services/existing-spec-input.ts apps/daemon/src/services/existing-spec-input.test.ts
git commit -m "feat: resolve existing spec session inputs"
```

---

### Task 3: Accept Existing-Spec Session Creation Through Routes

**Files:**
- Modify: `apps/daemon/src/routes/sessions.ts`
- Modify: `apps/daemon/src/routes/sessions.test.ts`
- Modify: `apps/daemon/src/server.ts`

**Step 1: Write failing route tests**

In `apps/daemon/src/routes/sessions.test.ts`, add:

```ts
it("passes existing spec creation payloads to the session service", async () => {
  let captured: Record<string, unknown> | undefined;
  const service = {
    ...fakeService,
    async createSession(input: Record<string, unknown>) {
      captured = input;
      return fakeSession;
    }
  };
  const app = buildServer({ accessToken: "secret-token", sessionService: service });

  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-council-token": "secret-token" },
    payload: {
      title: "Review existing spec",
      mode: "existing_spec",
      prompt: "Check rollout risks",
      existingSpec: { spec: "# Spec", implementationPlan: "# Plan" }
    }
  });

  expect(response.statusCode).toBe(201);
  expect(captured?.mode).toBe("existing_spec");
  expect(captured?.existingSpec).toEqual({ spec: "# Spec", implementationPlan: "# Plan" });
  await app.close();
});

it("returns 400 when existing spec creation omits spec input", async () => {
  const app = buildServer({ accessToken: "secret-token", sessionService: fakeService });

  const response = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { "x-council-token": "secret-token" },
    payload: {
      title: "Review existing spec",
      mode: "existing_spec",
      prompt: "Check rollout risks",
      existingSpec: {}
    }
  });

  expect(response.statusCode).toBe(400);
  expect(response.json().error).toContain("existingSpec.spec or existingSpec.specPath is required");
  await app.close();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/routes/sessions.test.ts`

Expected: FAIL because the route does not parse `mode` or `existingSpec`.

**Step 3: Update route service interfaces**

In both `apps/daemon/src/routes/sessions.ts` and `apps/daemon/src/server.ts`, extend `createSession` input with:

```ts
mode?: "new_spec" | "existing_spec";
existingSpec?: {
  spec?: string;
  specPath?: string;
  specFileName?: string;
  implementationPlan?: string;
  implementationPlanPath?: string;
  implementationPlanFileName?: string;
};
```

**Step 4: Parse and validate mode in route**

In `app.post("/sessions")`, add:

```ts
const mode = body?.mode === "existing_spec" ? "existing_spec" : "new_spec";
const existingSpec = typeof body?.existingSpec === "object" && body.existingSpec
  ? body.existingSpec as Record<string, unknown>
  : undefined;
```

For `new_spec`, keep the existing `title` and `prompt` requirement.

For `existing_spec`, require `title` and one of `existingSpec.spec` or `existingSpec.specPath`. Do not require `prompt`.

Pass:

```ts
const created = await input.sessionService.createSession({
  title,
  prompt,
  executionPolicy,
  mode,
  existingSpec: existingSpec ? {
    spec: typeof existingSpec.spec === "string" ? existingSpec.spec : undefined,
    specPath: typeof existingSpec.specPath === "string" ? existingSpec.specPath : undefined,
    specFileName: typeof existingSpec.specFileName === "string" ? existingSpec.specFileName : undefined,
    implementationPlan: typeof existingSpec.implementationPlan === "string" ? existingSpec.implementationPlan : undefined,
    implementationPlanPath: typeof existingSpec.implementationPlanPath === "string" ? existingSpec.implementationPlanPath : undefined,
    implementationPlanFileName: typeof existingSpec.implementationPlanFileName === "string" ? existingSpec.implementationPlanFileName : undefined
  } : undefined
});
```

Return 400 for `existing_spec` input validation errors and keep 500 for unexpected service failures.

**Step 5: Run route tests**

Run: `pnpm vitest run apps/daemon/src/routes/sessions.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/daemon/src/routes/sessions.ts apps/daemon/src/routes/sessions.test.ts apps/daemon/src/server.ts
git commit -m "feat: accept existing spec session creation"
```

---

### Task 4: Create Existing-Spec Sessions In Session Service

**Files:**
- Modify: `apps/daemon/src/services/session-service.ts`
- Modify: `apps/daemon/src/services/session-service-spec-driven.test.ts`
- Modify: `apps/daemon/src/services/session-service.test.ts`

**Step 1: Write failing service tests**

In `apps/daemon/src/services/session-service-spec-driven.test.ts`, add:

```ts
it("creates an existing-spec session and still surfaces interview questions", async () => {
  const service = createService();

  const created = await service.createSession({
    title: "Review existing spec",
    mode: "existing_spec",
    prompt: "Focus on release risk.",
    existingSpec: {
      spec: "# Existing Spec\nShip a web dashboard.",
      implementationPlan: "# Existing Plan\n1. Build UI."
    }
  });

  const settled = await waitForSettledSession(service, created.session.id);

  expect(settled.session.executionPolicy?.mode).toBe("existing_spec");
  expect(settled.session.phase).toBe("interview");
  expect(settled.interviewState?.currentQuestion?.text).toBe("What is the target platform?");
  expect(settled.session.prompt).toContain("EXISTING SPECIFICATION");
});
```

In `apps/daemon/src/services/session-service.test.ts`, add a path-based test near the grounding tests:

```ts
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
```

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm vitest run apps/daemon/src/services/session-service-spec-driven.test.ts apps/daemon/src/services/session-service.test.ts
```

Expected: FAIL because `CreateSessionInput` does not support mode/existingSpec and the service does not save `existing_spec_input`.

**Step 3: Extend service input**

In `apps/daemon/src/services/session-service.ts`, import:

```ts
import { resolveExistingSpecInput } from "./existing-spec-input";
```

Extend `CreateSessionInput`:

```ts
mode?: "new_spec" | "existing_spec";
existingSpec?: {
  spec?: string;
  specPath?: string;
  specFileName?: string;
  implementationPlan?: string;
  implementationPlanPath?: string;
  implementationPlanFileName?: string;
};
```

**Step 4: Build the prompt by mode**

Inside `createSession`, replace the single `const prompt = await buildPrompt(payload.prompt);` path with:

```ts
const mode = payload.mode ?? "new_spec";
const resolvedExistingSpec = mode === "existing_spec"
  ? await resolveExistingSpecInput({ prompt: payload.prompt, existingSpec: payload.existingSpec })
  : null;
const prompt = mode === "existing_spec"
  ? resolvedExistingSpec!.prompt
  : await buildPrompt(payload.prompt);
```

For existing-spec sessions, store:

```ts
executionPolicy: {
  ...(payload.executionPolicy ?? {}),
  mode,
  existingSpecSources: resolvedExistingSpec?.sources
}
```

For normal sessions, preserve existing behavior and set mode only if useful:

```ts
executionPolicy: payload.executionPolicy ? { ...payload.executionPolicy, mode } : payload.executionPolicy ?? null
```

Immediately after `input.repository.create(...)`, save:

```ts
if (resolvedExistingSpec) {
  input.repository.savePhaseResult({
    sessionId: id,
    phase: "existing_spec_input",
    resultJson: JSON.stringify({
      spec: resolvedExistingSpec.spec,
      implementationPlan: resolvedExistingSpec.implementationPlan,
      sources: resolvedExistingSpec.sources
    })
  });
}
```

**Step 5: Adjust logs and summaries**

For existing-spec sessions, use creation summary text:

```ts
currentUnderstanding: "Existing spec review session created. Phase 1 is starting.",
recommendation: "Watch live progress while Crossfire reviews the supplied documents and aligns on any questions."
```

**Step 6: Run tests**

Run:

```bash
pnpm vitest run apps/daemon/src/services/existing-spec-input.test.ts apps/daemon/src/services/session-service-spec-driven.test.ts apps/daemon/src/services/session-service.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/daemon/src/services/session-service.ts apps/daemon/src/services/session-service-spec-driven.test.ts apps/daemon/src/services/session-service.test.ts
git commit -m "feat: create existing spec review sessions"
```

---

### Task 5: Add Existing-Spec Prompt Framing

**Files:**
- Modify: `packages/adapters/src/prompts/phase-prompts.ts`
- Modify: `packages/adapters/src/prompts/structured-turn.test.ts` or create `packages/adapters/src/prompts/phase-prompts.test.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/session-service.ts`

**Step 1: Write failing prompt tests**

Create `packages/adapters/src/prompts/phase-prompts.test.ts` if it does not already exist:

```ts
import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, buildSpecPrompt } from "./phase-prompts";

describe("existing spec prompt framing", () => {
  it("frames analysis as review when session mode is existing_spec", () => {
    const prompt = buildAnalysisPrompt({
      role: "gpt",
      originalProblem: "EXISTING SPECIFICATION:\n# Spec",
      mode: "existing_spec"
    });

    expect(prompt).toContain("PHASE: EXISTING SPEC REVIEW ANALYSIS");
    expect(prompt).toContain("Treat the submitted spec and implementation plan as the subject under review");
    expect(prompt).toContain("Ask questions only when the supplied documents do not contain enough information");
  });

  it("frames spec generation as revision when session mode is existing_spec", () => {
    const prompt = buildSpecPrompt({
      role: "claude",
      originalProblem: "EXISTING SPECIFICATION:\n# Spec",
      interviewResults: [],
      approachResult: "Revision strategy",
      mode: "existing_spec"
    });

    expect(prompt).toContain("PHASE: EXISTING SPEC REVISION");
    expect(prompt).toContain("Revise the supplied specification and implementation plan");
    expect(prompt).not.toContain("produce TWO separate markdown documents:");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/prompts/phase-prompts.test.ts`

Expected: FAIL because prompt builders do not accept `mode`.

**Step 3: Add optional mode to prompt builders**

In `packages/adapters/src/prompts/phase-prompts.ts`, add `mode?: "new_spec" | "existing_spec"` to `buildAnalysisPrompt` and `buildSpecPrompt`.

For `buildAnalysisPrompt`, switch heading and instructions:

```ts
const existingSpecMode = input.mode === "existing_spec";
```

Use:

```ts
existingSpecMode ? "PHASE: EXISTING SPEC REVIEW ANALYSIS" : "PHASE: INDEPENDENT ANALYSIS"
```

and in existing mode replace the "Analyze the following problem" instructions with review-oriented instructions from the design doc.

For `buildSpecPrompt`, use:

```ts
existingSpecMode
  ? "PHASE: EXISTING SPEC REVISION"
  : "PHASE: SPEC GENERATION"
```

and tell the model to preserve valid existing content and revise the supplied documents.

**Step 4: Thread mode through orchestrator**

In `apps/daemon/src/services/phase-orchestrator.ts`, add optional mode parameters to:

- `runDualAnalysis(sessionId, prompt, runId?, mode?)`
- `runSpecGeneration(sessionId, prompt, interviewResults, finalApproachHandoff, runId?, mode?)`

Pass `mode` into `buildAnalysisPrompt` and all `buildSpecPrompt` calls.

In `apps/daemon/src/services/session-service.ts`, derive:

```ts
function getSessionMode(session: { executionPolicy?: ExecutionPolicy | null }) {
  return session.executionPolicy?.mode ?? "new_spec";
}
```

Pass mode when calling `runDualAnalysis` and `runSpecGeneration`.

**Step 5: Run adapter and daemon tests**

Run:

```bash
pnpm vitest run packages/adapters/src/prompts/phase-prompts.test.ts apps/daemon/src/services/session-service-spec-driven.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/adapters/src/prompts/phase-prompts.ts packages/adapters/src/prompts/phase-prompts.test.ts apps/daemon/src/services/phase-orchestrator.ts apps/daemon/src/services/session-service.ts
git commit -m "feat: frame prompts for existing spec review"
```

---

### Task 6: Add Existing Spec Review Form

**Files:**
- Create: `apps/web/src/components/existing-spec-form.tsx`
- Create: `apps/web/src/components/existing-spec-form.test.tsx`
- Modify: `apps/web/src/styles/app.css`

**Step 1: Write failing component tests**

Create `apps/web/src/components/existing-spec-form.test.tsx`:

```tsx
// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExistingSpecForm } from "./existing-spec-form";

describe("ExistingSpecForm", () => {
  it("submits pasted spec and plan text", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Review focus"), {
      target: { value: "Focus on rollout risk." }
    });
    fireEvent.change(screen.getByLabelText("Specification text"), {
      target: { value: "# Existing Spec" }
    });
    fireEvent.change(screen.getByLabelText("Implementation plan text"), {
      target: { value: "# Existing Plan" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Existing spec review",
        prompt: "Focus on rollout risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      });
    });
  });

  it("submits daemon path references without reading browser files", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Spec path" }));
    fireEvent.change(screen.getByLabelText("Specification path"), {
      target: { value: "/repo/specs/auth.md" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "auth.md",
        prompt: "",
        existingSpec: { specPath: "/repo/specs/auth.md" }
      });
    });
  });

  it("reads uploaded markdown files as request text", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Spec upload" }));
    const file = new File(["# Uploaded Spec"], "uploaded-spec.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Specification file"), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "uploaded-spec.md",
        prompt: "",
        existingSpec: {
          spec: "# Uploaded Spec",
          specFileName: "uploaded-spec.md"
        }
      });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/components/existing-spec-form.test.tsx`

Expected: FAIL because component does not exist.

**Step 3: Implement the form**

Create `apps/web/src/components/existing-spec-form.tsx`.

Use local state for:

```ts
type SourceMode = "paste" | "path" | "upload";
```

Props:

```ts
interface ExistingSpecFormProps {
  onCreate(input: {
    title: string;
    prompt: string;
    existingSpec: ExistingSpecInput;
  }): Promise<void>;
}
```

Render:

- A card form with "Review focus" textarea.
- A segmented source chooser for spec: `Spec paste`, `Spec path`, `Spec upload`.
- A textarea, text input, or file input based on mode.
- A segmented source chooser for plan: `Plan paste`, `Plan path`, `Plan upload`.
- Optional plan source fields.
- Submit button `Start review`.

On submit:

- Read upload files with `await file.text()`.
- Build `existingSpec` using only selected source values.
- Require one spec source.
- Derive title from uploaded file name, path basename, first markdown heading, or `"Existing spec review"`.

**Step 4: Add CSS**

In `apps/web/src/styles/app.css`, add classes:

```css
.mode-tabs,
.source-toggle {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  background: var(--bg-surface);
}

.mode-tabs button,
.source-toggle button {
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--ink-secondary);
  background: transparent;
  cursor: pointer;
}

.mode-tabs button[aria-selected="true"],
.source-toggle button[aria-pressed="true"] {
  color: white;
  background: var(--accent);
}

.existing-spec-form__section {
  display: grid;
  gap: 10px;
}
```

Keep radii consistent with the current app, and ensure mobile wrapping with `flex-wrap: wrap`.

**Step 5: Run component tests**

Run: `pnpm vitest run apps/web/src/components/existing-spec-form.test.tsx`

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/web/src/components/existing-spec-form.tsx apps/web/src/components/existing-spec-form.test.tsx apps/web/src/styles/app.css
git commit -m "feat: add existing spec review form"
```

---

### Task 7: Wire The Web Entry Tabs And API Call

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Write failing app tests**

In `apps/web/src/App.test.tsx`, extend the API mock with `createSessionMock`.

Add:

```tsx
it("switches to existing spec review and creates an existing-spec session", async () => {
  createSessionMock.mockResolvedValue({
    session: {
      id: "sess_existing",
      title: "uploaded-spec.md",
      status: "debating",
      phase: "analysis",
      prompt: "HUMAN REVIEW CONTEXT:\nNo additional context supplied.",
      executionPolicy: { mode: "existing_spec" }
    },
    summary: {
      currentUnderstanding: "Existing spec review session created. Phase 1 is starting.",
      recommendation: "Watch live progress while Crossfire reviews the supplied documents.",
      changedSinceLastCheckpoint: ["Session created"],
      openRisks: [],
      decisionsNeeded: []
    },
    activeRun: {
      id: "run_existing",
      sessionId: "sess_existing",
      kind: "create",
      status: "running",
      phase: "analysis",
      startedAt: new Date().toISOString()
    },
    recentRuns: []
  });

  render(<App />);

  fireEvent.click(screen.getByRole("tab", { name: "Review Existing Spec" }));
  fireEvent.change(screen.getByLabelText("Specification text"), {
    target: { value: "# Existing Spec" }
  });
  fireEvent.click(screen.getByRole("button", { name: "Start review" }));

  await waitFor(() => {
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: "existing_spec",
      title: "Existing spec review",
      existingSpec: { spec: "# Existing Spec" }
    }));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/App.test.tsx`

Expected: FAIL because tabs and handler do not exist.

**Step 3: Update API function**

In `apps/web/src/lib/api.ts`, ensure `createSession` includes:

```ts
mode: input.mode,
existingSpec: input.existingSpec
```

in the JSON body only when provided.

**Step 4: Wire App state**

In `apps/web/src/App.tsx`:

- Import `ExistingSpecForm`.
- Add `const [homeMode, setHomeMode] = useState<"new_spec" | "existing_spec">("new_spec");`
- Add `handleCreateExistingSpec`.

Implementation:

```ts
async function handleCreateExistingSpec(input: {
  title: string;
  prompt: string;
  existingSpec: ExistingSpecInput;
}) {
  setError(null);
  try {
    const payload = await createSession({
      title: input.title,
      prompt: input.prompt,
      token,
      mode: "existing_spec",
      existingSpec: input.existingSpec
    });
    setPreviousSessions((prev) => [
      { id: payload.session.id, title: payload.session.title, status: payload.session.status, phase: payload.session.phase },
      ...prev
    ]);
    setSessionAndNavigate(payload);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Something went wrong");
  }
}
```

When `!session`, render a tablist:

```tsx
<div className="mode-tabs" role="tablist" aria-label="Session type">
  <button role="tab" aria-selected={homeMode === "new_spec"} onClick={() => setHomeMode("new_spec")}>New Spec</button>
  <button role="tab" aria-selected={homeMode === "existing_spec"} onClick={() => setHomeMode("existing_spec")}>Review Existing Spec</button>
</div>
```

Render `SessionForm` for `new_spec` and `ExistingSpecForm` for `existing_spec`.

**Step 5: Add mode-aware guidance**

In `getPhaseExplanation`, when `session.session.executionPolicy?.mode === "existing_spec"`, use:

- analysis active: `"Both models are reviewing the supplied spec and implementation plan before aligning on questions."`
- interview: `"The models found questions that need answers before they can revise the supplied documents."`
- approach_debate: `"Using the supplied documents and your answers, the models are debating the revision strategy."`
- spec_generation: `"The models are revising the supplied specification and implementation plan."`

**Step 6: Run web tests**

Run:

```bash
pnpm vitest run apps/web/src/App.test.tsx apps/web/src/components/existing-spec-form.test.tsx apps/web/src/components/session-form.test.tsx
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/lib/api.ts
git commit -m "feat: wire existing spec review entry point"
```

---

### Task 8: Add End-To-End Coverage For Existing Spec Creation

**Files:**
- Create: `apps/web/tests/existing-spec-review.spec.ts`

**Step 1: Write failing Playwright test**

Create `apps/web/tests/existing-spec-review.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("creates an existing spec review session from pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Review Existing Spec" }).click();
  await page.getByLabel("Specification text").fill("# Existing Spec\nShip a dashboard.");
  await page.getByLabel("Implementation plan text").fill("# Existing Plan\n1. Build the UI.");
  await page.getByRole("button", { name: "Start review" }).click();

  await expect(page.getByText(/reviewing the supplied spec/i)).toBeVisible();
});
```

**Step 2: Run test to verify it fails or identify fixture gap**

Run: `pnpm --filter @council/web test -- existing-spec-review.spec.ts`

If the web Playwright setup uses a mocked backend, update the fixture consistently with `apps/web/tests/session-creation.spec.ts`. If it relies on the daemon, run the full app through the existing Playwright config.

Expected before implementation: FAIL because the UI tab does not exist. Expected after implementation: PASS.

**Step 3: Commit**

```bash
git add apps/web/tests/existing-spec-review.spec.ts
git commit -m "test: cover existing spec review creation"
```

---

### Task 9: Documentation And Final Verification

**Files:**
- Modify: `README.md`

**Step 1: Update README**

In `README.md`, update "How it works" to mention both entry points:

```md
Crossfire can either start from a new problem statement or review an existing spec / implementation plan.
```

Add a short section after Quick start:

```md
## Reviewing existing specs

Use the "Review Existing Spec" tab to upload `.md` / `.txt` files, paste text, or reference file paths readable by the daemon. Browser uploads are read in the web app and sent as text. File paths are read by the daemon process, so relative paths resolve from the directory where the daemon was started.
```

**Step 2: Run focused verification**

Run:

```bash
pnpm vitest run apps/daemon/src/services/existing-spec-input.test.ts apps/daemon/src/routes/sessions.test.ts apps/daemon/src/services/session-service-spec-driven.test.ts apps/web/src/components/existing-spec-form.test.tsx apps/web/src/App.test.tsx packages/adapters/src/prompts/phase-prompts.test.ts
pnpm build
```

Expected: all tests pass and build succeeds.

**Step 3: Run full verification**

Run: `pnpm test`

Expected: all tests pass. If Playwright is not part of `pnpm test`, also run the existing Playwright command used in the repo, likely `pnpm --filter @council/web exec playwright test`.

**Step 4: Commit README**

```bash
git add README.md
git commit -m "docs: document existing spec review flow"
```

**Step 5: Final status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: clean worktree and recent commits for the existing-spec flow.
