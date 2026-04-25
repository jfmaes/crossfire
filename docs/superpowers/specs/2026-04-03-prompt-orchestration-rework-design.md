# Prompt & Orchestration Rework Plan

**Date:** 2026-04-03
**Scope:** Tactical cleanup and hardening of prompt/orchestration behavior across existing Crossfire flows. No product-level re-architecture. No provider swap. No new autonomous phase model.

---

## Objective

Improve Crossfire's prompt contracts, context use, conversation reuse, orchestration correctness, frontend transparency, and traceability without changing the core product shape.

This pass should:

- reduce prompt waste
- make context assembly and compaction explicit
- reuse conversation only where it is safe and measurable
- remove known correctness bugs in consensus handling
- improve question synthesis fan-in
- persist execution policy and provenance
- surface important orchestration state clearly in the frontend
- make debugging and post-hoc inspection straightforward

This pass should **not**:

- replace CLI providers with direct API transports
- redesign the phase model
- introduce dynamic personas
- build large-scale evaluation infrastructure
- redesign the frontend visual language from scratch

---

## Product Context

Crossfire is a local dual-LLM spec workshop:

1. GPT and Claude analyze the problem independently
2. both propose interview questions
3. the system synthesizes a final interview question list
4. the human answers the interview
5. the models debate the best approach adversarially until consensus or escalation
6. GPT drafts the spec and implementation plan
7. Claude reviews and revises
8. both models run an adversarial walkthrough
9. Claude revises again if walkthrough gaps are found

The key product-level constraints for this cleanup are:

- malformed outputs must not silently become valid control signals
- context reuse assumptions must be explicit, not implied
- the UI should explain what the system is doing and why
- traceability must let the user answer "what happened?" after the fact

---

## Success Criteria

This cleanup is successful if it delivers all of the following:

1. prompt contracts are narrower and cleaner
2. phase-required control fields are explicitly validated
3. degraded or phase-invalid turns cannot satisfy consensus or "no gaps" logic
4. conversation reuse is explicit, phase-aware, and visible in traces
5. oversized artifacts are compacted predictably without dropping execution-critical structure
6. question synthesis uses both models' outputs with provenance
7. the frontend exposes stop reasons, warnings, and major orchestration decisions
8. a user can trace any final artifact back to the prompts, revisions, and walkthrough findings that produced it

---

## Design Principles

1. **Control signals must be explicit.**
   `disagreements`, `questionsForHuman`, `implementationPlan`, and `walkthroughGaps` are orchestration inputs, not decorative fields.

2. **Shared base parsing, phase-specific validation.**
   One canonical stored turn shape is still useful, but phase correctness must be checked with phase-aware rules.

3. **Prompt trimming must match transport reality.**
   Prompt examples matter, but Codex also has schema-level enforcement. The spec must account for both.

4. **Reuse context only where the contract is stable.**
   If the phase, output shape, or behavioral contract changes, assume fresh context unless the provider path explicitly guarantees reuse safety.

5. **Compaction must preserve executable structure before prose.**
   When forced to compress, keep the parts an implementing agent actually needs.

6. **Cheap heuristics are acceptable only for low-blast-radius problems.**
   Question dedup can use approximate matching. Consensus and safety logic cannot.

7. **The user should see the important orchestration state.**
   Reuse, compaction, degradation, and stop reasons must not be hidden in logs only.

8. **Every important decision should be traceable.**
   The system should preserve enough structured metadata to explain how it reached a result.

---

## 1. Phase-Specific Validation Instead of Shared-Schema Defaults

**Files:** `packages/core/src/contracts/session.ts`, `packages/adapters/src/structured-turn.ts`, `apps/daemon/src/services/phase-orchestrator.ts`, `apps/daemon/src/services/orchestrator.ts`

**Problem:** Prompt trimming fails if every phase still parses against a shared schema that implicitly expects all control fields. Broad `.default()` values on the shared schema would avoid parse failures, but they would also blur the difference between:

- the model explicitly returning an empty control signal
- the model omitting the field
- the transport degrading and downstream code fabricating a fallback

That distinction already leaks today through degraded-turn behavior and downstream extraction fallbacks. This pass should reduce that ambiguity, not normalize it into the primary parse path.

