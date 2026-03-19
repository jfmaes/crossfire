# Crossfire V1 Implementation Plan

> **ARCHIVED** — This blueprint was fully executed. The system evolved significantly beyond v1 (4-phase lifecycle replacing the original 5-phase design, consensus-driven debate replacing fixed turn counts, dual artifact output, session management with restart/delete, SSE progress streaming, hash routing). See `2026-03-18-implementation-status.md` for current state.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-first web app where Codex and Claude collaborate on a shared spec and implementation plan with bounded checkpoints, read-only repo grounding, and mobile-friendly human steering.

**Architecture:** Use a pnpm TypeScript monorepo with a React web app, a Fastify daemon, shared orchestration logic in `packages/core`, provider adapters in `packages/adapters`, and SQLite persistence in `packages/storage`. The daemon owns all CLI interaction, session state, checkpoint policy, artifact generation, and LAN-safe access control.

**Tech Stack:** TypeScript, pnpm workspaces, React, Vite, Fastify, WebSocket, Zod, better-sqlite3, Vitest, Testing Library, Playwright, pino

---

### Task 1: Bootstrap the Monorepo and Git Baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`
- Create: `apps/web/package.json`
- Create: `apps/daemon/package.json`
- Create: `packages/core/package.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/smoke.test.ts`
- Create: `packages/adapters/package.json`
- Create: `packages/storage/package.json`

**Step 1: Write the failing test**

```ts
// packages/core/src/smoke.test.ts
import { describe, expect, it } from "vitest";
import { workspaceName } from "./index";

describe("workspace bootstrap", () => {
  it("exports the project name", () => {
    expect(workspaceName).toBe("the-council");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/smoke.test.ts`

Expected: FAIL with module resolution errors because the workspace files and `workspaceName` export do not exist yet

**Step 3: Write minimal implementation**

```json
// package.json
{
  "name": "the-council",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "scripts": {
    "build": "pnpm -r build",
    "dev:web": "pnpm --filter @council/web dev",
    "dev:daemon": "pnpm --filter @council/daemon dev",
    "test": "vitest --workspace vitest.workspace.ts run",
    "test:watch": "vitest --workspace vitest.workspace.ts"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

```json
// packages/core/package.json
{
  "name": "@council/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts"
}
```

```ts
// packages/core/src/index.ts
export const workspaceName = "the-council";
```

**Step 4: Run test to verify it passes**

Run: `pnpm install`

Run: `pnpm vitest run packages/core/src/smoke.test.ts`

Expected: PASS

**Step 5: Commit**

Run:

```bash
git init
git add .
git commit -m "chore: bootstrap council monorepo"
```

### Task 2: Define Shared Contracts for Sessions, Turns, and Checkpoints

**Files:**
- Create: `packages/core/src/contracts/session.ts`
- Create: `packages/core/src/contracts/session.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/core/src/contracts/session.test.ts
import { describe, expect, it } from "vitest";
import { modelTurnSchema, sessionStatusSchema } from "./session";

