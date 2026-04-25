# Prompt & Orchestration Rework Implementation Plan

**Status:** Rebased against the current tree on 2026-04-20

**Goal:** Harden Crossfire's prompt contracts, orchestration correctness, context management, question synthesis, and observability without changing the core product shape.

**Architecture:** Phase-specific validation on top of the shared `ModelTurn` contract, trimmed prompt shapes per phase, provenance-aware question fan-in, structured markdown compaction, and a trace metadata layer that flows from orchestration through to the frontend.

**Tech Stack:** TypeScript, Zod, Vitest, Fastify, React, SQLite (`better-sqlite3`), pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-03-prompt-orchestration-rework-design.md`

---

## Rebase Summary

The previous revision of this plan assumed several items were still unimplemented. That is no longer true in the current tree. Executing the old plan literally would re-do landed work, introduce churn, and in a few places move the code away from the design spec.

This rebased plan keeps already-landed work as-is unless a follow-up task below explicitly tightens tests, contracts, or documentation around it.

### Already Landed

- [x] Spec Item 2: phase-specific prompt shapes are already trimmed in `packages/adapters/src/prompts/phase-prompts.ts`.
- [x] Spec Item 6: compact resumed-turn persona reminders already exist in `packages/adapters/src/prompts/structured-turn.ts`.
- [x] Spec Item 7: dead interview follow-up/evaluation path is already removed.
- [x] Spec Item 8: provenance-aware question fan-in is already implemented in `apps/daemon/src/services/phase-orchestrator.ts`.
- [x] Spec Item 9: semantic dedup instructions are already present in question-synthesis and walkthrough prompts.
- [x] Spec Item 10: markdown compaction already exists, currently implemented inline inside `apps/daemon/src/services/phase-orchestrator.ts`.
- [x] Spec Item 11: `executionPolicy.approachDebateMaxTurns` is already threaded through session creation and approach debate.
- [x] Spec Item 13: Codex schema path is already deterministic under `~/.cache/crossfire`.

### Partially Landed

- [~] Spec Item 12: `stopReason` and invalid-turn metadata exist, but tests and contracts are stale.
- [~] Spec Item 14: structured metadata is emitted, but backend/frontend field names and shapes are not yet fully normalized.
- [~] Spec Item 15: the frontend already shows several metadata badges, but the trace/detail experience is still more raw than the spec calls for.

### Still Open

- [ ] Spec Item 1: true phase-specific validation is still missing.
- [ ] Spec Item 4: conversation reuse policy comments do not yet match the spec.
- [ ] Spec Item 5: Codex schema strategy note is still missing.
- [ ] Prompt/test coverage is missing for several already-landed behaviors.

---

## Guardrails

- Do not re-implement prompt trimming, deterministic schema-path work, execution-policy threading, or the existing compaction/fan-in behavior just to match the old task list.
- Do not add broad `.default()` values to control fields in the canonical `ModelTurn` schema. The spec explicitly requires omitted control fields to remain detectable until phase validation.
- Treat degraded or phase-invalid latest debate turns as failures that stop or retry the run. Do not silently convert them into “wasted turns” that continue the debate.
- Normalize metadata contracts before adding more UI polish. The daemon and frontend currently disagree on some field names and shapes.
- Prefer targeted tests first, then full-suite verification at the end.

---

## Task 1: Rebase Orchestrator Tests and Stop-Reason Contract

**Spec Items:** 12, 14

**Files:**
- Modify: `apps/daemon/src/services/orchestrator.ts`
- Modify: `apps/daemon/src/services/orchestrator.test.ts`

- [ ] Add or update tests so they reflect the current debate contract rather than the old plan assumptions:
  - consensus returns `stopReason: "consensus"`
  - human escalation returns `stopReason: "questions_for_human"`
  - unresolved debate returns `stopReason: "max_turns"`
  - one-sided “latest turn is clean” does not stop the debate early
- [ ] Remove stale comments and expectations in existing tests that still describe the deleted one-sided stop behavior.
- [ ] Decide and document one failure contract for degraded/provider-error paths:
  - successful runs return `consensus | questions_for_human | max_turns`
  - invalid/provider failures surface through thrown errors plus structured progress metadata
- [ ] If needed, add one final “debate finished” progress event carrying `stopReason`, `totalTurns`, and final disagreement count so the UI does not need to infer the end state from earlier events.
- [ ] Run: `pnpm vitest run apps/daemon/src/services/orchestrator.test.ts`

**Notes**

- The current tree already emits `phase_invalid_turn` metadata on invalid debate turns. Keep that behavior explicit rather than trying to force invalid failures into the successful return union.

---

## Task 2: Implement Phase-Specific Validation Without Broad Defaults

**Spec Item:** 1

**Files:**
- Create: `apps/daemon/src/services/phase-validation.ts`
- Create: `apps/daemon/src/services/phase-validation.test.ts`
- Modify: `packages/adapters/src/structured-turn.ts`
- Modify: `packages/adapters/src/structured-turn.test.ts`
- Modify: `apps/daemon/src/services/orchestrator.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify only if truly necessary: `packages/core/src/contracts/session.ts`

