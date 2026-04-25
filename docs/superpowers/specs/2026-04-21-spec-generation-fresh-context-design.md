# Spec Generation Fresh-Context Handoff Design

**Date:** 2026-04-21
**Status:** Proposed
**Scope:** Harden the handoff from discussion phases into spec generation so the authority path uses fresh context windows and uncompressed handoff artifacts. No provider swap. No broad phase-model redesign.

---

## Objective

Make spec generation start from a fresh context window with a canonical final approach handoff, rather than from large accumulated artifacts that later need lossy compaction.

This change should:

- keep spec generation isolated from raw debate history
- make the final approach artifact the only debate-derived handoff into spec generation
- keep authority-path inputs uncompressed during spec generation and revision
- fail closed when authority inputs are too large instead of silently compacting them
- reduce the chance that walkthrough/revision quality is degraded by lossy prompt compression

This change should **not**:

- reintroduce cross-phase conversation reuse
- compress critical spec-generation inputs to “make it fit”
- solve large-context problems with semantic truncation
- redesign the provider layer

---

## Product Context

Crossfire already treats phase boundaries as fresh provider contexts in practice:

- phase-specific calls do not resume Claude sessions
- phase-specific calls do not resume Codex threads

That is the right default.

However, the current spec-generation pipeline still pushes too much material through the authority path:

- `approachResult`
- `peerDraft`
- `revisionPeerDraft`

When those artifacts are too large, the system compacts them before important calls. That is acceptable for secondary trace surfaces, but it is dangerous for the artifact-authority path:

- draft generation
- review
- revision after walkthrough

Lossy compaction at this stage can cause the model to revise against an incomplete or distorted view of the actual issues. If the spec generation path cannot fit without compression, the handoff contract is too large or too vague.

---

## Success Criteria

This change is successful if it delivers all of the following:

1. spec generation starts from fresh context windows at the phase boundary
2. the only discussion-derived handoff into spec generation is a canonical final approach artifact
3. raw debate transcripts do not cross into spec generation prompts
4. authority-path spec-generation inputs are not compacted
5. if an authority-path input is too large, the system fails or escalates explicitly instead of silently compacting
6. traces and UI make it clear when spec generation used:
   - fresh context
   - canonical handoff
   - no compaction on authority inputs

---

## Design Principles

1. **Phase boundaries should reset context.**
   When the prompt contract changes from “debate” to “generate spec,” the provider should start fresh.

2. **The handoff should be canonical, not conversational.**
   Spec generation should consume a stable final approach artifact, not a transcript of how the models got there.

3. **No lossy compression on the authority path.**
   Compression is acceptable for traces, previews, and secondary debug surfaces. It is not acceptable for the actual prompt inputs that determine the final spec.

4. **If it does not fit, the upstream artifact is wrong.**
   The right fix is to tighten the handoff artifact or re-run the earlier phase, not to silently discard details at the most important step.

5. **Review and revision should also be fresh-context substeps.**
   Review depends on the draft artifact, not on prior hidden context inside the provider session.

---

## Current State

The provider layer already mostly honors fresh phase boundaries.

That means the architectural change needed here is **not** “turn off phase reuse” so much as:

- define the allowed handoff artifact explicitly
- remove compaction from the authority path
- enforce that spec generation only proceeds with a bounded canonical handoff

---

## Canonical Final Approach Handoff

**Files:** `apps/daemon/src/services/phase-orchestrator.ts`, prompt builders as needed

After approach debate, produce one canonical final approach artifact.

That artifact should be the only debate-derived input that crosses into spec generation.

It should contain execution-relevant design commitments, for example:

- product boundary
- artifact authority / source of truth
- major architectural decisions
- explicit constraints
- operating modes
- failure / rollback rules
- acceptance gates
- open risks that remain in scope

It should **not** contain:

- raw alternating debate turns
- conversational argument history
- duplicated rationale paragraphs from both models
- provenance/debug scaffolding intended only for inspection

The handoff should be compact because it is canonical, not because it was compressed.

---

## Fresh-Context Rules for Spec Generation

### Draft

GPT draft generation starts from a fresh phase context using:

- original problem
- interview results if still needed by product design
- canonical final approach artifact

No raw debate transcript should be present.

### Review

Claude review starts from a fresh phase context using:

- original problem
- interview results if needed
- canonical final approach artifact
- GPT draft spec/plan

Review should not rely on hidden prior conversation state.

### Walkthrough

The walkthrough phase already represents a separate execution contract and should continue to use fresh phase-specific prompts.

### Revision

Revision after walkthrough starts from a fresh phase context using:

- original problem
- interview results if needed
- canonical final approach artifact
- full reviewed spec/plan
- full walkthrough gap report

No lossy compaction is allowed on those authority inputs.

---

## No-Compaction Rule for Authority Inputs

**Files:** `apps/daemon/src/services/phase-orchestrator.ts`

The following artifacts are authority-path inputs and must not be compacted:

- canonical final approach artifact
- review draft passed to Claude review
- revision input passed to Claude after walkthrough
- walkthrough gap report

If any of those are too large for the intended prompt budget:

- do **not** compact them
- stop the run explicitly
- surface a clear error or retryable state such as:
  - `spec_generation_input_too_large`
  - `revision_input_too_large`

The resolution should be upstream:

- tighten the final approach artifact
- cluster walkthrough findings into root causes before revision
- or re-run earlier steps with a better handoff contract

---

## Relation to Walkthrough Quality

If walkthrough is finding very large numbers of gaps, two things may be true at once:

1. the earlier discussions were still too high-level to produce an execution-complete plan
2. compaction in revision makes it harder for the system to actually fix what the walkthrough found

This spec addresses the second problem directly.

It does not by itself guarantee low walkthrough-gap counts. That requires separate work on:

- stronger approach-debate outputs
- completeness gates before walkthrough
- better grouping of gaps by root cause
- post-revision verification

---

## Trace and Frontend Requirements

Trace metadata should make this contract visible.

Capture:

- whether the phase started from fresh context
- whether the canonical final approach artifact was used
- whether any authority-path input would have required compaction
- whether the run was blocked because an authority-path input was too large

Frontend should show:

- fresh-context handoff into spec generation
- whether the spec path was uncompressed
- a clear warning if spec generation or revision was blocked by oversized inputs

Do not present compacted authority inputs as normal or healthy operation.

---

## Implementation Notes

Important: the provider adapters already avoid phase reuse for phase-specific calls today.

So implementation work should focus on:

- handoff artifact shaping
- prompt assembly policy
- removal of compaction from critical spec-generation inputs
- explicit failure behavior when the authority path is too large

This is primarily an orchestration and prompt-assembly change, not a transport-layer change.

---

## Testing Strategy

Add tests for:

1. spec generation does not reuse debate conversation state
2. draft/review/revision authority-path prompts do not use compacted inputs
3. oversized authority inputs fail closed instead of compacting
4. traces report fresh-context handoff and no-compaction guarantees

---

## Out of Scope

- token-budgeting as a general system rewrite
- embedding-based summarization
- compressing authority-path artifacts “more intelligently”
- redesigning walkthrough itself in this same change

---

## Summary

Spec generation should begin from a fresh context window and consume a canonical final approach handoff, not accumulated conversational mass.

The provider layer already mostly behaves this way across phase boundaries. The missing hardening is in prompt assembly: authority-path inputs are still being compacted when they get too large. That is unsafe. The system should instead:

- pass only the canonical final approach artifact across the discussion boundary
- keep authority-path spec inputs uncompressed
- fail or escalate when they do not fit

If compaction is needed to make spec generation work, the upstream handoff is wrong.