describe("session contracts", () => {
  it("parses a model turn envelope", () => {
    const parsed = modelTurnSchema.parse({
      actor: "gpt",
      summary: "Refined the scope",
      newInsights: ["Need a checkpoint timer"],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: "Add hybrid checkpointing",
      milestoneReached: null
    });

    expect(parsed.actor).toBe("gpt");
  });

  it("limits session status to known values", () => {
    expect(sessionStatusSchema.parse("debating")).toBe("debating");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/contracts/session.test.ts`

Expected: FAIL with `Cannot find module './session'`

**Step 3: Write minimal implementation**

```ts
// packages/core/src/contracts/session.ts
import { z } from "zod";

export const actorSchema = z.enum(["human", "gpt", "claude", "system"]);
export const sessionStatusSchema = z.enum([
  "draft",
  "grounding",
  "debating",
  "checkpoint",
  "waiting_for_human",
  "finalized",
  "errored"
]);

export const modelTurnSchema = z.object({
  actor: actorSchema.exclude(["human", "system"]),
  summary: z.string(),
  newInsights: z.array(z.string()),
  assumptions: z.array(z.string()),
  disagreements: z.array(z.string()),
  questionsForPeer: z.array(z.string()),
  questionsForHuman: z.array(z.string()),
  proposedSpecDelta: z.string(),
  milestoneReached: z.string().nullable()
});

export const checkpointSummarySchema = z.object({
  currentUnderstanding: z.string(),
  recommendation: z.string(),
  changedSinceLastCheckpoint: z.array(z.string()),
  openRisks: z.array(z.string()),
  decisionsNeeded: z.array(z.string())
});

export type ModelTurn = z.infer<typeof modelTurnSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
```

```ts
// packages/core/src/index.ts
export const workspaceName = "the-council";
export * from "./contracts/session";
```

**Step 4: Run test to verify it passes**

Run: `pnpm add zod --filter @council/core`

Run: `pnpm vitest run packages/core/src/contracts/session.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core package.json pnpm-lock.yaml
git commit -m "feat: add shared session contracts"
```

### Task 3: Implement the Hybrid Checkpoint Policy and Session State Machine

**Files:**
- Create: `packages/core/src/orchestration/checkpoint-policy.ts`
- Create: `packages/core/src/orchestration/session-machine.ts`
- Create: `packages/core/src/orchestration/session-machine.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/core/src/orchestration/session-machine.test.ts
import { describe, expect, it } from "vitest";
import { applyModelTurn, createSessionState, shouldCheckpoint } from "./session-machine";

describe("session machine", () => {
  it("forces a checkpoint after four model exchanges", () => {
    let state = createSessionState();

    state = applyModelTurn(state, { actor: "gpt", summary: "", newInsights: [], assumptions: [], disagreements: [], questionsForPeer: [], questionsForHuman: [], proposedSpecDelta: "", milestoneReached: null });
    state = applyModelTurn(state, { actor: "claude", summary: "", newInsights: [], assumptions: [], disagreements: [], questionsForPeer: [], questionsForHuman: [], proposedSpecDelta: "", milestoneReached: null });
    state = applyModelTurn(state, { actor: "gpt", summary: "", newInsights: [], assumptions: [], disagreements: [], questionsForPeer: [], questionsForHuman: [], proposedSpecDelta: "", milestoneReached: null });
    state = applyModelTurn(state, { actor: "claude", summary: "", newInsights: [], assumptions: [], disagreements: [], questionsForPeer: [], questionsForHuman: [], proposedSpecDelta: "", milestoneReached: null });

    expect(shouldCheckpoint(state)).toBe(true);
  });

  it("checkpoints early when a model needs human input", () => {
    const state = applyModelTurn(createSessionState(), {
      actor: "claude",
      summary: "",
      newInsights: [],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: ["Which repo should we ground against?"],
      proposedSpecDelta: "",
      milestoneReached: null
    });

    expect(shouldCheckpoint(state)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/orchestration/session-machine.test.ts`

Expected: FAIL with missing exports

**Step 3: Write minimal implementation**

```ts
// packages/core/src/orchestration/checkpoint-policy.ts
import type { ModelTurn } from "../contracts/session";

export interface SessionState {
  exchangeCount: number;
  turns: ModelTurn[];
}

export function shouldCheckpoint(state: SessionState): boolean {
  const latestTurn = state.turns.at(-1);

  if (!latestTurn) return false;
  if (state.exchangeCount >= 4) return true;
  if (latestTurn.questionsForHuman.length > 0) return true;
  if (latestTurn.milestoneReached) return true;
  if (latestTurn.disagreements.length > 0) return true;

  return false;
}
```

```ts
// packages/core/src/orchestration/session-machine.ts
import type { ModelTurn } from "../contracts/session";
import { shouldCheckpoint, type SessionState } from "./checkpoint-policy";

export function createSessionState(): SessionState {
  return { exchangeCount: 0, turns: [] };
}

export function applyModelTurn(state: SessionState, turn: ModelTurn): SessionState {
  return {
    exchangeCount: state.exchangeCount + 1,
    turns: [...state.turns, turn]
  };
}

export { shouldCheckpoint };
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/orchestration/session-machine.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/core
git commit -m "feat: add checkpoint policy and session state machine"
```

### Task 4: Add SQLite Persistence for Sessions, Events, and Artifacts

**Files:**
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/session-repository.ts`
- Create: `packages/storage/src/session-repository.test.ts`
- Create: `packages/storage/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/storage/src/session-repository.test.ts
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database";
import { SessionRepository } from "./session-repository";

describe("SessionRepository", () => {
  it("persists a new session", () => {
    const db = createInMemoryDatabase();
    const repo = new SessionRepository(db);

    repo.create({
      id: "sess_1",
      title: "Spec a local dual-LLM tool",
      status: "draft"
    });

    expect(repo.findById("sess_1")?.title).toBe("Spec a local dual-LLM tool");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/storage/src/session-repository.test.ts`

Expected: FAIL because storage files do not exist

**Step 3: Write minimal implementation**

```ts
// packages/storage/src/database.ts
import Database from "better-sqlite3";

export function createInMemoryDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return db;
}
```

```ts
// packages/storage/src/session-repository.ts
import type Database from "better-sqlite3";

interface SessionRow {
  id: string;
  title: string;
  status: string;
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(session: SessionRow): void {
    this.db
      .prepare("INSERT INTO sessions (id, title, status) VALUES (@id, @title, @status)")
      .run(session);
  }

  findById(id: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT id, title, status FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm add better-sqlite3 --filter @council/storage`

Run: `pnpm vitest run packages/storage/src/session-repository.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/storage pnpm-lock.yaml
git commit -m "feat: add sqlite session storage"
```

### Task 5: Create the Provider Adapter Interface and Fake Providers

**Files:**
- Create: `packages/adapters/src/base/provider-adapter.ts`
- Create: `packages/adapters/src/testing/fake-provider.ts`
- Create: `packages/adapters/src/base/provider-adapter.test.ts`
- Create: `packages/adapters/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/adapters/src/base/provider-adapter.test.ts
import { describe, expect, it } from "vitest";
import { FakeProvider } from "../testing/fake-provider";

describe("FakeProvider", () => {
  it("streams normalized provider events", async () => {
    const provider = new FakeProvider("gpt");
    const events: string[] = [];

    for await (const event of provider.sendTurn({
      sessionId: "sess_1",
      prompt: "Outline the risks"
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["status", "turn", "done"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/base/provider-adapter.test.ts`

Expected: FAIL because the adapter layer does not exist

**Step 3: Write minimal implementation**

```ts
// packages/adapters/src/base/provider-adapter.ts
export interface ProviderTurnInput {
  sessionId: string;
  prompt: string;
}

export type NormalizedProviderEvent =
  | { type: "status"; value: "started" | "streaming" }
  | { type: "turn"; actor: "gpt" | "claude"; text: string }
  | { type: "done" };

export interface ProviderAdapter {
  name: "gpt" | "claude";
  sendTurn(input: ProviderTurnInput): AsyncGenerator<NormalizedProviderEvent>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
```

```ts
// packages/adapters/src/testing/fake-provider.ts
import type { ProviderAdapter, ProviderTurnInput } from "../base/provider-adapter";

export class FakeProvider implements ProviderAdapter {
  constructor(public readonly name: "gpt" | "claude") {}

  async *sendTurn(_input: ProviderTurnInput) {
    yield { type: "status", value: "started" } as const;
    yield { type: "turn", actor: this.name, text: `${this.name} response` } as const;
    yield { type: "done" } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "fake provider ready" };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/base/provider-adapter.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat: add provider adapter interface"
```

### Task 6: Implement the Codex Adapter Behind a Transport Boundary

**Files:**
- Create: `packages/adapters/src/codex/codex-transport.ts`
- Create: `packages/adapters/src/codex/codex-adapter.ts`
- Create: `packages/adapters/src/codex/codex-adapter.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/adapters/src/codex/codex-adapter.test.ts
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter";

class FakeCodexTransport {
  async *runTurn() {
    yield { kind: "text", text: "We should bound the checkpoint loop." };
  }
}

describe("CodexAdapter", () => {
  it("normalizes transport events into provider events", async () => {
    const adapter = new CodexAdapter(new FakeCodexTransport() as never);
    const events: string[] = [];

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Review the checkpoint logic"
    })) {
      events.push(event.type);
    }

    expect(events).toContain("turn");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/codex/codex-adapter.test.ts`

Expected: FAIL because `CodexAdapter` is missing

**Step 3: Write minimal implementation**

```ts
// packages/adapters/src/codex/codex-transport.ts
export interface CodexTransport {
  runTurn(input: { sessionId: string; prompt: string }): AsyncGenerator<{ kind: "text"; text: string }>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
```

```ts
// packages/adapters/src/codex/codex-adapter.ts
import type { ProviderAdapter } from "../base/provider-adapter";
import type { CodexTransport } from "./codex-transport";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "gpt";

  constructor(private readonly transport: CodexTransport) {}

  async *sendTurn(input: { sessionId: string; prompt: string }) {
    yield { type: "status", value: "started" } as const;
    for await (const event of this.transport.runTurn(input)) {
      yield { type: "turn", actor: "gpt", text: event.text } as const;
    }
    yield { type: "done" } as const;
  }

  healthCheck() {
    return this.transport.healthCheck();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/codex/codex-adapter.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat: add codex adapter boundary"
```

### Task 7: Implement the Claude Adapter with Stream-JSON Parsing and Degraded Mode

**Files:**
- Create: `packages/adapters/src/claude/claude-process.ts`
- Create: `packages/adapters/src/claude/claude-adapter.ts`
- Create: `packages/adapters/src/claude/claude-adapter.test.ts`
- Modify: `packages/adapters/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/adapters/src/claude/claude-adapter.test.ts
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";

class FakeClaudeProcess {
  async *runTurn() {
    yield { type: "assistant", text: "Need the human to confirm mobile support." };
  }

  async healthCheck() {
    return { ok: true, detail: "claude ready" };
  }
}

describe("ClaudeAdapter", () => {
  it("normalizes streamed Claude messages", async () => {
    const adapter = new ClaudeAdapter(new FakeClaudeProcess() as never);
    const events: string[] = [];

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Find hidden risks"
    })) {
      events.push(event.type);
    }

    expect(events).toContain("turn");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapters/src/claude/claude-adapter.test.ts`

Expected: FAIL because the Claude adapter does not exist

**Step 3: Write minimal implementation**

```ts
// packages/adapters/src/claude/claude-process.ts
export interface ClaudeProcess {
  runTurn(input: { sessionId: string; prompt: string; degraded?: boolean }): AsyncGenerator<{ type: "assistant"; text: string }>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
```

```ts
// packages/adapters/src/claude/claude-adapter.ts
import type { ProviderAdapter } from "../base/provider-adapter";
import type { ClaudeProcess } from "./claude-process";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  constructor(private readonly processRunner: ClaudeProcess) {}

  async *sendTurn(input: { sessionId: string; prompt: string }) {
    yield { type: "status", value: "started" } as const;
    for await (const event of this.processRunner.runTurn(input)) {
      yield { type: "turn", actor: "claude", text: event.text } as const;
    }
    yield { type: "done" } as const;
  }

  healthCheck() {
    return this.processRunner.healthCheck();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/adapters/src/claude/claude-adapter.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/adapters
git commit -m "feat: add claude adapter boundary"
```

### Task 8: Build the Read-Only Grounding Service

**Files:**
- Create: `apps/daemon/src/services/grounding.ts`
- Create: `apps/daemon/src/services/grounding.test.ts`

**Step 1: Write the failing test**

```ts
// apps/daemon/src/services/grounding.test.ts
import { describe, expect, it } from "vitest";
import { collectGroundingContext } from "./grounding";

describe("collectGroundingContext", () => {
  it("filters files to a read-only, size-limited context bundle", async () => {
    const result = await collectGroundingContext({
      rootDir: "tests/fixtures/repo",
      maxFiles: 2,
      includeGlobs: ["**/*.md", "**/*.ts"]
    });

    expect(result.files.length).toBeLessThanOrEqual(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/grounding.test.ts`

Expected: FAIL because the grounding service does not exist

**Step 3: Write minimal implementation**

```ts
// apps/daemon/src/services/grounding.ts
import { promises as fs } from "node:fs";
import path from "node:path";

export async function collectGroundingContext(input: {
  rootDir: string;
  maxFiles: number;
  includeGlobs: string[];
}) {
  const entries = await fs.readdir(input.rootDir);
  const files = await Promise.all(
    entries.slice(0, input.maxFiles).map(async (name) => {
      const absolutePath = path.join(input.rootDir, name);
      const content = await fs.readFile(absolutePath, "utf8");
      return { absolutePath, content };
    })
  );

  return { files };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/daemon/src/services/grounding.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/daemon
git commit -m "feat: add read-only grounding service"
```

### Task 9: Implement the Orchestrator Service

**Files:**
- Create: `apps/daemon/src/services/orchestrator.ts`
- Create: `apps/daemon/src/services/orchestrator.test.ts`
- Modify: `apps/daemon/package.json`

**Step 1: Write the failing test**

```ts
// apps/daemon/src/services/orchestrator.test.ts
import { describe, expect, it } from "vitest";
import { FakeProvider } from "@council/adapters/src/testing/fake-provider";
import { createOrchestrator } from "./orchestrator";

describe("orchestrator", () => {
  it("stops after the fourth exchange and emits a checkpoint", async () => {
    const orchestrator = createOrchestrator({
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Spec a local collaboration tool"
    });

    expect(result.shouldCheckpoint).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/orchestrator.test.ts`

Expected: FAIL because the orchestrator does not exist

**Step 3: Write minimal implementation**

```ts
// apps/daemon/src/services/orchestrator.ts
import { applyModelTurn, createSessionState, shouldCheckpoint } from "@council/core/src/orchestration/session-machine";

export function createOrchestrator(input: {
  gpt: { sendTurn(args: { sessionId: string; prompt: string }): AsyncGenerator<{ type: string; actor?: "gpt" | "claude"; text?: string }> };
  claude: { sendTurn(args: { sessionId: string; prompt: string }): AsyncGenerator<{ type: string; actor?: "gpt" | "claude"; text?: string }> };
}) {
  return {
    async runRound({ sessionId, prompt }: { sessionId: string; prompt: string }) {
      let state = createSessionState();

      for await (const event of input.gpt.sendTurn({ sessionId, prompt })) {
        if (event.type === "turn" && event.actor === "gpt") {
          state = applyModelTurn(state, {
            actor: "gpt",
            summary: event.text ?? "",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: "",
            milestoneReached: null
          });
        }
      }

      for await (const event of input.claude.sendTurn({ sessionId, prompt })) {
        if (event.type === "turn" && event.actor === "claude") {
          state = applyModelTurn(state, {
            actor: "claude",
            summary: event.text ?? "",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: "",
            milestoneReached: "round_complete"
          });
        }
      }

      return { shouldCheckpoint: shouldCheckpoint(state), state };
    }
  };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/daemon/src/services/orchestrator.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/daemon
git commit -m "feat: add dual-provider orchestrator"
```

### Task 10: Add the Fastify Daemon, WebSocket Feed, and LAN Access Token

**Files:**
- Create: `apps/daemon/src/server.ts`
- Create: `apps/daemon/src/routes/sessions.ts`
- Create: `apps/daemon/src/plugins/access-token.ts`
- Create: `apps/daemon/src/server.test.ts`

**Step 1: Write the failing test**

```ts
// apps/daemon/src/server.test.ts
import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("buildServer", () => {
  it("rejects requests without the local access token", async () => {
    const app = buildServer({ accessToken: "secret-token" });
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { title: "New session" }
    });

    expect(response.statusCode).toBe(401);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/server.test.ts`

Expected: FAIL because the daemon server does not exist

**Step 3: Write minimal implementation**

```ts
// apps/daemon/src/plugins/access-token.ts
import fp from "fastify-plugin";

export const accessTokenPlugin = fp(async (app, input: { accessToken: string }) => {
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-council-token"] !== input.accessToken) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });
});
```

```ts
// apps/daemon/src/server.ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { accessTokenPlugin } from "./plugins/access-token";

export function buildServer(input: { accessToken: string }) {
  const app = Fastify();
  app.register(websocket);
  app.register(accessTokenPlugin, { accessToken: input.accessToken });

  app.post("/sessions", async (_request, reply) => {
    return reply.code(201).send({ id: "sess_1" });
  });

  return app;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm add fastify @fastify/websocket fastify-plugin --filter @council/daemon`

Run: `pnpm vitest run apps/daemon/src/server.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/daemon pnpm-lock.yaml
git commit -m "feat: add daemon server and local access token"
```

### Task 11: Build the Mobile-First Web App Shell

**Files:**
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/App.test.tsx`
- Create: `apps/web/src/styles/app.css`

**Step 1: Write the failing test**

```tsx
// apps/web/src/App.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the summary-first workspace shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "The Council" })).toBeInTheDocument();
    expect(screen.getByText("Current understanding")).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/App.test.tsx`

Expected: FAIL because the web app files do not exist

**Step 3: Write minimal implementation**

```tsx
// apps/web/src/App.tsx
import "./styles/app.css";

export function App() {
  return (
    <main className="app-shell">
      <header className="hero">
        <p className="eyebrow">Local dual-LLM workshop</p>
        <h1>The Council</h1>
      </header>
      <section className="card-grid">
        <article className="card">
          <h2>Current understanding</h2>
        </article>
        <article className="card">
          <h2>Recommended direction</h2>
        </article>
      </section>
    </main>
  );
}
```

```css
/* apps/web/src/styles/app.css */
:root {
  --bg: #f5efe4;
  --ink: #1f1a16;
  --accent: #c4552d;
}

body {
  margin: 0;
  font-family: "IBM Plex Sans", sans-serif;
  background: radial-gradient(circle at top, #fff7ea, var(--bg));
  color: var(--ink);
}

.app-shell {
  padding: 16px;
}

.card-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr;
}

@media (min-width: 768px) {
  .card-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm add react react-dom --filter @council/web`

Run: `pnpm add -D @testing-library/react @testing-library/jest-dom vite @vitejs/plugin-react --filter @council/web`

Run: `pnpm vitest run apps/web/src/App.test.tsx`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add mobile-first web shell"
```

### Task 12: Add Session Creation, WebSocket Updates, and Checkpoint Cards

**Files:**
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/session-store.ts`
- Create: `apps/web/src/components/checkpoint-card.tsx`
- Create: `apps/web/src/components/checkpoint-card.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Step 1: Write the failing test**

```tsx
// apps/web/src/components/checkpoint-card.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CheckpointCard } from "./checkpoint-card";

describe("CheckpointCard", () => {
  it("renders decisions needed and open risks", () => {
    render(
      <CheckpointCard
        summary={{
          currentUnderstanding: "The app coordinates Claude and GPT locally.",
          recommendation: "Use a daemon-backed architecture.",
          changedSinceLastCheckpoint: ["Added mobile web support"],
          openRisks: ["Claude session continuity may degrade"],
          decisionsNeeded: ["Confirm the default checkpoint interval"]
        }}
      />
    );

    expect(screen.getByText("Confirm the default checkpoint interval")).toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/components/checkpoint-card.test.tsx`

Expected: FAIL because the component does not exist

**Step 3: Write minimal implementation**

```tsx
// apps/web/src/components/checkpoint-card.tsx
import { checkpointSummarySchema } from "@council/core";
import type { z } from "zod";

type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

export function CheckpointCard({ summary }: { summary: CheckpointSummary }) {
  return (
    <article className="card">
      <h2>Checkpoint</h2>
      <p>{summary.currentUnderstanding}</p>
      <h3>Decisions needed</h3>
      <ul>
        {summary.decisionsNeeded.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Open risks</h3>
      <ul>
        {summary.openRisks.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web/src/components/checkpoint-card.test.tsx`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/web
git commit -m "feat: add checkpoint workspace components"
```

### Task 13: Generate the Living Spec and Implementation Plan Artifacts

**Files:**
- Create: `apps/daemon/src/services/artifacts.ts`
- Create: `apps/daemon/src/services/artifacts.test.ts`
- Create: `data/artifacts/.gitkeep`

**Step 1: Write the failing test**

```ts
// apps/daemon/src/services/artifacts.test.ts
import { describe, expect, it } from "vitest";
import { renderSpecArtifact } from "./artifacts";

describe("renderSpecArtifact", () => {
  it("renders markdown with section headings", () => {
    const markdown = renderSpecArtifact({
      title: "The Council",
      goals: ["Bound the collaboration loop"],
      constraints: ["Read-only grounding in v1"]
    });

    expect(markdown).toContain("# The Council");
    expect(markdown).toContain("## Goals");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/daemon/src/services/artifacts.test.ts`

Expected: FAIL because artifact generation does not exist

**Step 3: Write minimal implementation**

```ts
// apps/daemon/src/services/artifacts.ts
export function renderSpecArtifact(input: {
  title: string;
  goals: string[];
  constraints: string[];
}) {
  return [
    `# ${input.title}`,
    "",
    "## Goals",
    ...input.goals.map((goal) => `- ${goal}`),
    "",
    "## Constraints",
    ...input.constraints.map((constraint) => `- ${constraint}`)
  ].join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/daemon/src/services/artifacts.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/daemon data/artifacts
git commit -m "feat: add markdown artifact generation"
```

### Task 14: Add Mobile Smoke Tests and Local Startup Docs

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/tests/mobile-smoke.spec.ts`
- Create: `README.md`

**Step 1: Write the failing test**

```ts
// apps/web/tests/mobile-smoke.spec.ts
import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["iPhone 13"] });

test("mobile layout shows checkpoint cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Current understanding")).toBeVisible();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm exec playwright test apps/web/tests/mobile-smoke.spec.ts`

Expected: FAIL because Playwright and the app startup docs are not configured yet

**Step 3: Write minimal implementation**

```md
<!-- README.md -->
# The Council

Local-first web app for dual-LLM specification work.

## Development

1. `pnpm install`
2. `pnpm dev:daemon`
3. `pnpm dev:web`
4. Open the local URL on desktop or phone on the same LAN
5. Send the `x-council-token` header generated by the daemon
```

```ts
// apps/web/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:5173"
  }
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm add -D @playwright/test --filter @council/web`

Run: `pnpm exec playwright install --with-deps chromium`

Run: `pnpm exec playwright test apps/web/tests/mobile-smoke.spec.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add README.md apps/web pnpm-lock.yaml
git commit -m "docs: add startup guide and mobile smoke tests"
```

## Execution Handoff

Plan complete and saved to `docs/plans/2026-03-18-the-council-v1-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?

## Current Status

### Completed Beyond Original Scaffold

- Real Codex CLI transport added
- Real Claude CLI process runner added
- Fake-provider mode retained for deterministic e2e validation
- Session creation, retrieval, artifact writing, and runtime health routes implemented
- Mobile-first web shell wired to real daemon session creation
- File-backed SQLite persistence added for real mode
- Session summary persistence moved out of in-memory-only storage
- Session status transitions wired into session creation flow
- CLI timeout handling added
- Optional grounding injection wired into session creation
- Structured-turn architecture partially implemented:
  - shared `ModelTurn` schema extended with `rawText`, enum `milestoneReached`, and `degraded`
  - generated Codex schema asset from Zod source
  - both providers now target final structured turn output
  - adapters validate/parse structured turns and emit `structured_turn`
  - orchestrator consumes structured turns instead of fabricating empty fields

### Still To Do

- Run a full daemon session using live real providers end-to-end after the structured-turn migration
- Add explicit degraded-turn UI indicator rather than only surfacing it as an open risk
- Add metrics/logging for degraded turns and structured-turn latency
- Tighten prompt budgeting/truncation policy for longer multi-turn sessions
- Expand UI beyond first-checkpoint request/response into richer multi-checkpoint history