**Change:** Keep the canonical stored model-turn shape, but add explicit phase validation so prompt trimming does not rely on invented defaults.

### Part A: Keep the canonical schema honest

In `packages/core/src/contracts/session.ts`:

- keep `rawText` and `summary` required
- keep control fields represented in the stored type
- do **not** add broad `.default()` values to control fields purely to enable prompt trimming

The canonical schema remains a transport/storage shape, not the full behavioral contract of each phase.

### Part B: Parse, then validate by phase

In `packages/adapters/src/structured-turn.ts`:

- parse provider output into a base object
- only normalize fields that are semantically harmless when absent

Safe to normalize:

- `newInsights: []`
- `assumptions: []`
- `questionsForPeer: []`

Must remain detectable as absent until phase validation:

- `disagreements`
- `questionsForHuman`
- `proposedSpecDelta`
- `milestoneReached`
- `implementationPlan`
- `proposedQuestions`
- `synthesizedQuestions`
- `followUpQuestions`
- `sufficientContext`
- `walkthroughGaps`

In orchestration code, add phase validators with the following required fields:

| Phase | Required fields |
|------|------------------|
| Analysis | `rawText`, `summary`, `proposedQuestions`, `questionsForHuman` |
| Question Synthesis | `rawText`, `summary`, `disagreements`, `synthesizedQuestions` |
| Approach Debate | `rawText`, `summary`, `disagreements`, `questionsForHuman`, `proposedSpecDelta`, `milestoneReached` |
| Spec Generation | `rawText`, `summary`, `proposedSpecDelta`, `implementationPlan`, `milestoneReached` |
| Walkthrough | `rawText`, `summary`, `walkthroughGaps` |

If a phase-required field is absent:

- mark the turn as phase-invalid
- do not let that turn satisfy consensus, "no gaps", or "empty plan" logic
- emit structured progress/tracing metadata explaining why it was invalid

**Result:** Prompt contracts can become smaller without teaching the system that omitted control fields are valid state.

---

## 2. Phase-Specific Prompt Shapes

**Files:** `packages/adapters/src/prompts/phase-prompts.ts`, `packages/adapters/src/prompts/structured-turn.ts`

**Problem:** Prompt templates currently include many irrelevant fields, broadening the output contract and wasting input/output tokens.

**Change:** Trim prompt JSON examples by phase.

| Phase | Fields explicitly requested in prompt |
|------|----------------------------------------|
| Analysis | `rawText`, `summary`, `newInsights`, `assumptions`, `proposedQuestions`, `questionsForHuman` |
| Question Synthesis | `rawText`, `summary`, `newInsights`, `assumptions`, `disagreements`, `synthesizedQuestions` |
| Approach Debate | `rawText`, `summary`, `newInsights`, `assumptions`, `disagreements`, `questionsForPeer`, `questionsForHuman`, `proposedSpecDelta`, `milestoneReached` |
| Spec Generation | `rawText`, `summary`, `proposedSpecDelta`, `implementationPlan`, `milestoneReached` |
| Walkthrough | `rawText`, `summary`, `newInsights`, `walkthroughGaps` |

Also remove from all prompt examples:

- `degraded`
- `actor`

Those fields are assigned by the parser/provider layer, not by the model.

---

## 3. Canonical Prompt Assembly and Context Budget Ledger

**Files:** `apps/daemon/src/services/phase-orchestrator.ts`, prompt builders as needed, debug/tracing code

**Problem:** Prompt assembly is currently mostly string concatenation. Context priority, compaction eligibility, and actual component sizes are implicit. That makes it hard to optimize context use, reason about prompt bloat, or explain why certain information was included or compacted.

**Change:** Introduce a single prompt-assembly policy and ledger for all large multi-component prompts.

### Prompt component priority

When building a prompt with multiple inputs, preserve in this order:

1. current phase instructions and output contract
2. original problem
3. current-turn control context:
   - peer response
   - interview answers
   - walkthrough gap objects
4. structured execution artifacts:
   - question lists
   - acceptance criteria
   - task lists
   - risk lists
5. narrative artifact bodies
6. grounding context and low-priority narrative detail

### Prompt ledger

For each model call, record:

- component name
- original char count
- final char count
- whether compacted
- whether omitted
- whether assumed to be available via conversation reuse

