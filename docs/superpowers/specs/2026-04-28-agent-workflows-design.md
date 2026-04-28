# Crossfire Agent Workflows Design

**Date:** 2026-04-28  
**Status:** Proposed  
**Scope:** Add an internal plugin-style workflow package that can launch and monitor multiple Crossfire sessions concurrently for human-led inference workflows. Limited to daemon-consumable workflow infrastructure and one built-in v1 workflow. No standalone operator UI and no new public API surface in v1.

---

## Objective

Crossfire already executes one adversarial spec workflow per session. The next layer should let an agent launch and supervise multiple Crossfire sessions at once without replacing the daemon as the execution engine.

This change should:

- keep the Crossfire daemon responsible for adversarial prompting, phase execution, persistence, and artifacts
- add a separate internal package that coordinates many ordinary Crossfire sessions as one higher-level workflow run
- support agent-triggered multi-session workflows during human-led inference sessions
- monitor concurrent child sessions until they finalize, error, or block on human input
- surface human blockers with a recommendation brief that gives the human more context without auto-answering on their behalf
- keep the new workflow system isolated in its own package so it does not pollute the main daemon service layer
- preserve the current public REST and SSE contracts for v1

This change should **not**:

- replace the daemon with a second orchestration engine
- invoke providers directly from the workflow package
- auto-submit answers back into blocked Crossfire sessions without explicit human approval
- introduce a standalone workflow UI or operator CLI in v1
- add batch workflow APIs, pause/cancel semantics, or multi-user controls in this pass

---

## Product Context

The daemon already has the core execution behavior the new layer needs:

- Crossfire sessions are persisted and tracked independently
- background runs are started asynchronously
- locking is per session, not global, so multiple sessions can run concurrently
- progress is already streamed and queryable by session or run

That means the missing capability is not “run many model conversations.” The missing capability is “treat many ordinary Crossfire sessions as one supervised workflow with escalation and recovery rules.”

The design should therefore add a control plane, not a replacement runtime.

---

## Recommended Approach

Add a new workspace package: `packages/agent-workflows` published internally as `@council/agent-workflows`.

The package runs in-process inside the daemon through a thin integration layer. It does not expose its own server, and it does not own provider execution. Instead, it uses daemon-provided session primitives such as create, continue, restart, rewind, fetch state, read run events, and subscribe to progress.

The central architectural rule is:

**Crossfire sessions stay atomic; the workflow package orchestrates many of them.**

This gives the project:

- isolation through a separate package
- richer control than a pure HTTP black-box controller
- no duplication of the daemon’s adversarial logic
- a path to multiple workflow variants later without scattering policy through `apps/daemon`

---

## Architecture

### Runtime Boundary

The daemon remains the execution engine:

- provider adapters
- phase orchestration
- session lifecycle
- persistence
- SSE progress
- artifact generation

The new package becomes the workflow control plane:

- workflow registry
- workflow-run lifecycle
- child-session fan-out
- monitoring and state classification
- escalation and recommendation generation
- recovery advice
- workflow completion rollups

The package should be consumed through a thin daemon-owned adapter, not by directly reading Fastify internals or SQLite state.

### Package Layout

`packages/agent-workflows/` should contain:

- `specs/`
  - declarative workflow definitions
- `runtime/`
  - workflow engine and run coordinator
- `roles/`
  - logical internal roles such as `launcher`, `monitor`, `question-briefing`, `checkpoint-briefing`, and `recovery-advisor`
- `skills/`
  - reusable decision modules such as `fanout-strategy`, `session-health`, `recommended-answer-context`, and `retry-vs-restart`
- `hooks/`
  - lifecycle extension points for workflow and child-session state transitions
- `adapters/crossfire/`
  - the only package area that knows how to call daemon session primitives
- `types/`
  - shared contracts for workflow specs, runs, child sessions, escalations, and briefs

### Daemon Integration

The first daemon integration should stay narrow:

- one workflow registry that exposes built-in workflow specs
- one workflow engine service instantiated by the daemon
- one internal adapter that wraps existing session-service primitives
- no direct workflow-package access to provider adapters
- no direct workflow-package access to Fastify route handlers
- no direct workflow-package access to `better-sqlite3`

This keeps the daemon as the owner of execution and persistence while still allowing in-process workflow control.

---

## Core Concepts

### Workflow Spec

A `WorkflowSpec` defines one agentic pattern.

It should describe:

- its stable `id`
- its purpose and operator-facing description
- what workflow input it accepts
- how to build concrete child `SessionTemplate`s
- how to classify child-session state from Crossfire snapshots and run events
- how to generate escalation briefs
- when to recommend retry, restart, or terminal failure
- when the workflow counts as settled

### Workflow Run

A `WorkflowRun` is one live execution of a `WorkflowSpec`.

It should track:

- workflow run id
- workflow spec id
- workflow input
- current workflow status
- child session refs
- emitted escalations
- timestamps
- summary and completion rollups

### Child Session

Each child session is an ordinary Crossfire session plus workflow metadata:

- `sessionId`
- template label
- review lens
- current workflow-facing state
- latest run id if active
- latest escalation state
- terminal outcome if complete

