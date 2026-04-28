# Live Progress Milestones Design

**Date:** 2026-04-27  
**Status:** Proposed  
**Scope:** Improve perceived responsiveness for slow runs by surfacing concrete backend milestones in the frontend. Limited to `Live Progress` and `Run Detail`. No changes to `Run History`. No backend API changes.

---

## Objective

Replace the vague “Waiting for fresh progress from the daemon…” experience with concrete, event-derived progress signals while a run is in flight.

The UI should feel active even when provider turns take minutes.

This change should:

- show the latest concrete backend milestone in the top `Live Progress` area
- show a short rolling list of the most recent milestones under that active area
- surface the same milestone summary inside `Run Detail`
- preserve the existing detailed event log for deeper inspection
- continue to fall back to the generic pending placeholder only when no real events exist yet

This change should **not**:

- change backend APIs or event schemas
- change `Run History`
- invent optimistic milestones that the daemon did not emit
- hide raw event detail from advanced users

---

## Product Context

Crossfire already emits meaningful run events:

- phase starts
- model starts
- model progress/CLI stream lines
- model completions
- consensus or blocking outcomes

The frontend already fetches and streams these events in:

- `ProgressFeed`
- `RunDetail`

But the top-level live view still behaves like a generic spinner/pending panel until enough event state is inferred locally. For slow runs, this feels broken even when the backend is progressing normally.

The fix is not new orchestration. The fix is better presentation of data we already have.

---

## Agreed UX Decisions

From the design conversation:

- show **concrete milestones**, not generic loading copy
- a **rolling list** of recent milestones is desirable
- apply this to:
  - `Live Progress`
  - `Run Detail`
- do **not** change `Run History`

---

## Proposed UX

### Live Progress

Keep the existing top card structure, but change the content model:

1. **Headline milestone**
   - one current, human-readable sentence derived from the latest concrete event
   - examples:
     - `Claude finished analysis in 2m 56s`
     - `GPT question debate turn 1 started`
     - `Question debate reached consensus`
     - `Claude spec revision retry started`

2. **Rolling milestone list**
   - last 3 to 5 concrete milestones
   - newest first
   - each row shows:
     - timestamp
     - optional model badge
     - cleaned milestone text

3. **Active model card**
   - keep the current active-card concept
   - when a model is actively running, show:
     - model
     - elapsed timer
     - current activity label
   - but anchor it under the latest milestone instead of a generic waiting message

4. **Fallback**
   - if no real run events exist yet, keep the current pending/system placeholder
   - once a single backend event exists, switch to milestone mode

### Run Detail

Keep the current event log, but add a compact summary block near the top:

- title: `Recent milestones`
- same last 3 to 5 milestone rows
- below that, keep the full raw event timeline unchanged

This gives fast scanability without removing the detailed trace.

### Run History

No changes.

---

## Milestone Derivation

Milestones should come from existing events, not inferred workflow guesses.

### Events That Should Produce Milestones

- `phase_start`
- `model_start`
- `model_done`
- `consensus`
- `info` when it communicates a material state change
  - examples:
    - `Adversarial Walkthrough...`
    - `24 operational gap(s) found — Claude revising spec`
    - blocked/oversize outcomes

### Events That Should Usually Stay In The Raw Log Only

- noisy `model_stream`
- low-signal `model_progress`
- repeated CLI chatter

These may still contribute to active-card body text, but should not flood the milestone list.

### Milestone Formatting Rules

- prefer daemon message text when it is already user-readable
- prepend model names for model-scoped events
- include elapsed time on completed model turns when available
- keep strings short and scannable
- do not expose raw metadata objects directly in milestone rows

Examples:

- `GPT started analysis`
- `Claude finished analysis in 2m 56s`
- `Question debate reached consensus`
- `Claude started spec revision`
- `Spec generation blocked: authority input too large`

---

## Data Flow

No backend changes are required.

Frontend flow:

1. Hydrate persisted events with `getRunEvents(runId)`
2. Merge live SSE events from `/progress`
3. Normalize events into:
   - active model state
   - raw event list
   - milestone list
4. Render:
   - headline milestone
   - rolling milestone list
   - active model card
   - raw event log

The normalization should live close to `ProgressFeed` and be reused by `RunDetail`, either as:

- a shared helper module, or
- local helper functions imported by both components

The helper should be pure and deterministic so it is easy to unit test.

---

## State Rules

### Pending Before First Event

If:

- a run is known to be active
- but zero persisted/live events have arrived yet

show:

- the current pending/system placeholder

As soon as one event arrives:

- replace placeholder text with milestone-driven content

### Reset Behavior

Milestones should reset when:

- session changes
- run changes
- explicit `resetToken` changes

This should match the existing reset rules for `ProgressFeed`.

### Ordering

Milestones should be ordered by received/persisted event time, newest first in the compact list.

---

## Testing

Add focused frontend tests for:

1. **Live Progress headline**
   - renders latest milestone from persisted events

2. **Rolling list**
   - shows last N milestones in the right order

3. **Fallback transition**
   - pending placeholder is shown before any events
   - real milestone content replaces it once events exist

4. **Run Detail summary**
   - shows recent milestones without removing the full raw event log

5. **Noise filtering**
   - `model_stream` / `model_progress` stay out of milestone list unless explicitly promoted

6. **Elapsed formatting**
   - completed model milestones include elapsed time when present

---

## Non-Goals

- No redesign of the overall visual style
- No new phase/state machine in the frontend
- No provider-specific heuristics beyond the existing event types/messages
- No changes to backend progress event emission in this pass

---

## Success Criteria

This change is successful if:

1. a slow run no longer looks idle once backend events begin arriving
2. the top progress area shows concrete milestone text rather than generic daemon-waiting copy
3. users can understand “where the run is” without opening `Run Detail`
4. `Run Detail` still exposes the full event trace while also giving a quick milestone summary
5. `Run History` remains unchanged

---

## Implementation Notes

Recommended implementation shape:

- add a small event-to-milestone normalization helper
- update `ProgressFeed` to render:
  - `current milestone`
  - `recent milestones`
- update `RunDetail` to render a `Recent milestones` summary block above the raw event list

No backend dependency should block this work.