This ledger is primarily for traceability and debugging, but it also forces the implementation to make context prioritization explicit.

### Why this matters

- it gives a deterministic context policy instead of ad hoc truncation
- it supports clean compaction behavior
- it makes frontend/status explanations possible

---

## 4. Explicit Conversation Reuse Policy

**Files:** provider adapters, `apps/daemon/src/services/phase-orchestrator.ts`, `apps/daemon/src/services/session-service.ts`, tracing/progress surfaces

**Problem:** Crossfire already reuses conversation selectively, but the rules are implicit. Prompt optimizations currently risk assuming context exists when it may not. This causes two classes of failure:

- prompts omit information that was not actually available in provider context
- documents or status text claim prior context that did not exist

**Change:** Define a hard reuse policy.

### Reuse is allowed only when all conditions are true

1. same provider
2. same phase family
3. same behavioral contract
4. same response schema expectations
5. provider resume mechanism is available and confirmed
6. previous turn was not degraded or phase-invalid

### Allowed in this pass

- resumed turns within the approach debate for a single provider

### Not assumed in this pass

- reuse across phase boundaries
- reuse across provider switches
- reuse across prompt contracts that changed shape
- reuse after degraded or phase-invalid output
- reuse as justification for omitting full artifact bodies in compaction markers

### Optional future optimization, explicitly out of scope here

- safe reuse across sub-steps of spec generation, but only after provider-specific evaluation proves it does not increase malformed outputs

### Trace requirement

Every turn should record:

- `conversationReused: true|false`
- reuse reason or refusal reason
- provider resume identifier if available in logs/debug metadata

This makes conversation reuse a first-class behavior instead of an implementation detail.

---

## 5. Explicit Codex Schema Strategy

**Files:** `packages/adapters/src/codex/codex-cli-transport.ts`, `packages/adapters/scripts/generate-model-turn-schema.ts`, generated schema artifacts if applicable

**Problem:** Codex is governed by both prompt prose and `--output-schema`. Prompt trimming alone is not the whole contract.

**Decision for this pass:**

- Claude benefits immediately from phase-specific prompt trimming
- Codex continues to use the canonical full schema during this cleanup

### Why

- it avoids introducing a matrix of generated phase-specific JSON schema files in the same pass
- it keeps the transport path simple while still allowing prompt cleanup

### Required implementation note

The spec and implementation must state clearly:

- Codex still uses the canonical schema file
- prompt trimming is expected to help Claude more than Codex in this pass
- provider-specific phase schemas for Codex are a separate follow-up, not part of this cleanup

---

## 6. Compact Persona/Independence Reminders on Resumed Debate Turns

**File:** `packages/adapters/src/prompts/structured-turn.ts`

**Problem:** Resumed debate turns repeat the full persona and anti-sycophancy text even when provider context reuse already preserves the original contract.

**Change:** When `omitContext` is true and reuse is actually in effect, replace the full block with a compact invariant reminder:

```text
Continue as Dr. Chen / Dr. Rivera.
INDEPENDENCE PROTOCOL remains in force: agreement must be earned through evidence.
Treat your peer's latest response with the same skepticism as their first.
```

Keep the turn-specific phase instructions.

Do **not** apply this optimization when the provider conversation is fresh.

---

## 7. Remove Dead Interview Evaluation Code

**Files:** `packages/adapters/src/prompts/phase-prompts.ts`, `apps/daemon/src/services/phase-orchestrator.ts`, adapter exports if applicable

**Problem:** Crossfire no longer performs per-question interview evaluation, but dead prompt/orchestrator code for that path still exists.

**Change:**

- remove `runInterviewStep`
- remove `InterviewStepResult`
- remove `extractFollowUpQuestions`
- remove `buildInterviewFollowUpPrompt`
- remove related exports/tests

This is pure cleanup.

---

## 8. Provenance-Aware Question Fan-In

**File:** `apps/daemon/src/services/phase-orchestrator.ts`

**Problem:** Question synthesis currently wastes one model's work and gives little insight into agreement between the models.

**Change:** Merge both models' synthesized question lists with provenance.

### Step 1: each model deduplicates semantically within its own list

Handled by prompt instructions in item 9.

### Step 2: cross-model matching uses a conservative lexical heuristic

For GPT-vs-Claude question pairs:

- lowercase
- remove stopwords
- compare word sets via Jaccard similarity
- cluster only when similarity is comfortably above threshold

This heuristic is acceptable because the failure mode is mild redundancy, not orchestration corruption.

### Step 3: preserve provenance

Each merged question records:

- `gpt_only`
- `claude_only`
- or `dual_endorsed`

### Step 4: rank via reciprocal-rank scoring

- dual-endorsed: `1/rank_gpt + 1/rank_claude`
- single-endorsed: `1/rank`

### Step 5: wording selection

Do not hardcode provider preference.

Choose wording by:

1. more specific domain wording if clearly better
2. otherwise longer non-verbose wording
3. otherwise lower combined rank

### Step 6: final exact dedup

Keep the cheap exact-match dedup as a final safety net.

---

## 9. Add Semantic Dedup Instructions to Synthesis and Walkthrough Prompts

**Files:** `packages/adapters/src/prompts/phase-prompts.ts`

**Problem:** Exact string dedup is insufficient. The models should do the first-pass semantic merge themselves.

**Change:**

### Question synthesis prompt

Add:

```text
Before finalizing your list, merge any questions that ask for the same information
in different words into a single, well-phrased question. Do not include multiple
questions that differ only in wording or framing.
```

### Walkthrough prompt

Add:

```text
If multiple issues stem from the same root cause, merge them into a single gap entry.
Reference all affected sections in the location field, and propose one fix that
addresses the root cause rather than listing each symptom separately.
```

Keep exact dedup in code as a final fallback.

---

## 10. Structured Compaction for Large Intermediate Artifacts

**File:** `apps/daemon/src/services/phase-orchestrator.ts`

**Problem:** Large spec and plan artifacts can blow up downstream prompts. Blind truncation is unacceptable because it discards the most important details arbitrarily.

**Change:** Add `compactMarkdown(text: string, budgetChars: number)` with a priority-chain compaction policy.

### Priority chain

1. **Headers**
   - always keep

2. **Structured execution content under key sections**
   - preserve bullets/numbered items under:
     - Tasks
     - Acceptance criteria
     - Risks
     - Open questions
     - Dependencies
   - if an item is long, keep the lead clause and trim the tail

3. **Narrative section summaries**
   - keep the first paragraph of ordinary prose sections

4. **Code blocks**
   - keep short blocks only
   - replace long blocks with `[long code block omitted during compaction]`

5. **Everything else**
   - drop only after higher-priority structure is preserved

### Additional rules

- if already within budget, return unchanged
- never claim prior conversation-state guarantees in compaction markers
- use neutral footer:
  - `[Compacted from N chars to M chars. Lower-priority details omitted.]`

### Apply to

- `peerDraft` in the revision step
- `approachResult` before spec generation if needed

### Do not compact

- `originalProblem`
- structured walkthrough gap objects

### Trace requirement

When compaction occurs, record:

- original size
- final size
- sections compacted
- whether key execution sections were preserved

---

## 11. Persistent Phase-Specific Execution Policy

**Files:** `packages/storage/src/database.ts`, `packages/storage/src/session-repository.ts`, `apps/daemon/src/services/session-service.ts`, `apps/daemon/src/services/phase-orchestrator.ts`

**Problem:** Debate turn limits are execution policy and should survive restarts because sessions and runs are persisted.

**Change:** Persist an `execution_policy` blob on sessions.

Suggested shape:

```ts
interface ExecutionPolicy {
  approachDebateMaxTurns?: number; // default 14
}
```

Implementation:

- add nullable `execution_policy` column to `sessions`
- serialize on write, parse on read
- accept optional `executionPolicy` in `CreateSessionInput`
- pass `approachDebateMaxTurns` into `runApproachDebate()`
- forward into `orchestrator.runRound({ maxTurns })`

Default remains 14 when unset.

This stays phase-specific instead of introducing a vague session-wide `maxTurns`.

---

## 12. Consensus Logic Hardening

**Files:** `apps/daemon/src/services/orchestrator.ts`, phase-validation helpers

**Problem:** Consensus is currently vulnerable to a weaker one-sided stop condition and to malformed turns being interpreted as clean disagreement-free turns.

**Change:**

