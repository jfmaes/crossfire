# Claude Spec Generation Degraded Output Mitigation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate or sharply reduce `CLAUDE spec_generation failed: degraded structured output` failures in the final spec-revision step for large existing-spec sessions, while improving postmortem visibility when provider drift still occurs.

**Architecture:** Treat the issue as a late-phase structured-output reliability problem localized to the final Claude revision call in `runSpecGeneration`, not as a generic provider failure. Add targeted observability for degraded turns, harden the Claude spec-generation prompt contract, add a spec-generation-specific recovery retry, and introduce provider-aware shaping for the largest authority-path input (`revisionPeerDraft`) before the final Claude revision call.

**Tech Stack:** TypeScript, Vitest, Fastify, React, pnpm workspaces, SQLite via `better-sqlite3`

---

## RCA Summary

**Verified facts from the failed rerun session `a91edfc3-bd92-4f6c-81a4-1b62933837e8`:**

- `analysis` completed successfully for both GPT and Claude.
- `analysis_debate` completed successfully and reached consensus.
- `interview` completed successfully with 5 answered questions.
- `approach_debate` completed successfully after 11 turns and reached consensus.
- The session then entered `spec_generation`.
- In the first `spec_generation` run (`47d26f13-69a6-4974-88bc-3591d4bbb910`):
  - GPT draft succeeded.
  - Claude review of GPT draft succeeded.
  - GPT walkthrough succeeded.
  - Claude walkthrough succeeded.
  - Final Claude revision failed with `Done in 508.9s — 1328 chars (degraded)`.

**Most likely root cause:**

- The failure is localized to the **final Claude revision** call inside `runSpecGeneration`, after walkthrough gaps were merged into `revisionPeerDraft`.
- The failing call carried the largest authority-path input in the whole run:
  - `originalProblem`: 53,773 chars
  - `interviewResults`: 2,768 chars
  - `finalApproachHandoff`: 3,843 chars
  - `revisionPeerDraft`: 59,013 chars
- The recorded `missingFields` list was empty. This means the failure was **not** a phase-validation missing-field issue. Instead, the adapter/parser marked the turn `degraded`, which only happens when the raw output cannot be parsed or schema-validated into a proper model turn.
- Because earlier stages in the same run succeeded, this is unlikely to be a generic Claude availability problem. Evidence points instead to **late-stage output-format drift under the heaviest spec-generation prompt shape**.

**Contributing factors:**

- The final Claude revision prompt is structurally more complex than the earlier draft/review prompts because it asks for a full revised spec and plan while also incorporating the walkthrough repair context.
- The system currently does **not** persist the raw degraded response for this specific failure mode unless external debug logging is enabled.
- The system currently treats degraded spec-generation output as a one-shot hard failure instead of attempting a targeted recovery retry.

---