### Recommendation Brief

When Crossfire blocks on human input, the workflow should produce a structured `RecommendationBrief` instead of auto-answering.

The brief should include:

- the blocking question or approval gate
- why the session is blocked
- current session context
- recommended answer direction
- tradeoffs and risks
- child-session lens and priority

The brief exists to make the human faster and better informed. It must not submit the answer automatically.

---

## Workflow Lifecycle

Each workflow run should move through five stages:

### 1. Plan

Resolve the selected `WorkflowSpec` and expand workflow input into concrete child session templates.

Each template should capture:

- session mode
- title template
- prompt shaping
- review lens
- expected stop conditions

### 2. Launch

Create the child Crossfire sessions through the daemon adapter.

The workflow run records:

- child `sessionId`
- template label
- review lens
- launch metadata

### 3. Monitor

Observe progress and session state continuously.

The workflow should use:

- progress subscriptions for event-driven updates
- session fetches for authoritative state reconciliation
- run events when more context is needed for recommendation or recovery logic

The monitor is responsible for classifying each child session into a workflow-facing state and for producing workflow-level rollups.

### 4. Escalate

When a child session needs human input or operational intervention, emit a structured escalation event rather than continuing silently.

Two escalation families exist:

- `human_blocked`
  - Crossfire is behaving correctly and needs a human answer or approval
- `recovery_needed`
  - Crossfire failed or degraded in a way that requires advice or intervention

### 5. Settle

A workflow run only settles when every child session is in a true terminal state.

For v1, terminal states are:

- `finalized`
- `errored_terminal`

A workflow does **not** settle when a child is merely waiting for human input. Human blockers are resumable states, not terminal outcomes.

---

## State Model

### Child Session States

Each child session should be classified into exactly one of:

- `running`
  - Crossfire is actively progressing
- `human_blocked`
  - Crossfire surfaced a human question or approval gate
- `resuming`
  - a human has approved the next move and the workflow has continued the child session
- `finalized`
  - Crossfire completed successfully and produced artifacts
- `errored`
  - Crossfire failed and now needs recovery classification

`errored` should then be refined internally into:

- `recoverable_transient`
- `recoverable_operator`
- `terminal`

### Classification Rules

The workflow package should classify child-session state from the daemon’s authoritative session `status`, `phase`, and recent run events.

For v1:

- active Crossfire execution maps to `running`
- Crossfire `waiting_for_human` maps to `human_blocked`
- Crossfire `interviewing` maps to `human_blocked`
- Crossfire `checkpoint` maps to `human_blocked` when a human decision or approval is still required
- immediately after the workflow submits a human-approved continuation, the child enters `resuming` until the daemon reports active progress again
- Crossfire `finalized` maps to `finalized`
- Crossfire `errored` maps to `errored` and must then be refined by the recovery policy

This rule keeps approval gates and interview questions in the same resumable human-owned class, while still allowing the workflow spec to present different recommendation briefs for each situation.

### Workflow Run States

The workflow run should track its own aggregate state separately from the children:

- `planning`
- `launching`
- `monitoring`
- `partially_blocked`
- `resuming`
- `settled`

The aggregate state is derived from the children, but it should remain explicit so the daemon or a future UI can reason about workflow status without re-deriving it every time.

### Human Unblocking Rule

If a child enters `human_blocked`, the workflow keeps monitoring the rest of the children.

When the human provides an answer or approves a recommended direction:

1. the workflow continues that child session through the daemon adapter
2. that child enters `resuming`
3. the workflow returns the child to normal monitoring
4. the workflow continues until the child either hits a new blocker or reaches a true terminal state

This loop may repeat multiple times within one workflow run.

---

## Hooks, Roles, And Skills

### Hooks

Hooks should make the system extensible without spreading policy logic through the daemon.

The v1 hook surface should include:

- `onWorkflowStart`
- `onSessionCreated`
- `onSessionRunning`
- `onSessionWaitingForHuman`
- `onSessionCheckpoint`
- `onSessionFinalized`
- `onSessionErrored`
- `onRecoveryRecommended`
- `onRecoveryExhausted`
- `onWorkflowSettled`

Hooks should fire on state transitions, not on every poll tick, to avoid duplicate escalations and repeated side effects.

### Roles

The workflow package should define logical internal roles rather than direct provider-backed agents.

Initial roles:

- `launcher`
  - expands templates and starts child sessions
- `monitor`
  - watches state and reconciles updates
- `question-briefing`
  - builds recommendation briefs for human blockers
- `checkpoint-briefing`
  - summarizes checkpoint-ready sessions
- `recovery-advisor`
  - recommends retry, restart, or terminal failure handling

These roles are policy modules in v1. They should be shaped so a future version can swap in richer agent implementations without changing the top-level workflow contract.

### Skills

Skills are reusable decision helpers used by the roles.

Initial skills:

- `fanout-strategy`
  - determines how many child sessions to launch and with which lenses
- `session-health`
  - classifies child-session operational state
- `human-question-summarizer`
  - extracts the blocking question and local context
- `recommended-answer-context`
  - produces a recommended response direction and tradeoffs for the human
