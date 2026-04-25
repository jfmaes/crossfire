# Question Debate Consensus Design

**Date:** 2026-04-21
**Status:** Proposed
**Scope:** Replace heuristic question fan-in with a bounded multi-turn consensus debate for interview-question selection. No provider swap. No phase-model redesign outside the analysis-to-interview transition.

---

## Objective

Make Crossfire's interview-question selection phase produce an actually endorsed question set rather than a heuristically merged one.

This change should:

- restore real adversarial debate for interview questions
- stop inferring agreement from lexical similarity
- preserve disagreements explicitly when the models do not converge
- keep the phase bounded so latency stays acceptable
- surface question-debate status clearly in traces and the frontend
- present question-debate results as human-readable product state rather than raw transport-shaped text

This change should **not**:

- add embeddings or semantic search to merge question lists
- expand question debate into an open-ended loop like approach debate
- redesign the rest of the session lifecycle
- introduce a new autonomous question-ranking subsystem

---

## Product Context

Today Crossfire does:

1. GPT and Claude analyze the problem independently
2. both produce proposed interview questions
3. the system runs a one-shot parallel "question synthesis" pass
4. the outputs are merged with a conservative lexical heuristic
5. the final list is shown to the human as if it were an agreed question set

That was a latency optimization, but it weakens the contract of the phase:

- the models do not actually agree on the final questions
- semantic overlap is inferred via heuristic token matching
- unresolved conceptual duplication can survive the merge
- the UI can report provenance stats that look precise while hiding the fact that no consensus was reached

For interview questions, that tradeoff is too aggressive. These questions define the downstream design space, so the product should optimize for correctness and explicit agreement rather than cheap consolidation.

---

## Success Criteria

This change is successful if it delivers all of the following:

1. the final interview question set is produced by explicit model agreement, not inferred similarity
2. question debate has clear stop reasons:
   - `consensus`
   - `questions_for_human`
   - `max_turns`
3. if the models fail to converge, the user can see that directly instead of receiving a silently merged list
4. heuristic matching is removed from the authority path for question selection
5. question-debate latency remains bounded and operationally acceptable
6. traces and UI make it obvious whether the question list was:
   - fully agreed
   - escalated for clarification
   - stopped at the turn cap with unresolved disagreement
7. the primary UI for question debate no longer looks like a raw “structured yaml” or debug dump

---

## Design Principles

1. **Question selection is a control decision, not a formatting pass.**
   The final interview list changes the reachable architecture space. It deserves the same explicit consensus standard as the later approach debate.

2. **Agreement must be earned, not inferred.**
   A lexical heuristic can identify exact duplicates, but it should not be the mechanism that declares two questions equivalent.

3. **Bound the phase aggressively.**
   Question debate should be shorter than approach debate. We want real disagreement resolution, not another long-running open loop.

4. **Preserve disagreement when consensus fails.**
   If the models do not converge, the product should expose that fact, not hide it behind a merged list.

5. **Use heuristics only for hygiene.**
   Exact dedup and formatting cleanup are acceptable after consensus. Semantic clustering is not acceptable as the consensus mechanism.

6. **Primary UX should show meaning, not transport artifacts.**
   The user should see model positions, agreement state, and resulting questions. Raw markdown or transport-shaped text belongs in a secondary trace/detail view, not the main card.

---

## Proposed Flow

Replace the current one-shot parallel fan-in with this flow:

1. **Independent analysis**
   GPT and Claude each analyze the prompt and produce:
   - `rawText`
   - `summary`
   - `proposedQuestions`
   - `questionsForHuman`

2. **Bounded question debate**
   The models alternate through a short adversarial debate over the interview list.

3. **Stop on one of three conditions**
   - `consensus`: both latest valid turns report zero disagreements
   - `questions_for_human`: a model explicitly says the debate cannot continue without clarification
   - `max_turns`: the bounded debate limit is reached without agreement

4. **Transition rules**
   - if `consensus`: save the agreed `synthesizedQuestions` and move to interview
   - if `questions_for_human`: surface the clarification need before or as part of interview
   - if `max_turns`: preserve both sides and require explicit human judgment before proceeding

---

## Question Debate Contract

**Files:** `packages/adapters/src/prompts/phase-prompts.ts`, `apps/daemon/src/services/orchestrator.ts`, `apps/daemon/src/services/phase-orchestrator.ts`

The question-debate turn contract should stay narrow and explicit:

- `rawText`
- `summary`
- `newInsights`
- `assumptions`
- `disagreements`
- `questionsForHuman`
- `synthesizedQuestions`

`synthesizedQuestions` is the model's current proposed consensus list.

`disagreements` means:

- specific objections to the peer's latest proposed list
- empty only when the model fully endorses the current list as-is

`questionsForHuman` means:

- the debate cannot continue without clarification from the human
- not a place to propose normal interview questions that should remain in the debate

