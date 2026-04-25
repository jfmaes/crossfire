# Large Feedback Spec Revision Design

## Problem

Crossfire currently handles spec feedback by appending the human's revision text to the original problem and rerunning full spec generation. This fails when feedback is large: the model receives an oversized, poorly structured "original problem", may produce invalid structured output, and the session can degrade even though a valid prior spec exists.

The revision path must allow large feedback while preserving the user's feedback verbatim as authoritative input.

## Goals

- Accept large spec feedback without degrading structured output.
- Store human feedback verbatim before any model processing.
- Preserve traceability from generated revision instructions back to exact user feedback spans.
- Revise the existing spec and implementation plan instead of restarting spec generation from a feedback-augmented original prompt.
- Fail with a clear, recoverable checkpoint when feedback is too broad to process within configured budgets.

## Non-Goals

- Unlimited model context usage.
- Treating a model-generated synthesis as the authority of record.
- Building a full document annotation UI.
- Changing the already approved initial spec-generation path except where shared prompt-budget utilities are needed.

## Recommended Approach

Use a verbatim-authority revision pipeline.

Raw feedback is stored unchanged as `feedbackRaw`. Crossfire then derives a bounded working brief from that raw text. The brief is allowed to guide model prompts, but it is not the authority. Each requested change in the brief must point back to one or more source chunks from `feedbackRaw`, and final revision prompts include exact excerpts for those chunks.

If a brief conflicts with an exact excerpt, the excerpt wins. If the brief cannot preserve coverage under budget, Crossfire pauses and asks the human to prioritize rather than attempting a degraded revision.

## Data Model

Add a persisted revision request concept, either as a dedicated table or as structured run metadata:

- `id`
- `session_id`
- `run_id`
- `created_at`
- `feedback_raw`
- `feedback_chunks_json`
- `feedback_digest_json`
- `budget_ledger_json`
- `status`

`feedback_chunks_json` contains stable chunk IDs, source offsets, and text lengths. `feedback_digest_json` contains requested changes with source chunk IDs and optional source offset ranges. `budget_ledger_json` records raw feedback size, digest size, selected excerpt size, prior spec size, prior plan size, and prompt size.

## Flow

1. On non-approve feedback during `spec_generation`, create a revision request and store `feedbackRaw` verbatim.
2. If the raw feedback fits the revision budget, pass it as exact feedback.
3. If it exceeds budget, split it into stable chunks and run a feedback extraction step.
4. The extraction step outputs requested changes, each linked to source chunk IDs.
5. Crossfire selects exact excerpts for the linked chunks within a configured excerpt budget.
6. The revision prompt uses the current spec and implementation plan as the primary documents, not a regenerated original problem.
7. The prompt includes the digest, exact excerpts, and the instruction that raw feedback is authoritative and exact excerpts override the digest.
8. If selected excerpts still exceed budget, Crossfire stores a blocked checkpoint with `feedback_input_too_large` and asks the human to prioritize.

## Prompting Contract

The spec revision prompt should be distinct from the initial spec-generation prompt:

- Input: original problem, current spec, current implementation plan, revision digest, exact feedback excerpts, interview answers, final approach handoff.
- Output: full revised spec, full revised implementation plan, summary, applied change list, and unapplied feedback list.
- The model must not restart architecture from scratch unless the feedback explicitly requests that.
- The model must mention any feedback item it cannot apply because of conflicts or missing information.

## Error Handling

- Provider auth or transport failures remain hard errors.
- Structured-output parse failures should retain the revision request and current spec result.
- Oversized raw feedback should not be sent blindly to spec generation.
- Oversized digest or excerpt sets should produce a recoverable checkpoint, not degraded output.
- The session should keep the last successful spec result available after failed revision attempts.

## UI Behavior

The UI can continue to accept freeform feedback. For large feedback, progress should show:

- "Storing feedback"
- "Indexing feedback"
- "Extracting requested changes"
- "Selecting exact excerpts"
- "Revising spec"

If Crossfire blocks on size, show the reason and ask the user to prioritize the feedback. The previous spec remains visible.

## Testing

Add focused tests for:

- Large feedback is stored verbatim.
- Large feedback is chunked and digested before revision.
- Revision prompts include digest plus exact excerpts, not the raw full feedback when over budget.
- Final revised spec is produced from existing spec and plan.
- Parse failure leaves the prior spec result intact.
- Oversized excerpts produce a recoverable blocked checkpoint.
- Prompt ledger reports raw feedback, digest, excerpts, spec, and plan sizes.

## Open Decisions

- Whether revision requests should be a dedicated SQLite table or stored inside `phase_results` / run metadata.
- Exact chunk size and overlap for feedback chunking.
- Whether feedback extraction should be single-model or dual-model.
- Whether the final revised output should include a machine-readable applied/unapplied feedback list in MVP.