1. remove the redundant one-sided consensus check
2. do not count degraded or phase-invalid turns toward consensus
3. if the latest turn is degraded or phase-invalid, stop the debate as errored or retryable rather than treating it as convergence
4. emit an explicit stop reason in progress and trace metadata

Allowed stop reasons:

- `consensus`
- `questions_for_human`
- `max_turns`
- `phase_invalid_turn`
- `provider_error`

This makes debate outcomes inspectable and prevents silent false convergence.

---

## 13. Deterministic Schema File Path for Codex

**File:** `packages/adapters/src/codex/codex-cli-transport.ts`

**Problem:** Temp-dir schema files can accumulate after abnormal exits.

**Change:**

- use deterministic path: `~/.cache/crossfire/model-turn.schema.json`
- ensure the directory exists
- rewrite only if content changed
- remove temp-dir cleanup logic

Low risk, isolated.

---

## 14. Structured Traceability and Provenance Manifest

**Files:** `apps/daemon/src/services/progress.ts`, run-event persistence, session/phase result persistence, API surfaces as needed

**Problem:** Crossfire already has raw debug logs, but there is no clean structured provenance layer that answers:

- was context reused?
- was anything compacted?
- why did the debate stop?
- which questions were dual-endorsed?
- which revision produced the final artifact?

The current state is inspectable only by reading logs, which is too expensive for normal use and too opaque for the frontend.

**Change:** Persist structured per-run and per-phase provenance metadata.

### Minimum trace payload

For each significant step, capture:

- session id
- run id
- phase
- model/provider
- started/finished timestamps
- elapsed time
- `conversationReused`
- `reuseReason` or `reuseRefusedReason`
- prompt ledger summary:
  - component sizes
  - compacted components
  - omitted components
- output status:
  - `ok`
  - `degraded`
  - `phase_invalid`
- stop reason if applicable
- question provenance counts if applicable
- walkthrough gap count if applicable
- revision-applied yes/no if applicable

### Final artifact provenance

For the final spec/plan result, retain enough metadata to answer:

- which provider drafted it
- which provider reviewed it
- whether walkthrough revision happened
- how many gaps triggered revision
- whether any input artifacts were compacted

### Storage

Store this as structured JSON metadata associated with run events or phase results. Do not rely on free-form text logs as the primary trace surface.

---

## 15. Frontend UX Polish for Orchestration Transparency

**Files:** `apps/web/src/lib/api.ts`, relevant UI components, progress/state presentation layers, daemon API if needed

**Problem:** The frontend currently exposes progress, but the most important orchestration state is still too implicit. A polished local tool should tell the user what happened without requiring log inspection.

**Change:** Surface structured orchestration state in the UI.

### Minimum UX improvements

1. **Phase cards with explicit state badges**
   - fresh context
   - reused context
   - compacted
   - degraded
   - phase-invalid

2. **Debate status card**
   - turns used / max turns
   - stop reason
   - unresolved disagreement count from the final valid turn
   - whether human escalation occurred

3. **Question synthesis card**
   - number of GPT-only questions
   - Claude-only questions
   - dual-endorsed questions
   - duplicates removed

4. **Spec generation card**
   - drafted
   - reviewed
   - walkthrough complete
   - revised after walkthrough yes/no
   - gap count
   - compaction applied yes/no

5. **Visible warnings**
   - degraded turn
   - phase-invalid turn
   - provider error
   - compaction triggered on critical artifacts

6. **Trace drawer / details panel**
   - compact human-readable explanation of the structured provenance manifest

### UX principle

The frontend should explain:

- what the system is doing
- what assumptions it is making about context reuse
- whether it had to compact input
- why it stopped

without making the user read raw logs.

---

## Implementation Order

1. **Item 12**: harden consensus logic and stop reasons
2. **Item 2**: trim phase prompt shapes and remove `actor` / `degraded`
3. **Item 13**: deterministic Codex schema path
4. **Item 7**: remove dead interview evaluation code
5. **Item 1**: add phase-specific validation and invalid-turn handling
6. **Item 3**: add prompt assembly policy and prompt ledger
7. **Item 4**: codify conversation reuse policy in orchestration paths
8. **Item 6**: compact resumed-turn reminders where reuse is truly active
9. **Item 9**: semantic dedup instructions
10. **Item 8**: provenance-aware question fan-in
11. **Item 10**: structured compaction
12. **Item 11**: persist execution policy
13. **Item 14**: structured provenance manifest
14. **Item 15**: frontend transparency improvements
15. **Item 5**: keep the Codex schema strategy note aligned with the implemented transport behavior