## Task 1: Persist Evidence For Degraded Spec Generation Turns

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/session-service.ts`
- Test: update `apps/daemon/src/services/phase-orchestrator.test.ts`

- [ ] **Step 1: Add a focused failing test for degraded spec-generation evidence capture**

Add a test near the `runSpecGeneration` degraded/failure coverage asserting that when the final Claude revision turn degrades, the returned/raised diagnostics include:

- the phase (`spec_generation`)
- the provider (`claude`)
- the failing substep (`revision`)
- the raw response text (or a capped preview)
- prompt-ledger sizes for `originalProblem`, `interviewResults`, `finalApproachHandoff`, and `revisionPeerDraft`

Use a fake Claude provider that returns a malformed or prose-wrapped payload that still triggers degradation.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- FAIL because degraded spec-generation evidence is not yet persisted in a structured way.

- [ ] **Step 3: Add structured degraded-output diagnostics to the final Claude revision path**

Inside `runSpecGeneration`, when the final Claude revision call degrades:

- emit a run event metadata block that includes:
  - `substep: "revision"`
  - `rawResponsePreview`
  - prompt-ledger lengths
  - `revisionPeerDraft` length
- persist a lightweight phase result such as `spec_generation_failure` or equivalent, containing the same diagnostics for later inspection

Do **not** dump full 50k+ prompt bodies into normal run events; cap raw previews to a defensible size.

- [ ] **Step 4: Re-run the targeted test to verify it passes**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- PASS with structured degraded-output diagnostics present.

---

## Task 2: Harden Claude Spec-Generation Prompt Contract

**Files:**
- Modify: `packages/adapters/src/prompts/phase-prompts.ts`
- Modify: `packages/adapters/src/prompts/structured-turn.test.ts` or add targeted prompt assertions
- Modify tests for spec-generation prompt wording as needed

- [ ] **Step 1: Add a focused failing prompt test for spec-generation anti-drift wording**

Add assertions that `buildSpecPrompt(...)` includes stronger output-contract language analogous to the structured-turn prompt:

- `Respond ONLY with a single raw JSON object.`
- `Do not say things like "Here is the JSON" or "Below is the object".`
- `If you add any text outside the JSON object, your turn will be rejected.`

Cover both:
- the review prompt (`peerDraft` present)
- the final revision prompt path (`peerDraft` present, `existing_spec` and `new_spec` both acceptable)

- [ ] **Step 2: Run the prompt test to verify it fails**

Run:

```bash
pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts packages/adapters/src/prompts/phase-prompts.test.ts
```

Expected:
- FAIL because the current spec-generation prompt contract is weaker than the structured-turn contract.

- [ ] **Step 3: Tighten `buildSpecPrompt`**

Update `buildSpecPrompt` so the output section clearly states:

- exactly one raw JSON object
- no markdown fences
- no preamble/postamble prose
- off-schema text causes rejection

Keep the JSON shape unchanged.

- [ ] **Step 4: Re-run the prompt tests**

Run:

```bash
pnpm vitest run packages/adapters/src/prompts/structured-turn.test.ts packages/adapters/src/prompts/phase-prompts.test.ts
```

Expected:
- PASS with the stronger contract present.

---

## Task 3: Add A Spec-Generation-Specific Recovery Retry

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify: `apps/daemon/src/services/phase-orchestrator.test.ts`

- [ ] **Step 1: Add a failing test for one-shot degraded revision recovery**

Create a test where:

- Claude returns a degraded/malformed output on the first final revision call
- Claude returns a valid structured output on the second final revision call

Expected behavior:

- `runSpecGeneration(...)` retries the final Claude revision **once**
- the second result is accepted
- the returned trace marks that a degraded-output retry occurred

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- FAIL because no retry currently exists.

- [ ] **Step 3: Implement a single fresh-context retry for degraded final revision output**

Inside the final Claude revision step of `runSpecGeneration`:

- catch degraded structured-output failures from the first revision call
- immediately retry **once**
- use a fresh provider context
- prepend a compact recovery instruction such as:
  - previous response was rejected because it was not a valid raw JSON object
  - do not explain
  - output one raw JSON object only

Do not add unlimited retries.

- [ ] **Step 4: Record retry diagnostics**

Add trace metadata showing:

- retry attempted: `true`
- retry reason: `degraded_structured_output`
- whether retry succeeded

- [ ] **Step 5: Re-run the targeted test**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- PASS with exactly one retry and a successful recovery path.

---

## Task 4: Introduce A Provider-Aware Soft Budget For `revisionPeerDraft`

**Files:**
- Modify: `apps/daemon/src/services/phase-orchestrator.ts`
- Modify tests in `apps/daemon/src/services/phase-orchestrator.test.ts`

- [ ] **Step 1: Add a failing test that distinguishes hard budget from soft budget**

Create a test where:

- `revisionPeerDraft` is below the current hard blocking budget
- but above a new Claude-specific soft stability budget

Expected behavior:

- the system shapes/synthesizes the revision input before the final Claude revision call
- the call still proceeds
- trace metadata records that soft-budget shaping occurred

- [ ] **Step 2: Run the targeted test to verify it fails**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- FAIL because only the hard budget currently exists.

- [ ] **Step 3: Add a provider-aware soft budget**

Introduce a constant such as:

```ts
const CLAUDE_REVISION_SOFT_BUDGET_CHARS = 45_000;
```

Apply it only to the **final Claude revision** path.

If `revisionPeerDraft.length > CLAUDE_REVISION_SOFT_BUDGET_CHARS`:

- synthesize the walkthrough gap report more aggressively, or
- produce a compact revision brief that preserves:
  - exact authoritative draft content references
  - walkthrough repair priorities
  - required plan/spec sections

Do **not** change the existing hard blocking budget in this task.

- [ ] **Step 4: Preserve correctness over convenience**

Any shaping path must remain authority-safe:

- no silent omission of required walkthrough gaps
- no cross-epoch/cross-draft mixing
- no lossy removal of mandatory sections without explicit trace metadata

- [ ] **Step 5: Re-run the targeted test**

Run:

```bash
pnpm vitest run apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- PASS with soft-budget shaping clearly recorded in trace metadata.

---

## Task 5: End-To-End Verification Against The Existing-Spec Smoke Case

**Files:** cross-cutting

- [ ] **Step 1: Run focused adapter and orchestrator verification**

Run:

```bash
pnpm vitest run \
  packages/adapters/src/structured-turn.test.ts \
  packages/adapters/src/prompts/structured-turn.test.ts \
  packages/adapters/src/codex/codex-cli-transport.test.ts \
  packages/adapters/src/codex/codex-adapter.test.ts \
  packages/adapters/src/claude/claude-adapter.test.ts \
  apps/daemon/src/services/phase-orchestrator.test.ts
```

Expected:
- PASS.

- [ ] **Step 2: Run full build**

Run:

```bash
pnpm build
```

Expected:
- PASS.

- [ ] **Step 3: Re-run the real existing-spec session**

Use the same source file:

```text
/home/jenkins/projects/crossfire-preexist-smoketest/RAGNAROK-MVP_spec.md
```

Drive the same interview path and confirm:

- create run reaches interview
- approach debate reaches checkpoint/consensus
- spec generation reaches checkpoint or finalization without degraded structured output

- [ ] **Step 4: Capture final evidence**

Record:

- session id
- run ids
- phase transitions
- whether any degraded retry fired
- whether soft-budget shaping fired
- whether the final spec/plan checkpoint was created

---

## Notes

- The evidence does **not** support blaming generic provider instability. The failure is tightly localized to the final Claude revision substep.
- The evidence also does **not** support a pure field-validation failure; `missingFields` was empty on the failed run.
- The strongest current hypothesis is: **the final Claude revision prompt is the heaviest structured-output prompt in the system, and its output drifts off-schema under load/context pressure.**
- The plan therefore prioritizes:
  1. observability,
  2. stricter output contract,
  3. one-shot retry,
  4. provider-aware input shaping.
