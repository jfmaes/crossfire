# Crossfire Runtime Integration Plan

> **ARCHIVED** — Fully executed. All integration tasks completed including real CLI transports, structured turns, SSE progress streaming, session management. See `2026-03-18-implementation-status.md` for current state.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fake provider loop with real local `codex` and `claude` CLI integrations, then expose a first end-to-end session path through the daemon and web UI.

**Architecture:** Keep the existing package boundaries, but extend `packages/adapters` with real subprocess-backed Codex and Claude runners. The daemon should own session creation, checkpoint emission, storage, and access control, while the web app moves from static sample data to a live session bootstrap flow.

**Tech Stack:** Existing pnpm monorepo, TypeScript, Fastify, WebSocket, React, Vite, Zod, better-sqlite3, local `codex` CLI, local `claude` CLI

---

## Status Snapshot

### Completed

- Real Codex CLI transport implemented with JSONL parsing and explicit reasoning-effort override
- Real Claude CLI runner implemented with `stream-json` parsing and `--verbose`
- Provider event contract expanded to handle `stderr`, `error`, and final text markers
- Daemon session service implemented
- Session creation and retrieval routes implemented
- Web app session bootstrap form implemented
- Mobile and session-creation Playwright smoke tests implemented
- Fake provider mode retained for deterministic e2e/browser verification
- Health route implemented and surfaced in the UI
- Artifact persistence implemented
- File-backed SQLite persistence implemented for real mode
- Session summary persistence moved out of the in-memory map and into SQLite
- Session status transitions are now updated by the session service instead of being hardcoded at creation time
- CLI subprocess timeouts added to Codex and Claude transports
- Optional grounding path wired into session creation
- Unused WebSocket registration removed
- Structured-turn migration started:
  - single shared `modelTurnSchema` extended instead of introducing a second schema
  - generated JSON schema asset from Zod source for Codex
  - adapters now own structured parsing and degraded fallback
  - `structured_turn` event introduced for orchestration
  - orchestrator now consumes structured turns rather than text-only placeholders

### Still To Do

- Exercise the new structured-turn path through the live real-provider daemon flow
- Use the new structured fields to tighten more semantic checkpoint test coverage beyond the current early-human-question case
- Add true streaming session progress from daemon to UI rather than only first-checkpoint request/response
- Add richer persistence for multi-checkpoint sessions and resumable history beyond the current first-round flow
- Add explicit UI for selecting or attaching grounding roots instead of only environment-driven grounding
- Add deterministic tests for more of the real-provider path, not only fake-mode browser e2e
- Add explicit degraded-turn UI indicator and metrics

### Main Open Architectural Gap

The largest unresolved item is no longer basic structured turn extraction itself; that path now exists. The main gap is **operational confidence in the structured path**:

- real-provider end-to-end validation through the daemon after the migration
- stronger semantic checkpoint coverage for disagreements and milestones
- degraded-turn observability in both logs and UI

### Task 1: Enrich the Provider Event Contract for Real Streaming

**Files:**
- Modify: `packages/adapters/src/base/provider-adapter.ts`
- Create: `packages/adapters/src/base/provider-adapter.integration.test.ts`

**Step 1: Write the failing test**

Assert that a provider can emit `status`, `turn`, `stderr`, and `done` events, and that `turn` events may carry partial or final text.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run packages/adapters/src/base/provider-adapter.integration.test.ts`

Expected: FAIL because the current provider contract is too narrow

**Step 3: Write minimal implementation**

Expand `NormalizedProviderEvent` to include stream metadata needed by real CLI adapters, including stderr/debug lines and a `final` marker for completed text chunks.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run packages/adapters/src/base/provider-adapter.integration.test.ts`

Expected: PASS

### Task 2: Implement a Real Codex CLI Transport

**Files:**
- Create: `packages/adapters/src/codex/codex-cli-transport.ts`
- Create: `packages/adapters/src/codex/codex-cli-transport.test.ts`
- Modify: `packages/adapters/src/codex/codex-transport.ts`

**Step 1: Write the failing test**

