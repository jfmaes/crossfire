# Dual LLM Spec Collaboration Design

> **ARCHIVED** — This design was fully implemented. The system evolved beyond this spec (4-phase lifecycle, consensus-driven debate, dual artifact output). See `2026-03-18-implementation-status.md` for current state.

## Summary

Build a local-only, daemon-backed web app that lets a human describe a problem, then have GPT and Claude collaborate on a bounded, inspectable spec-writing loop. The system is summary-first, uses hybrid checkpoints every 4 exchanges or earlier when needed, supports read-only local repo/doc grounding, and produces a living spec plus an implementation plan.

## Recommended Approach

### Option 1: Stateless turn relay

Run `codex exec --json` and `claude -p --output-format stream-json` for each exchange, persist the conversation in the app, and rehydrate context every turn.

Trade-offs:
- Simplest to build
- Easiest to debug initially
- Context gets expensive and brittle quickly
- Feels less live as sessions grow

### Option 2: Stateful local orchestrator

Run a local daemon that owns the conversation, event log, checkpoint policy, and provider adapters. Use a stateful Codex surface where possible, and a structured Claude CLI adapter for streamed turns. The browser UI talks only to this daemon.

Trade-offs:
- More setup and moving parts
- Materially better control over pacing, summaries, retries, repo grounding, and future extension

Recommendation:
- Use this approach for v1

### Option 3: PTY-driven interactive harness

Spawn both CLIs in pseudo-terminals and treat them like live chat peers, scraping output and injecting prompts as if a human were typing.

Trade-offs:
- Closest to the "two tools talking in real time" idea
- Most brittle by far
- Prompt formatting, auth flows, terminal behavior, and version changes will break it

## Design Section 1: Product Shape

The app is a local-only, daemon-backed web app for collaborative product/spec discovery. The human submits a problem or idea, the daemon starts a bounded collaboration loop between GPT and Claude, and the UI stays summary-first: checkpoint summaries are primary, raw inter-model exchanges are expandable.

Core boundaries:
- Browser UI: collects prompts, shows progress summaries, lets the user steer, inspect transcript, and attach a repo or docs folder in read-only mode
- Local daemon: source of truth for session state, orchestration rules, event storage, checkpoint timing, summaries, and failure handling
- Provider adapters: one adapter for Codex, one for Claude Code, each exposing a common interface like `send()`, `stream()`, `cancel()`, `health()`, `limits()`
- Artifacts store: persists the living spec, implementation plan, transcript, and per-checkpoint summaries on disk

Default collaboration loop:
- Human gives the initial problem statement
- Both models get the same brief plus explicit roles
- They exchange up to 4 cross-model turns unless a milestone or blocking uncertainty appears first
- The daemon interrupts, synthesizes a human-readable checkpoint, and asks for confirmation only when needed
- After user steering, the loop resumes
- The session ends with a living spec plus implementation plan

This system is not truly peer-to-peer. It is orchestrated peer simulation. That is desirable because it gives control over waste, visibility, and recoverability.

## Design Section 2: Orchestration Loop

The daemon should run a strict session state machine rather than an open-ended chat relay:

`intake -> context grounding -> dual kickoff -> debate loop -> checkpoint -> human steer -> resume or finalize`

Each model gets a stable starting role:
- Claude: constraint finder, ambiguity detector, risk reviewer
- GPT: synthesizer, structure builder, implementation planner

Those roles are prompt biases, not hard limits.

Each exchange should use a structured envelope rather than raw transcript only. For every model turn, the adapter should ask for:
- `summary`
- `new_insights`
- `assumptions`
- `disagreements`
- `questions_for_peer`
- `questions_for_human`
- `proposed_spec_delta`
- `milestone_reached`

This makes the loop inspectable and allows checkpointing without needing a third model purely for summarization.

Checkpoint policy is hybrid:
- Hard stop after 4 inter-model exchanges
- Early stop if either model flags `questions_for_human`
- Early stop if either model claims a milestone such as "requirements clarified" or "implementation plan drafted"
- Early stop if they disagree materially on architecture or scope

At each checkpoint, the daemon presents a compact update to the human:
- What they think the problem is
- What they currently recommend
- What changed since the last checkpoint
- What they are unsure about
- The one or two decisions they need now

The human remains the owner of direction and scope.