- [ ] Add a dedicated phase-validator mapping required fields by phase.
- [ ] Include `rawText` and `summary` in every phase’s required fields, matching the spec.
- [ ] Preserve absence for control fields until phase validation. Safe normalization remains limited to:
  - `newInsights`
  - `assumptions`
  - `questionsForPeer`
- [ ] Refactor `parseStructuredTurn` so omitted control fields remain observable. Do not “fix” this by defaulting `disagreements`, `questionsForHuman`, `proposedSpecDelta`, `milestoneReached`, `implementationPlan`, `proposedQuestions`, `synthesizedQuestions`, `followUpQuestions`, `sufficientContext`, or `walkthroughGaps`.
- [ ] In `orchestrator.ts`, validate approach-debate turns after parsing and before consensus logic. Invalid turns must not satisfy consensus.
- [ ] In `phase-orchestrator.ts`, validate phase outputs in `collectTurnOutput` before downstream extraction. Invalid walkthrough/spec turns must not be treated as “no gaps” or “empty plan”.
- [ ] Emit structured metadata on phase-invalid output:
  - `outputStatus: "phase_invalid"`
  - `missingFields`
  - phase and provider context
- [ ] Keep degraded/phase-invalid latest debate turns as failures, not retriable silent turns inside the same loop.
- [ ] Add unit tests for:
  - analysis turn missing `proposedQuestions`
  - synthesis turn missing `synthesizedQuestions`
  - approach debate turn missing `milestoneReached`
  - spec generation turn missing `implementationPlan`
  - walkthrough turn missing `walkthroughGaps`
  - parser behavior when only harmless fields are omitted
- [ ] Run targeted tests:
  - `pnpm vitest run apps/daemon/src/services/phase-validation.test.ts`
  - `pnpm vitest run packages/adapters/src/structured-turn.test.ts`
  - `pnpm vitest run apps/daemon/src/services/orchestrator.test.ts apps/daemon/src/services/phase-orchestrator.test.ts`

**Notes**

- The canonical schema in `packages/core` should remain a storage/transport contract, not a vehicle for broad defaults that hide behavioral omissions.
- Only touch `packages/core/src/contracts/session.ts` if an internal helper/export is required. Avoid changing field optionality unless it directly supports the spec.

---

## Task 3: Normalize Trace Metadata and Prompt-Ledger Contract

**Spec Items:** 3, 10, 14

