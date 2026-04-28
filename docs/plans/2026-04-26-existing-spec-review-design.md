# Existing Spec Review Design

## Problem

Crossfire currently starts from a new problem statement and drives the models toward a new specification and implementation plan. Users who already have a spec or plan must paste it into the prompt or treat it as revision feedback after Crossfire has generated its own artifacts.

That makes the existing-document use case awkward. Crossfire should support adversarial discussion of already-written specs and implementation plans as a first-class workflow, while preserving the same human checkpoints and question surfacing that make the normal flow useful.

## Goals

- Add a dedicated "Review Existing Spec" entry point in the web UI.
- Accept existing specification and implementation-plan content without requiring copy-paste.
- Support browser file uploads for local `.md` / `.txt` documents.
- Support file-path references that the daemon reads from the machine where Crossfire is running.
- Still surface model questions before revision when the existing documents leave material gaps.
- Reuse the current session lifecycle, run history, progress feed, review, revision, finalize, export, restart, and rewind behavior where practical.
- Revise the submitted documents instead of drafting from a blank slate.

## Non-Goals

- Building a full document-management UI.
- Syncing files back to their source paths.
- Supporting arbitrary binary formats, PDFs, or office documents in the MVP.
- Exposing daemon file reads for a shared or remote multi-user deployment.
- Adding an annotation UI for line-level comments.

## Recommended Approach

Add a first-class `existing_spec` session mode that reuses the current phase model.

The web app gets two home tabs: the current "New Spec" flow and a new "Review Existing Spec" flow. The review form accepts optional project context, a required spec source, and an optional implementation-plan source. Each source can come from pasted text, browser-uploaded text, or a daemon-local file path.

The daemon resolves uploaded/pasted text directly from the request and resolves path references by reading UTF-8 files from its own filesystem. The resulting documents become authoritative session input. Crossfire then runs the familiar analysis, question debate, interview, approach debate, and spec-generation stages with prompts framed around evaluating and improving existing documents.

## Input Sources

The MVP should support three source types:

- `text`: text already present in the request body, either pasted by the user or read in the browser from an uploaded file.
- `path`: an absolute or relative file path read by the daemon.
- omitted implementation plan: allowed when the user has only a spec.

Browser uploads should be read with `File.text()` and sent as ordinary JSON. This avoids multipart parsing and new daemon dependencies.

Path references are local-only. Relative paths resolve from the daemon working directory. Absolute paths are accepted because Crossfire is designed for single-user localhost operation, but the daemon must normalize paths, reject directories, enforce allowed extensions, enforce size limits, and return clear 400 errors for missing or unreadable files.

## API Shape

Extend session creation with a mode-aware input, either through `POST /sessions` or a thin route wrapper:

```ts
{
  "title": "Review auth refactor spec",
  "mode": "existing_spec",
  "prompt": "Optional project context or review focus",
  "existingSpec": {
    "spec": "...",
    "specPath": "/path/to/spec.md",
    "implementationPlan": "...",
    "implementationPlanPath": "/path/to/plan.md"
  }
}
```

Exactly one of `spec` or `specPath` must be present. The implementation plan is optional, but if provided it must also use exactly one of `implementationPlan` or `implementationPlanPath`.

The stored session prompt should include a structured context block with the human context plus the resolved documents. The original source metadata should be persisted in the phase result or session payload so the UI can show what was used.

## Flow

1. User opens "Review Existing Spec" and chooses uploaded files, daemon-local paths, or pasted text.
2. The daemon resolves the documents and creates an `existing_spec` session.
3. Phase 1 analyzes the existing spec and plan for ambiguity, contradictions, missing requirements, missing implementation detail, risk, and questions.
4. The question debate synthesizes only questions that must be answered before a sound revision strategy can be formed.
5. If questions exist, the normal interview UI asks them with Crossfire recommendations.
6. The approach debate becomes a revision-strategy debate grounded in the existing documents, optional context, and interview answers.
7. Spec generation revises the submitted spec and plan instead of creating unrelated new documents.
8. The existing review, feedback-based revision, approval, artifact, and export flow continues unchanged after the first revised output.

## Prompting Contract

Existing-spec prompts should avoid language that implies a blank-slate design.

Analysis prompts should ask each model to:

- Treat the submitted spec and plan as the subject under review.
- Identify gaps, contradictions, missing implementation details, untested assumptions, and unclear decisions.
- Propose human questions only when the documents do not contain enough information for a defensible revision.

Approach-debate prompts should ask the models to converge on a revision strategy, not a brand-new architecture unless the documents are fundamentally unsalvageable.

Spec-generation prompts should ask for full revised documents, preserving valid existing content and making concrete changes for issues found during review, interview, debate, and walkthrough.

## Data Model

Avoid a broad migration for MVP if possible.

Store the session mode and source metadata in existing JSON-capable locations first:

- `session.executionPolicy.mode` or a small session metadata object if a migration is justified.
- `phase_results` entry such as `existing_spec_input` with source labels, path strings, content lengths, and whether each source came from upload, paste, or path.

If mode-specific filtering or history display becomes awkward, add a dedicated `mode` column later.

## UI Behavior

The empty state should show a compact tab switcher:

- `New Spec`
- `Review Existing Spec`

The review form should expose source controls without turning into a document manager:

- Project context textarea.
- Spec source chooser with upload, path, and paste modes.
- Implementation-plan source chooser with upload, path, and paste modes.
- Clear validation messages when required content is missing or mutually exclusive.

Once a session starts, the normal session detail UI should largely remain the same. Labels should be mode-aware where needed:

- Phase guidance should say the models are reviewing supplied documents.
- The prompt/source bar should identify the submitted spec and plan sources.
- Spec card heading can remain "Specification & Implementation Plan" because the output is still revised artifacts.

## Error Handling

- Missing spec content returns 400 with a specific message.
- Supplying both text and path for the same document returns 400.
- Unreadable paths return 400 and include the failing source label.
- Directories are rejected.
- Non-UTF-8 or binary-looking files are rejected with an actionable error.
- Oversized documents are rejected before model calls.
- Provider failures keep the session in the existing errored/retry flow.

## Security

Path reads are acceptable only under Crossfire's local single-user threat model. Documentation and UI copy should avoid implying that path reads work in the browser; they happen in the daemon process.

The MVP should keep allowed extensions narrow, such as `.md`, `.markdown`, and `.txt`. The daemon should normalize resolved paths before reading and should not follow this feature into any multi-user exposure without a stronger filesystem access model.

## Testing

Add focused tests for:

- Creating an `existing_spec` session from uploaded/pasted text.
- Creating an `existing_spec` session from daemon-local file paths.
- Rejecting missing spec input, mutually exclusive text/path input, directories, unsupported extensions, and oversized files.
- Existing-spec sessions still surface interview questions when providers propose them.
- Existing-spec sessions advance through approach debate and spec generation.
- Spec generation receives the existing spec/plan as authoritative input.
- The web tab switcher renders both entry points.
- The review form reads uploaded text and submits the expected API payload.
- The review form can submit daemon path references without reading those paths in the browser.

## Open Decisions

- Whether to store mode in `executionPolicy` for MVP or add a dedicated `sessions.mode` column immediately.
- Exact document size limit for spec and plan inputs.
- Whether path reads should be restricted to `COUNCIL_GROUNDING_ROOT` when configured.
- Whether output artifacts should be named as revised versions of the uploaded/path filenames.
