# Crossfire — Implementation Status

_Last updated: 2026-03-18_

> **Note:** The design docs in this directory (`dual-llm-spec-collaboration-design.md`, `structured-turn-extraction-design.md`, `the-council-runtime-integration.md`, `the-council-v1-implementation.md`) are historical plans from the initial build. They were fully executed and are kept for reference. This file is the canonical source of truth for current state.

## Completed

### Core Architecture
- [x] TypeScript monorepo (pnpm workspaces): `core`, `adapters`, `storage`, `daemon`, `web`
- [x] Zod schemas for ModelTurn, SessionPhase, InterviewQuestion, CheckpointSummary
- [x] SQLite persistence: sessions (with full prompt), interview_questions, phase_results, session_summaries
- [x] Migration system for schema evolution
- [x] `SessionState` type exported from core; consensus logic lives in orchestrator

### 4-Phase Session Lifecycle
- [x] **Analysis phase** — dual independent analysis (GPT + Claude in parallel) followed immediately by question debate. No checkpoint between — human only sees questions after models agree.
- [x] **Interview phase** — one question at a time, models evaluate answers in parallel, can propose follow-ups. "enough" to skip remaining questions.
- [x] **Approach Debate phase** — consensus-driven adversarial debate (up to 14 turns, stops when both models have zero disagreements or milestone reached)
- [x] **Spec Generation phase** — produces two documents: specification AND implementation plan. GPT drafts both, Claude reviews/finalizes. Revision loop: non-"approve" feedback re-runs generation. "approve" finalizes and writes `.md` artifacts.

### Adversarial Prompting System
- [x] Third-person personas (Dr. Chen / Dr. Rivera) with professional stakes
- [x] Anti-sycophancy protocol (agreement must be earned, vague acknowledgments prohibited)
- [x] Phase-aware turn instructions (independent analysis → cross-critique → defense and resolution)
- [x] Consensus-driven debate termination (not fixed turn count)

### CLI Integration
- [x] Claude adapter: `claude -p --dangerously-skip-permissions --output-format json --json-schema`
- [x] Codex adapter: `codex exec --json --output-schema --skip-git-repo-check --full-auto`
- [x] Phase-aware prompt passthrough (when `phase` is set, adapters pass prompts through directly)
- [x] Claude JSON envelope stripping (handles `structured_output`, `result` field, raw fallback)
- [x] Code fence stripping (`` ```json ... ``` `` → raw JSON before parsing)
- [x] 5-minute timeout (300s) for both CLIs
- [x] Graceful degradation for malformed model output (degraded turns with re-parsing)

### Web Frontend
- [x] Dark modern UI with glass-morphism panels
- [x] Hash-based routing (`#/session/:id`) — back/forward work, bookmarkable, direct links
- [x] Phase indicator (4 phases, color-coded progress)
- [x] Phase guidance banner — explains what happened and what to do next at each phase
- [x] AnalysisCard — side-by-side GPT/Claude analyses + debate summary
- [x] DebateCard — color-coded turns (GPT blue, Claude purple) with converged approach
- [x] InterviewCard — current question, progress, model evaluation of answers, history accordion
- [x] SpecCard — rendered spec AND implementation plan as collapsible sections, download buttons for `.md` artifacts
- [x] Markdown rendering for model output (headings, bold, lists, code blocks)
- [x] Phase-aware loading messages (describes what models are doing, not just "Reasoning...")
- [x] Grounding directory input on session form
- [x] Error recovery UI ("Retry phase" button when errored)
- [x] Original prompt displayed when viewing any session (not truncated to title)
- [x] Finalized banner with clear messaging for completed sessions

### Session Management
- [x] Session list endpoint (`GET /sessions`) with UI on landing page
- [x] Load previous session — click to view, continues from current phase
- [x] Restart session — clears all phase data, re-runs from scratch with same prompt
- [x] Delete session — removes all associated data
- [x] New session button — returns to landing page

### Streaming & Progress
- [x] SSE progress endpoint (`GET /progress`) — real-time event stream
- [x] Progress events: phase starts, model turns (with timing, disagreement counts), consensus detection
- [x] Frontend ProgressFeed component with live log, color-coded per model
- [x] Terminal logging via the same event bus

### Artifacts
- [x] Spec written as `{sessionId}-spec.md` on finalize
- [x] Implementation plan written as `{sessionId}-plan.md` on finalize
- [x] Download endpoint: `GET /artifacts/:sessionId/:type` (spec or plan)
- [x] Download buttons in UI when session is finalized
- [x] Artifacts directory: `data/artifacts/`

### Reliability
- [x] Error recovery: errored sessions can be retried
- [x] Spec revision loop: non-"approve" feedback triggers re-generation with feedback
- [x] Full prompt persistence (stored at creation, used throughout all phases)

### Testing
- [x] 96 tests passing across all packages
- [x] Phase machine transitions (4 phases)
- [x] Consensus-driven orchestrator (convergence, safety cap, human escalation, milestone)
- [x] Session service lifecycle (all 4 phases, error recovery, spec revision, prompt persistence)
- [x] Storage CRUD (interview questions, phase results, upserts, delete)
- [x] Frontend components (PhaseIndicator, AnalysisCard, DebateCard, InterviewCard, SpecCard)

### Documentation
- [x] Blog post: `crossfire-when-one-llm-isnt-enough.md` with real E2E results and screenshots
- [x] README with setup instructions and architecture overview
- [x] This implementation status doc

---

## Remaining

- [ ] **Configurable debate cap** — 14-turn safety cap is hardcoded. Could expose as a session-level setting.
- [ ] **Turn history persistence** — individual debate turns aren't persisted across phases. Summary is saved but full transcript isn't replayable after session ends.
- [ ] **Grounding file picker** — text input works but a directory browser would be friendlier.

## Future Features

- [ ] **Code review mode** — same adversarial pattern applied to reviewing implementations
- [ ] **Architecture decision records** — debate trade-offs, output as ADR markdown
- [ ] **Threat modeling mode** — adversarial by nature, perfect for dual-LLM analysis
- [ ] **RALPH loops** — recursive adversarial LLM planning with human checkpoints
- [ ] **Multi-session workspace** — group related sessions for the same project
