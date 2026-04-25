# Question Debate Consensus Implementation Plan

**Goal:** Replace heuristic question fan-in with a bounded multi-turn consensus debate for interview-question selection.

**Architecture:** Keep independent dual analysis, then run a short alternating question debate through the shared debate engine. Remove semantic matching from the authority path. Preserve unresolved disagreement explicitly when question debate does not converge.

**Tech Stack:** TypeScript, Vitest, Fastify, React, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-21-question-debate-consensus-design.md`

---

## Task 1: Rework Question Debate From Parallel Fan-In to Bounded Debate

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.test.ts`
- Modify if needed: `apps/daemon/src/services/orchestrator.ts`

- [ ] Remove the current one-shot parallel question synthesis path from `runQuestionDebate`.
- [ ] Replace it with a bounded alternating debate that reuses the shared orchestrator pattern.
- [ ] Default question-debate `maxTurns` to `4`.
- [ ] Return trace data that reflects debate semantics:
  - `stopReason`
  - `turnsUsed`
  - `maxTurns`
  - `finalDisagreementCount`
  - `finalDisagreements`
- [ ] Preserve the final valid `synthesizedQuestions` list from the debate rather than computing a merged list through heuristics.
- [ ] Add tests for:
  - consensus path
  - `questions_for_human`
  - `max_turns` with unresolved disagreements

---

## Task 2: Remove Heuristic Fan-In From the Authority Path

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.test.ts`

- [ ] Remove or retire the authority-path use of:
  - `questionSimilarity`
  - `choosePreferredQuestionText`
  - `mergeQuestionRationales`
  - `mergeSynthesizedQuestions`
  - `countQuestionEndorsements`
- [ ] Keep only exact normalized dedup if a final hygiene pass is still needed after debate convergence.
- [ ] Make sure the final stored interview-question list is debate-derived, not heuristic-derived.

---

## Task 3: Tighten the Question-Debate Prompt

**Files:**
- Modify: `packages/adapters/src/prompts/phase-prompts.ts`
- Modify: prompt tests if present

- [ ] Rewrite the question-debate prompt so it is explicitly multi-turn and adversarial, not a one-shot parallel synthesis instruction.
- [ ] Make the contract narrow and explicit:
  - `rawText`
  - `summary`
  - `newInsights`
  - `assumptions`
  - `disagreements`
  - `questionsForHuman`
  - `synthesizedQuestions`
- [ ] Clarify that `disagreements` must be empty only on full endorsement.
- [ ] Clarify that `questionsForHuman` means the debate is blocked on clarification, not “here are normal interview questions.”

---

## Task 4: Update Session and UI Semantics

**Files:**
- Modify: `apps/daemon/src/services/session-service.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/analysis-card.tsx`
- Modify: `apps/web/src/components/checkpoint-card.tsx`
- Modify: `apps/web/src/components/run-detail.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify if needed: `apps/web/src/styles/app.css`
- Modify tests for affected components

- [ ] Stop treating `dual_endorsed / gpt_only / claude_only` as the main truth for question selection.
- [ ] Replace that UX with debate semantics:
  - agreed
  - needs clarification
  - unresolved at turn cap
- [ ] If question debate stops at `max_turns`, surface remaining disagreements clearly and require explicit human judgment before proceeding.
- [ ] If question debate stops at `questions_for_human`, preserve and surface the clarification need clearly.
- [ ] Update any copied text that still implies “merged” or “parallel fan-in” is the source of truth.
- [ ] Clean up the primary question-debate/question-synthesis UI:
  - remove transport/debug-flavored labels like `Structured YAML`
  - remove stale phrases like `parallel fan-in` from the main card
  - replace the raw markdown/blob-style summary with structured sections for:
    - GPT position
    - Claude position
    - debate outcome
    - final question list
    - unresolved disagreements or clarification needs
- [ ] Keep any raw trace/debug representation in a secondary details view rather than the primary card.

---

## Task 5: Verification

**Files:** cross-cutting

- [ ] Run targeted tests for question debate, session service, and the affected UI components.
- [ ] Run the full suite: `pnpm vitest run`
- [ ] Run a full build: `pnpm build`
- [ ] Do one manual smoke pass:
  - create a session
  - inspect question debate in progress
  - verify consensus case
  - verify unresolved case
  - verify clarification/escalation case
  - verify the main question-debate UI reads like product state, not raw transport text

---

## Notes

- This change intentionally trades some latency for a stronger product contract.
- The bounded turn cap is the main latency safeguard.
- Exact dedup after consensus is fine. Semantic matching is not the authority path anymore.
