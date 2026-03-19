# Structured ModelTurn Extraction Design

> **ARCHIVED** — Fully implemented. Structured turns with Zod validation, degraded fallback, code fence stripping, and Claude envelope stripping are all in production. See `2026-03-18-implementation-status.md` for current state.

## Goal

Replace the current flat-text `toModelTurn()` fallback with validated structured turns so checkpointing can react to real disagreements, human questions, assumptions, and milestones instead of only turn count.

## Resolved Decisions

- Use one source of truth: extend the existing `modelTurnSchema` in `packages/core`
- Add `rawText` and `degraded` to that schema
- Change `milestoneReached` from free-form string to enum
- Models do **not** return `actor`; adapters inject `actor` after validation
- Both providers use **final structured turn only**
- Validation belongs in adapters, not transports
- Prompts belong in `packages/adapters`, not `packages/core`
- Degraded fallback ships before the old `toModelTurn()` path is removed
- Skip repair prompts in v1

## Verified CLI Constraints

Verified locally on March 18, 2026:

- `Claude Code 2.1.78` supports `--json-schema`
- `claude -p --output-format json --json-schema ...` returns structured output successfully
- `codex-cli 0.112.0` supports `codex exec --output-schema <FILE>`
- Codex requires `"additionalProperties": false` in the schema
- Codex returns the structured payload as a JSON string inside `item.completed.item.text` when `--json` and `--output-schema` are used together
- Codex on this machine needs `model_reasoning_effort="high"` override because local config defaults to unsupported `xhigh`

## Schema Design

Extend the existing `modelTurnSchema` to:

```ts
{
  actor: "gpt" | "claude",
  rawText: string,
  summary: string,
  newInsights: string[],
  assumptions: string[],
  disagreements: string[],
  questionsForPeer: string[],
  questionsForHuman: string[],
  proposedSpecDelta: string,
  milestoneReached: "requirements_clarified" | "architecture_selected" | "implementation_plan_ready" | null,
  degraded: boolean
}
```

Rules:

- `actor` is adapter-injected
- `degraded` defaults to `false` for validated turns and `true` for fallback turns
- provider-facing schema is derived from the same Zod source by omitting `actor` and `degraded`

## Schema File Management

Codex requires a schema file path, not inline JSON.

Implementation choice:

- generate a committed JSON schema asset from the Zod source using Zod v4 `toJSONSchema()`
- place the generated file in `packages/adapters/schemas/`
- adapters/transports use that asset as the Codex output schema source

This avoids schema drift without inventing a second hand-maintained schema.

## Provider Design

### Claude

Use:

- `claude -p`
- `--output-format json`
- `--json-schema ...`

Behavior:

- no progress streaming
- one final structured turn result per turn
- UI shows pending/thinking state during Claude turns

### Codex

Use:

- `codex exec --json`
- `--output-schema <generated-schema-file>`
- `-c 'model_reasoning_effort="high"'`

Behavior:

- transport still parses JSONL events
- authoritative structured turn comes from final `item.completed.item.text`
- no partial turn semantics are trusted by orchestration

## Layer Responsibilities

### Core

- defines `modelTurnSchema`
- defines milestone enum
- defines checkpoint policy and state machine

### Transports

- spawn CLI processes
- manage timeout, stdout, stderr, exit handling
- yield raw provider output events only

### Adapters

- build provider prompts
- parse provider raw output into JSON
- validate against Zod
- inject `actor`
- produce either a validated structured turn or a degraded fallback turn

### Orchestrator

- consumes structured turns only
- stores real semantic fields in state
- forwards `rawText` or `summary + proposedSpecDelta`, not raw JSON blobs

## Event Contract

Change `NormalizedProviderEvent` so orchestration receives:

```ts
| { type: "status"; value: "started" | "streaming" }
| { type: "stderr"; text: string }
| { type: "error"; message: string }
| { type: "structured_turn"; actor: "gpt" | "claude"; turn: ModelTurn }
| { type: "done" }
```

This is cleaner than overloading the existing text-only `turn` event.

## Prompting Design

Prompt templates live in `packages/adapters/src/prompts/`.

Each prompt should include:

- provider role
- user problem statement
- latest peer `rawText`
- current working summary
- explicit instruction to return schema-constrained output only

Prompt budget policy:

- forward latest peer `rawText`
- forward a compact running summary, not full prior turn JSON
- do not forward previously emitted structured JSON objects
- cap forwarded context aggressively if it grows beyond practical size

## Degraded Mode

If structured validation fails:

1. store the raw response
2. create a fallback `ModelTurn` with:
   - `rawText = raw provider output`
   - `summary = raw provider output`
   - semantic arrays empty
   - `milestoneReached = null`
   - `degraded = true`
3. continue with turn-count checkpointing for that round

No repair prompt in v1.

UI requirement:

- degraded checkpoints must be visibly marked as limited analysis

## Orchestration Design

Move from:

- provider text -> `toModelTurn()` with empty fields

To:

- provider raw result -> adapter validation -> `structured_turn`
- orchestrator stores validated `ModelTurn`
- `shouldCheckpoint()` reads:
  - `questionsForHuman`
  - `disagreements`
  - `milestoneReached`
  - exchange count fallback

Forwarding rule for next turn:

- prefer previous turn `rawText`
- if `rawText` is empty, forward `summary`
- optionally append `proposedSpecDelta`

## Implementation Order

### Phase 1: Core Schema

- extend existing `modelTurnSchema`
- add milestone enum
- add tests

### Phase 2: Provider Event Contract

- introduce `structured_turn` event
- update fake providers and adapter tests
- add degraded fallback before removing `toModelTurn()`

### Phase 3: Codex Structured Turn

- generate Codex schema asset from Zod
- update Codex transport to request structured output
- parse final raw JSON string from `item.completed.item.text`
- validate in `CodexAdapter`

### Phase 4: Claude Structured Turn

- rewrite Claude transport for final JSON output mode
- extract `structured_output` from Claude result payload
- validate in `ClaudeAdapter`

### Phase 5: Orchestrator

- replace `toModelTurn()` with structured turn handling
- preserve degraded fallback path
- add semantic checkpoint tests

### Phase 6: UI

- render degraded indicators
- surface real human questions and disagreements
- append proposed spec deltas to the evolving spec view

## Success Criteria

- both providers return validated structured turns locally
- semantic checkpointing fires early on `questionsForHuman`
- semantic checkpointing fires early on `disagreements`
- milestone-based stopping works from enum values
- degraded fallback prevents crashes on malformed output
- existing test suite remains green after schema extension
- degradation rate is measurable from logs or counters

## Current Highest-Risk Item

The hardest part is not transport anymore. It is semantic reliability: getting the models to consistently fill the structured fields in a way that produces useful checkpoint decisions instead of shallow or empty arrays. The implementation should therefore prioritize observability of degraded turns and semantic-field quality from the start.