Rationale:

- correctness first
- then prompt/validation contracts
- then context policy
- then orchestration quality
- then observability and UX

---

## Files Changed

| File | Items |
|------|-------|
| `packages/core/src/contracts/session.ts` | 1 |
| `packages/adapters/src/structured-turn.ts` | 1 |
| `packages/adapters/src/prompts/structured-turn.ts` | 2, 6 |
| `packages/adapters/src/prompts/phase-prompts.ts` | 2, 7, 9 |
| `packages/adapters/src/codex/codex-cli-transport.ts` | 5, 13 |
| `packages/adapters/scripts/generate-model-turn-schema.ts` | 5 |
| `apps/daemon/src/services/orchestrator.ts` | 1, 12 |
| `apps/daemon/src/services/phase-orchestrator.ts` | 1, 3, 4, 8, 10, 11 |
| `apps/daemon/src/services/session-service.ts` | 4, 11 |
| `apps/daemon/src/services/progress.ts` | 12, 14 |
| `packages/storage/src/database.ts` | 11, 14 |
| `packages/storage/src/session-repository.ts` | 11, 14 |
| `apps/web/src/lib/api.ts` | 14, 15 |
| `apps/web/src/components/*` | 15 |

---

## Testing and Validation Strategy

### Unit and integration coverage

Existing orchestrator/session/adapter tests must continue to pass.

Add tests for:

- phase-specific validation rejecting omitted control fields
- degraded/phase-invalid turns not counting toward consensus
- stop reasons emitted correctly
- prompt ledger generation for multi-component prompts
- conversation reuse policy:
  - allowed within resumed debate turns
  - blocked across phase boundaries
  - blocked after degraded/phase-invalid turns
- question fan-in preserving provenance counts
- compaction preserving headers and prioritized execution structure
- execution policy persistence
- deterministic schema cache path behavior
- trace metadata persistence and API serialization

### Cheap automated metrics

For before/after comparison on a small number of real sessions, record:

- degraded-turn count by phase
- phase-invalid turn count by phase
- parse-success rate by phase
- field-presence incidence for control fields:
  - `disagreements`
  - `questionsForHuman`
  - `implementationPlan`
  - `walkthroughGaps`
- duplicate-question count before and after synthesis
- end-to-end latency
- per-phase latency
- conversation reuse rate by phase
- compaction trigger rate
- compaction ratio when triggered
- number of frontend-visible warnings triggered

### Qualitative eval pass

Run 2-3 representative real sessions:

- one simple problem
- one complex problem
- one ambiguous problem

Review before/after on:

- question sharpness and redundancy
- debate quality and genuine convergence
- spec completeness
- implementation-plan usefulness
- walkthrough gap distinctness/actionability
- frontend clarity:
  - can the user understand what happened without reading logs?

### Shipping gate

Ship only if:

- degraded and phase-invalid turns do not increase
- implementation-plan presence does not regress
- no false-convergence cases appear in qualitative review
- compaction preserves execution-critical structure in evaluated sessions
- frontend warnings and stop reasons are accurate on inspected runs

This is a local tool, so lightweight evidence is sufficient; production-scale statistical rigor is not required.

---

## Out of Scope

- direct API transport migration
- cross-provider conversation sharing
- provider-specific phase schema generation for Codex
- phase-model redesign
- dynamic personas
- full frontend redesign unrelated to orchestration transparency
- large-scale eval infra or benchmarking suite

---

## Summary

This cleanup makes Crossfire materially stronger without changing what the product is.

It does that by:

- narrowing prompt contracts
- validating control fields at the phase level
- making context assembly and compaction explicit
- defining exactly when conversation reuse is allowed
- preserving provenance through question synthesis and artifact generation
- hardening consensus behavior
- surfacing orchestration state clearly in the frontend
- storing enough structured trace metadata to explain any run after the fact

The central rule of this version is deliberate:

- **do not hide orchestration ambiguity behind defaults or fallback strings**
- **make context, reuse, degradation, and stop reasons explicit in both code and UI**