## Design Section 3: Local System Architecture

Use a TypeScript-first local stack so the UI, daemon, shared types, and provider adapters share one event schema.

Recommended structure:
- `apps/web`: browser UI, connects only to localhost or the local network daemon
- `apps/daemon`: orchestration server and provider process manager
- `packages/core`: session state machine, checkpoint policy, prompt templates, shared types
- `packages/adapters`: `codex` adapter and `claude` adapter
- `packages/storage`: SQLite models plus artifact writers

Runtime boundaries:
- The web app never talks to `codex` or `claude` directly
- The daemon is the only process allowed to launch CLIs, track sessions, read repo context, and persist artifacts
- The adapters normalize provider-specific behavior into a common event stream

Transport and persistence:
- WebSocket between browser and daemon for live updates, transcript expansion, and human steering
- SQLite for sessions, events, checkpoints, artifacts, and settings
- Markdown and JSON files on disk for exported specs and plans

Provider integration:
- Codex: prefer `codex app-server` or the Codex SDK because it is stateful and intended for programmatic control
- Claude: wrap `claude --print --output-format stream-json` in a child-process adapter; preserve session continuity when reliable, otherwise fall back to orchestrator-managed context replay with strict truncation rules
- Common adapter contract: `startSession`, `sendTurn`, `streamEvents`, `cancelTurn`, `healthCheck`, `readLimits`

This is heavier than a shell-script prototype, but that additional structure materially improves resumability, inspectable state, and checkpoint enforcement.

## Design Section 4: UI and Human Experience

The UI should be summary-first, not chat-first. The primary surface is a controlled workbench showing where the discussion stands and what needs human input.

Main screens:
- `New Session`: describe the problem, optionally attach a repo or docs folder in read-only mode, choose mode defaults if needed
- `Session Workspace`: live checkpoint cards, current spec draft, current implementation plan draft, and collapsible raw transcript
- `Artifacts`: finalized spec and plan exports, plus prior session history

The session workspace prioritizes:
- Current understanding
- Recommended direction
- Open risks or disagreements
- Next decision needed from the human
- Live status showing which model is active, waiting, rate-limited, or blocked

The transcript is secondary:
- Hidden by default
- Expandable by checkpoint or by individual exchange
- Clearly labeled by source: `Human`, `GPT`, `Claude`, `System`

Human control actions should be explicit and lightweight:
- Approve current direction
- Correct misunderstanding
- Answer pending question
- Pause debate
- Force checkpoint now
- Finalize spec
- Generate implementation plan

The key UX rule is that the app should never let the models burn too many cycles invisibly. Even when autonomous debate is running, the human should feel informed, interruptible, and in control.

## Design Section 5: Guardrails, Reliability, and V1 Boundaries

The app should assume both provider surfaces are imperfect, especially the Claude CLI side, and still remain usable from both desktop and phone browsers.

Required guardrails:
- Read-only grounding only in v1; attached repos and docs can be inspected, never modified
- Bounded autonomy only; no unbounded model-to-model loops
- Per-session budget limits on exchanges, elapsed time, and optional soft usage thresholds
- Kill switch at both levels: cancel current turn, or stop the whole session
- Deterministic checkpointing so failures do not lose the working state

Failure handling:
- If one provider stalls, rate-limits, or errors, the daemon pauses the debate and reports the issue to the human
- If Claude session continuity proves unstable, the daemon falls back to stateless replay and marks the session as degraded
- If structured output is malformed, the adapter retries once with a repair prompt, then surfaces raw output if still broken

V1 should include:
- Mobile web support over the local network
- Responsive summary-first UI for phone screens
- Session monitoring and steering from a phone browser
- Artifact viewing and checkpoint responses from mobile

This requires the daemon to be hostable on the local machine but reachable from the LAN, with basic local-only access controls.

V1 should still exclude:
- Native iOS or Android apps
- Push notifications
- Background mobile execution guarantees
- Automatic coding or file edits
- Multi-user or public internet exposure
- More than two primary reasoning agents

Success criteria for v1:
- A session can be started from desktop
- It can be monitored and steered from desktop or phone
- Both models contribute to a shared evolving spec
- Checkpoints arrive every few exchanges or earlier when needed
- The session ends with a usable spec and implementation plan artifact on disk
