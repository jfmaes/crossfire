# Spec Generation Fresh-Context Handoff Implementation Plan

**Goal:** Make spec generation consume a canonical final approach handoff in fresh context windows, and remove lossy compaction from the authority path.

**Architecture:** Preserve fresh phase boundaries, introduce an explicit final-approach handoff artifact, and fail closed when authority-path spec-generation inputs are too large instead of compacting them.

**Tech Stack:** TypeScript, Vitest, Fastify, React, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-21-spec-generation-fresh-context-design.md`

---

## Task 1: Introduce a Canonical Final Approach Handoff

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/session-service.ts`
- Modify tests as needed

- [ ] Replace the current free-form approach handoff with a canonical final-approach artifact.
- [ ] Ensure this artifact is the only debate-derived input that crosses into spec generation.
- [ ] Remove any dependency on raw approach-debate transcripts for spec-generation prompts.
- [ ] Keep the artifact compact because it is canonical, not because it is compressed.
- [ ] Add tests proving spec-generation handoff does not rely on raw debate history.

---

## Task 2: Remove Authority-Path Compaction From Spec Generation

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify tests as needed

- [ ] Remove compaction of authority-path inputs in spec generation:
  - final approach handoff
  - review draft
  - revision input
  - walkthrough gap report
- [ ] Keep compaction only for secondary/debug surfaces if still needed.
- [ ] If an authority-path input exceeds the allowed budget, do not compact it.
- [ ] Replace compaction with explicit failure or retryable blocking behavior.

---

## Task 3: Make Spec Generation Fresh-Context Semantics Explicit

**Files:**
- Modify: `packages/adapters/src/claude/claude-adapter.ts`
- Modify: `packages/adapters/src/codex/codex-adapter.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify tests as needed

- [ ] Preserve the current behavior where phase-specific spec-generation calls start fresh.
- [ ] Make that guarantee explicit in comments/tests so it does not regress later.
- [ ] Add or update tests for:
  - no debate-session reuse on spec-generation draft
  - no debate-session reuse on spec-generation review
  - no hidden dependency on reused provider context across this boundary

---

## Task 4: Add Explicit Oversize Failure Semantics

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/session-service.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/spec-card.tsx`
- Modify: `apps/web/src/components/run-detail.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] Introduce explicit error/blocking semantics for oversized authority inputs:
  - `spec_generation_input_too_large`
  - `revision_input_too_large`
  - or equivalent naming
- [ ] Surface this clearly in run traces and the UI.
- [ ] Do not present oversized-input compaction as normal healthy behavior.

---

## Task 5: Verification

**Files:** cross-cutting

- [ ] Run targeted tests for phase orchestrator, session service, adapters, and affected UI components.
- [ ] Run the full suite: `pnpm vitest run`
- [ ] Run a full build: `pnpm build`
- [ ] Do one manual smoke pass:
  - start a session
  - reach approach debate
  - confirm spec generation starts from fresh context
  - confirm authority-path inputs are not compacted
  - confirm oversized-input behavior is explicit if triggered

---

## Notes

- This plan intentionally treats compaction on the authority path as a bug, not an optimization.
- The right fix for oversize inputs is upstream artifact shaping, not smarter truncation.