- `retry-vs-restart`
  - decides when a failed child should retry, restart, or stop
- `consensus-across-sessions`
  - helps compare outcomes across finalized children

---

## Internal Integration Contract

The workflow package should depend on a narrow runtime interface provided by the daemon.

### Crossfire Runtime Adapter

The daemon-facing adapter should provide methods equivalent to:

- `createSession(template)`
- `continueSession(sessionId, humanResponse)`
- `restartSession(sessionId)`
- `rewindSession(sessionId)`
- `getSession(sessionId)`
- `getRun(runId)`
- `listRunEvents(runId)`
- `subscribeProgress(listener)`

This surface gives the workflow package the control it needs without exposing raw daemon internals.

### Workflow Engine

The engine exposed by `@council/agent-workflows` should support:

- `startWorkflow(specId, input)`
- `getWorkflowRun(workflowRunId)`
- `listWorkflowRuns(filter?)`
- `handleHumanResponse(workflowRunId, childSessionId, response, approvalMetadata?)`

The engine owns workflow coordination. The daemon still owns session execution.

---

## V1 Built-In Workflow

V1 should ship with one built-in spec: a parallel multi-lens existing-spec review workflow.

Suggested id:

- `parallel_existing_spec_review`

Suggested default lenses:

- requirements and ambiguity gaps
- architecture and boundary quality
- implementation and rollout risk
- testing, failure modes, and operability

Each lens becomes a separate child Crossfire session in `existing_spec` mode with prompt shaping tuned to that review concern.

This is the best first workflow because:

- it aligns with Crossfire’s existing strength in spec review
- it makes the value of multi-session fan-out obvious
- it does not require new provider behavior
- it exercises every important workflow concern: fan-out, monitoring, escalation, and result rollup

---

## Error Handling And Recovery

A child-session failure should not crash the entire workflow run.

### Failure Policy

If one child session errors:

- the workflow keeps monitoring other active children
- the failed child is classified as recoverable or terminal
- a recovery brief is generated when appropriate

### Error Buckets

Every child error should be classified into one of:

- `recoverable_transient`
  - temporary provider or timing issue
- `recoverable_operator`
  - requires human intervention or judgment
- `terminal`
  - further automation is not justified

### Recovery Rules

For `recoverable_transient`:

- the workflow may recommend retry or restart
- a small retry budget must be enforced
- the workflow must record why recovery was attempted

For `recoverable_operator`:

- the workflow emits a recovery brief for the human
- no silent automation continues until the human decides

For `terminal`:

- the child is marked failed
- the failure is included in the workflow rollup
- no further automation occurs for that child

Human blockers and operational failures must remain distinct:

- `human_blocked` means Crossfire is functioning and wants human input
- `errored` means Crossfire could not continue reliably

---

## Persistence And Recovery

V1 should not keep workflow-run state purely in memory.

These workflows are explicitly asynchronous and human-led. Losing the workflow-to-session mapping on daemon restart would orphan the coordinator layer even though the underlying Crossfire sessions still exist.

The implementation should therefore persist at least:

- workflow run identity
- workflow spec id
- workflow input
- child session mapping
- emitted escalations and their resolution state
- workflow summary state

The workflow package itself should not talk directly to SQLite. Instead, the daemon should provide a persistence adapter backed by `@council/storage`.

The exact schema can remain implementation detail, but the design requirement is explicit:

**workflow runs must be recoverable across daemon restarts.**

---

## Testing

V1 verification should focus on the package as coordination infrastructure.

Add focused tests for:

1. `WorkflowSpec` expansion
   - one workflow input expands into the expected child session templates and lenses

2. state classification
   - existing Crossfire snapshots and run events map correctly to `running`, `human_blocked`, `resuming`, `finalized`, and error states

3. escalation generation
   - blocked children produce a `RecommendationBrief` with question text, context, suggested direction, and risks

4. resume behavior
   - once the human unblocks a child, that child re-enters monitoring and the workflow remains live until the next blocker or terminal outcome

5. partial failure tolerance
   - one child error does not collapse the workflow run and retry budgets are enforced

6. hook semantics
   - hooks fire once on state transitions and do not duplicate escalation side effects during repeated observation

7. daemon integration
   - the daemon can instantiate the workflow engine, start a workflow run, and observe multiple child sessions without exposing new public APIs in v1

---

## Non-Goals

- No standalone workflow dashboard in this pass
- No public workflow REST endpoints in this pass
- No direct provider access from the workflow package
- No auto-answering of human questions
- No multi-user tenancy or permission model
- No pause/cancel semantics unless needed by later workflow variants

---

## Success Criteria

This design is successful if:

1. Crossfire can supervise multiple concurrent child sessions as one workflow run without replacing the daemon as the execution engine
2. the agent workflow logic lives in a separate internal package instead of spreading through `apps/daemon`
3. human blockers produce actionable recommendation briefs but never auto-submit responses
4. unblocked child sessions return to monitoring until the next blocker or terminal outcome
5. a single child failure does not collapse the entire workflow run
6. workflow state survives daemon restarts through explicit persistence
7. v1 delivers one concrete built-in workflow for parallel multi-lens existing-spec review