Assert that a JSONL transcript from `codex exec --json` is normalized into provider events and that the transport forces `model_reasoning_effort="high"` to avoid the local `xhigh` config mismatch.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run packages/adapters/src/codex/codex-cli-transport.test.ts`

Expected: FAIL because no real Codex transport exists

**Step 3: Write minimal implementation**

Spawn `codex exec --json -c 'model_reasoning_effort="high"'`, parse JSONL, map `item.completed` agent messages into `turn` events, and surface CLI errors as structured provider failures.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run packages/adapters/src/codex/codex-cli-transport.test.ts`

Expected: PASS

### Task 3: Implement a Real Claude CLI Process Runner

**Files:**
- Create: `packages/adapters/src/claude/claude-cli-process.ts`
- Create: `packages/adapters/src/claude/claude-cli-process.test.ts`
- Modify: `packages/adapters/src/claude/claude-process.ts`

**Step 1: Write the failing test**

Assert that `claude -p --verbose --output-format stream-json` events are normalized and that the final `result` event becomes the provider’s final text.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run packages/adapters/src/claude/claude-cli-process.test.ts`

Expected: FAIL because no real Claude runner exists

**Step 3: Write minimal implementation**

Spawn `claude -p --verbose --output-format stream-json`, parse line-delimited JSON, emit partial stderr/system events as non-turn events, and emit the assistant `result` as the final provider turn.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run packages/adapters/src/claude/claude-cli-process.test.ts`

Expected: PASS

### Task 4: Add a Daemon Session Service with Real Providers

**Files:**
- Create: `apps/daemon/src/services/session-service.ts`
- Create: `apps/daemon/src/services/session-service.test.ts`
- Modify: `apps/daemon/src/services/orchestrator.ts`

**Step 1: Write the failing test**

Assert that creating a session stores it, runs one bounded orchestration round, and returns a checkpoint summary payload.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run apps/daemon/src/services/session-service.test.ts`

Expected: FAIL because there is no session service yet

**Step 3: Write minimal implementation**

Wire the storage, orchestrator, and artifact generator together so the daemon can create a session, run a round, and persist the resulting state.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run apps/daemon/src/services/session-service.test.ts`

Expected: PASS

### Task 5: Expose Session Creation and Retrieval Routes

**Files:**
- Modify: `apps/daemon/src/routes/sessions.ts`
- Create: `apps/daemon/src/routes/sessions.test.ts`

**Step 1: Write the failing test**

Assert that `POST /sessions` accepts a prompt, creates a real session, and returns the checkpoint summary; assert that `GET /sessions/:id` returns stored state.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run apps/daemon/src/routes/sessions.test.ts`

Expected: FAIL because the current route only returns a placeholder ID

**Step 3: Write minimal implementation**

Route through the session service and return normalized JSON payloads the web app can consume directly.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run apps/daemon/src/routes/sessions.test.ts`

Expected: PASS

### Task 6: Replace Static Web Shell Data with Live Session Bootstrap

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/session-store.ts`
- Create: `apps/web/src/components/session-form.tsx`
- Create: `apps/web/src/components/session-form.test.tsx`

**Step 1: Write the failing test**

Assert that submitting a problem statement calls the API and swaps the UI from placeholder content to a live checkpoint summary.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm vitest run apps/web/src/components/session-form.test.tsx`

Expected: FAIL because the web app still uses sample data

**Step 3: Write minimal implementation**

Add a session form, call `createSession`, store the returned checkpoint payload, and render it through the existing checkpoint component.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm vitest run apps/web/src/components/session-form.test.tsx`

Expected: PASS

### Task 7: Add End-to-End Smoke for Real Session Creation

**Files:**
- Modify: `apps/web/tests/mobile-smoke.spec.ts`
- Create: `apps/web/tests/session-creation.spec.ts`

**Step 1: Write the failing test**

Assert that a user can open the local UI, enter a prompt, submit it, and see the first checkpoint response rendered.

**Step 2: Run test to verify it fails**

Run: `corepack pnpm exec playwright test tests/session-creation.spec.ts --config playwright.config.ts`

Expected: FAIL until the UI is wired to the daemon

**Step 3: Write minimal implementation**

Run the daemon and web app together for the smoke test and verify the first checkpoint path end-to-end.

**Step 4: Run test to verify it passes**

Run: `corepack pnpm exec playwright test tests/session-creation.spec.ts --config playwright.config.ts`

Expected: PASS