---

## Debate Policy

Question debate should be shorter and stricter than approach debate.

### Recommended execution policy

- default `maxTurns`: `4`
- allow override later via execution policy if needed, but do not block this change on that plumbing

### Debate expectations

- turn 1: GPT critiques the combined proposed list and proposes a consensus list
- turn 2: Claude critiques GPT's list and proposes its own consensus list
- turn 3+: only unresolved points, merges, removals, and missing questions
- no new broad analysis tangents after the first exchange

### Consensus rule

Question debate reaches consensus only when:

- the last two valid turns are both disagreement-free
- and both include `synthesizedQuestions`

This mirrors the shape of approach-debate consensus and avoids one-sided “latest turn is clean” false positives.

---

## What Replaces Heuristic Fan-In

The current heuristic merge logic should be removed from the authority path.

Specifically, do **not** use:

- Jaccard similarity
- token synonym maps
- lexical clustering thresholds

to decide that two model questions are “the same question.”

Those techniques can remain only in low-blast-radius post-processing:

- exact normalized dedup after consensus
- sorting cleanup
- formatting cleanup

If the models phrase similar ideas differently, the debate itself should resolve that.

---

## Failure and Escalation Semantics

### `consensus`

The system stores the agreed question list and proceeds to interview normally.

### `questions_for_human`

The system should treat this as an explicit clarification stop, not silent success.

Minimum product behavior:

- show that the models paused because they need clarification
- persist the open questions
- let the human answer or revise context before the question list is finalized

### `max_turns`

The system should not pretend that a merged list is authoritative.

Minimum product behavior:

- preserve the final candidate list and disagreement summary
- tell the user the models did not fully agree
- require explicit human judgment before proceeding

This can still lead into interview, but only as an acknowledged, human-approved override.

---

## Trace and Frontend Requirements

Question debate should expose the same orchestration clarity as approach debate.

Capture:

- stop reason
- turns used / max turns
- final disagreement count
- final disagreements
- final candidate question count
- whether human escalation occurred

Frontend should show:

- whether the question list is fully agreed
- whether the debate stopped at the cap
- whether the models requested clarification
- the remaining disagreements if any
- the final question list or current candidate list in a structured, readable format
- each model's position in a way that reads like a debate, not a raw YAML/markdown blob

### Question Debate Card Cleanup

The primary question-debate UI should be cleaned up as part of this change.

Minimum UX requirements:

- remove misleading labels like `Structured YAML` from the main question-debate display
- remove stale copy like `parallel fan-in` and `merged` from the main experience once debate is the source of truth
- render GPT and Claude positions as clearly labeled sections or cards, not as a single raw markdown block
- render the resulting question set as an explicit question list
- if unresolved, render disagreements as an explicit unresolved section
- keep raw trace/debug text only in a secondary details view if needed

The goal is that a user can understand:

- what each model argued
- whether they actually agreed
- what questions Crossfire will ask

without mentally decoding a transport-shaped summary block

Do **not** foreground `dual_endorsed / gpt_only / claude_only` counts as the primary UX once consensus debate becomes the mechanism. Those were artifacts of heuristic fan-in. They may still be useful as debug metadata, but they are no longer the main product truth.

---

## Implementation Notes

The cleanest implementation path is to reuse the existing multi-turn `orchestrator` for question debate rather than keep a separate “parallel synthesis” path.

That means:

- add a question-debate prompt that is designed for alternating turns
- run it through the existing debate engine with a lower turn cap
- save the final valid `synthesizedQuestions` from the converged debate
- remove or retire the heuristic merge helpers from the authority path
- replace the current raw question-synthesis summary presentation with a structured debate-oriented card

This keeps Crossfire's orchestration model more coherent:

- independent analysis
- bounded debate on questions
- human interview
- bounded debate on approach
- spec generation and review

---

## Testing Strategy

Add tests for:

1. question debate reaches consensus when both models end with zero disagreements
2. one model asking for clarification returns `questions_for_human`
3. hitting the turn cap preserves unresolved disagreement state
4. no heuristic merge is needed for the final question set
5. the UI reflects “agreed” vs “unresolved” vs “needs clarification”

---

## Out of Scope

- embedding-based question clustering
- semantic rerankers
- model-judged pairwise equivalence scoring
- automatic conflict resolution after `max_turns` without the human
- reworking approach debate in this same change

---

## Summary

Question selection should be treated as a real consensus phase, not a heuristic merge.

Crossfire already uses adversarial bounded debate for the later approach phase because correctness matters there. Interview-question selection is equally load-bearing. The system should therefore:

- debate the question list explicitly
- stop on real agreement or explicit escalation
- preserve disagreement rather than hiding it
- reserve heuristics for exact dedup hygiene only

This keeps the product honest and makes the final interview list something the models actually endorse.