**Files:**
- Modify: `apps/daemon/src/services/orchestrator.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/web/src/components/progress-feed.tsx`
- Modify: `apps/web/src/components/run-detail.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] Choose one canonical metadata contract and apply it consistently across daemon and frontend.
- [ ] Resolve the current naming drift:
  - pick either `questionProvenance` or `endorsementCounts`
  - keep one `promptLedger` shape instead of mixing “array of entries” and “summary object”
  - expose compaction as structured data, not just `compacted: true`
- [ ] Ensure debate-completion metadata includes:
  - `stopReason`
  - `totalTurns`
  - final disagreement count from the final valid turn
- [ ] Ensure compaction metadata includes, when compaction happens:
  - original size
  - final size
  - component name
  - sections compacted if available
- [ ] Keep the existing inline compaction/ledger logic unless extraction clearly reduces duplication. This task is about contract cleanup first, not moving code for its own sake.
- [ ] Update frontend parsing/rendering to consume the chosen metadata shape without stringly-typed assumptions.
- [ ] Add or update UI tests for the chosen metadata contract.
- [ ] Run:
  - `pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts`
  - `pnpm vitest run apps/web`

**Notes**

- The current tree already has useful metadata and prompt-ledger-like entries. Keep the functionality; clean up the contract.

---

## Task 4: Backfill Prompt Coverage and Adapter Documentation

**Spec Items:** 4, 5, 6

**Files:**
- Modify: `packages/adapters/src/prompts/structured-turn.test.ts`
- Modify: `packages/adapters/src/claude/claude-adapter.ts`
- Modify: `packages/adapters/src/codex/codex-adapter.ts`
- Modify: `packages/adapters/src/codex/codex-cli-transport.ts`

- [ ] Add prompt tests for `omitContext` / compact persona reminders:
  - compact reminder is used on resumed debate turns
  - full persona remains on first-turn/full-context prompts
  - `actor` and `degraded` do not appear in prompt templates
- [ ] Rewrite the adapter comments so they match the actual reuse policy from the spec:
  - same provider
  - same phase family / prompt contract
  - same response expectations
  - previous turn not degraded or phase-invalid
  - reuse only where resume mechanics are known-good
- [ ] Add the explicit Codex schema strategy note above `ensureSchemaFilePath`.
- [ ] Do not change behavior in this task unless the documentation reveals a real contract mismatch that must be fixed to keep comments truthful.
- [ ] Run:
  - `pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts`
  - `pnpm vitest run packages/adapters/src/claude/claude-adapter.test.ts packages/adapters/src/codex/codex-cli-transport.test.ts`

---

## Task 5: Finish Frontend Transparency on Top of Existing Badges

**Spec Item:** 15

**Files:**
- Modify: `apps/web/src/components/progress-feed.tsx`
- Modify: `apps/web/src/components/run-detail.tsx`
- Modify if needed: `apps/web/src/components/analysis-card.tsx`
- Modify if needed: `apps/web/src/components/debate-card.tsx`
- Modify if needed: `apps/web/src/components/spec-card.tsx`
- Modify if needed: `apps/web/src/styles/app.css`

- [ ] Keep the existing badge/feed work; extend it rather than replacing it.
- [ ] Add a more human-readable trace/detail view for:
  - debate stop reason and turn counts
  - question provenance counts
  - compaction details
  - degraded / phase-invalid warnings
  - prompt-ledger summary
- [ ] Prefer small focused UI improvements over a broad redesign.
- [ ] If the phase cards already have enough state, do not invent duplicate presentation. Wire the new trace contract into the existing cards/components.
- [ ] Add frontend tests for the new rendering path.
- [ ] Run: `pnpm vitest run apps/web`

**Notes**

- The spec asks for transparency, not raw metadata dumps. Favor compact, readable summaries over generic `key: value` pills wherever the structure is known.

---

## Task 6: Final Verification

**Files:** cross-cutting

- [ ] Run the targeted tests from Tasks 1-5 until green.
- [ ] Run the full test suite: `pnpm vitest run`
- [ ] Run a full build: `pnpm build`
- [ ] Do one manual smoke pass:
  - create a session with `executionPolicy.approachDebateMaxTurns`
  - inspect a successful debate in the UI
  - inspect a degraded/phase-invalid path in the UI
  - confirm stop reason and trace metadata are understandable without log inspection
- [ ] Review `git diff --stat` and make sure no already-landed items were reworked unnecessarily.

---

## Removed From This Revision

These items were in the previous revision of the plan but should not be executed as new work unless a later task above explicitly touches them:

- the original “implement prompt trimming” task
- the original “implement deterministic Codex schema path” task
- the original “remove dead interview code” task
- the original “thread execution policy through services/routes” task
- the original “add semantic dedup instructions” task
- the original “implement provenance-aware fan-in from scratch” task
- the original “create standalone prompt-ledger.ts / compaction.ts just because the old plan said so”

---

## Implementation Order

1. Rebase orchestrator tests and stop-reason contract.
2. Implement real phase-specific validation without broad defaults.
3. Normalize trace metadata and prompt-ledger/compaction contracts.
4. Backfill prompt coverage and adapter documentation.
5. Finish frontend transparency on top of the stabilized metadata contract.
6. Run the full verification pass.

Rationale:

- correctness first
- then behavioral contract enforcement
- then observability contract cleanup
- then UI polish
- then end-to-end verification
