# Crossfire

Adversarial dual-LLM spec workshop. Two local AI collaborators (Claude + GPT), one bounded reasoning loop, and checkpoints that keep the human in control.

Crossfire orchestrates Claude and GPT through a structured multi-phase process to produce high-quality technical specifications. The models analyze problems independently, debate their approaches adversarially, interview the human for constraints, and converge on a specification that both endorse.

> **Local-only by design.** Crossfire is built for single-user, localhost deployment. It has not been hardened for multi-user, public-internet, or shared-server use. See [Security considerations](#security-considerations) below for details on what would need to change before exposing it beyond your own machine.

> **Blog post:** [Crossfire: When One LLM Isn't Enough](https://jfmaes.me/blog/crossfire-when-one-llm-isnt-enough/) — the motivation, architecture, and lessons learned building this.

## How it works

1. You describe what you want to build
2. Both models independently analyze the problem, then debate which questions to ask you
3. You answer their agreed interview questions one at a time (type `enough` to skip ahead)
4. The models run a consensus-driven adversarial debate on the best approach
5. GPT drafts a spec + implementation plan, Claude reviews and refines
6. You approve or request revisions -- both documents are downloadable as `.md` artifacts

## Architecture

```
apps/web        React frontend (Vite)        -> http://localhost:5173
apps/daemon     Fastify API + orchestrator   -> http://localhost:8787
packages/core   Zod schemas, state machines
packages/adapters  Claude CLI + Codex CLI adapters
packages/storage   SQLite persistence (better-sqlite3)
```

The daemon spawns `claude` and `codex` CLI processes and orchestrates them through four phases. The frontend connects via REST + Server-Sent Events for live progress.

## Prerequisites

- Node.js 20+
- pnpm 10+
- [Claude Code](https://claude.ai/claude-code) CLI (`claude`) installed and authenticated
- [Codex CLI](https://github.com/openai/codex) (`codex`) installed and authenticated

## Quick start

```bash
pnpm install
```

Start the daemon and web frontend in separate terminals:

```bash
# Terminal 1 -- daemon
pnpm dev:daemon

# Terminal 2 -- web UI
pnpm dev:web
```

Open http://localhost:5173 and describe a problem.

## Docker (experimental)

> **Recommended: run on the host.** Both `claude` and `codex` CLIs rely on host-level authentication (browser OAuth, config files) that doesn't translate cleanly into containers. Running directly on the host avoids credential mounting issues, token expiry, and network edge cases. Use Docker only if you have a specific reason to containerize.

Build and run with Docker Compose. The container mounts your host CLI credentials so `claude` and `codex` are authenticated inside the container.

```bash
# Build the frontend first (nginx serves the static build)
pnpm install && pnpm build

# Start daemon + nginx
docker compose up --build
```

Open http://localhost:5173. The daemon runs on port 8787 behind nginx.

**CLI authentication:** The container mounts your host CLI credentials (`~/.claude`, `~/.claude.json`, `~/.codex`) as read-only volumes into `/root/` inside the container. Both CLIs must be authenticated on your host before running.

**Root user note:** The container runs as root by default. If your CLI credentials live in a non-root home directory (e.g. `/home/youruser/.claude`), the default `docker-compose.yml` mounts from `~/.claude` which resolves to the current user's home. This works out of the box. If Claude Code is installed system-wide as root, the credential paths may differ -- adjust the volume mounts accordingly.

**Codex token expiry:** If you use codex with browser-based auth (`codex login`), the OAuth token expires frequently. Inside Docker there's no browser to auto-refresh. Either re-run `codex login` on the host before starting the container, or set `OPENAI_API_KEY` in your `.env` file for API key auth which doesn't expire.

Alternatively, skip credential mounts entirely and set API keys directly:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Data (SQLite database, artifacts, debug logs) is persisted to `./data/` on the host via a volume mount.

## Environment variables

All configuration is done through environment variables. Set them in your shell, in a `.env` file (for Docker Compose), or export them before starting the daemon.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Daemon listen port |
| `HOST` | `127.0.0.1` | Daemon bind address. Defaults to loopback (localhost only). Set to `0.0.0.0` to listen on all interfaces -- see [Security considerations](#security-considerations) first. |
| `COUNCIL_ACCESS_TOKEN` | *(random UUID)* | API authentication token. Auto-generated on each startup if not set. Set this to a fixed value to avoid needing a new token every restart. |
| `COUNCIL_PROVIDER_MODE` | `real` | `real` for CLI providers, `fake` for testing |
| `COUNCIL_DATABASE_PATH` | `data/council.sqlite` | SQLite database file location |
| `COUNCIL_GROUNDING_ROOT` | -- | Directory for file grounding context. Files matching the allowed extensions (`.md`, `.ts`, `.tsx`, `.js`, `.json`) are read and injected into LLM prompts. Files larger than 100 KB are skipped; total grounding is capped at 500 KB. |
| `CODEX_FAST_MODE` | `true` | Codex fast mode (~4x faster, 2x credit cost). Set to `0` or `false` to disable. |
| `CROSSFIRE_DEBUG` | `0` | Set to `1` or `true` to enable full LLM prompt/response logging. Off by default. See [Debug logging](#debug-logging). |
| `CROSSFIRE_DEBUG_DIR` | `data/debug` | Directory for debug log files (only written when `CROSSFIRE_DEBUG=1`) |

**Examples:**

```bash
# Enable debug logging and use a fixed access token
CROSSFIRE_DEBUG=1 COUNCIL_ACCESS_TOKEN=my-secret-token pnpm dev:daemon

# Ground models with your project's source files
COUNCIL_GROUNDING_ROOT=/path/to/your/project pnpm dev:daemon

# Docker Compose: set variables in .env
echo 'COUNCIL_ACCESS_TOKEN=my-secret-token' >> .env
echo 'CROSSFIRE_DEBUG=1' >> .env
docker compose up --build
```

## Debug logging

LLM prompt and response logging is **off by default**. Enable it by setting `CROSSFIRE_DEBUG=1`. When enabled, every prompt sent to and response received from the models is written to `data/debug/` (or the path in `CROSSFIRE_DEBUG_DIR`).

Each log file includes the session ID, phase, model, elapsed time, and the full prompt or response text. Useful for diagnosing slow turns and understanding model behavior.

**Warning:** Debug logs contain the full text of prompts, which includes any grounded source code and the models' complete responses. Do not enable debug logging in environments where the log directory could be accessed by untrusted parties.

## Session reuse for performance

Both CLI adapters reuse conversation sessions across all phases. The analysis phase establishes the session; every subsequent phase resumes it via `--resume` (Claude) or `exec resume` (Codex). The original problem context is only sent once -- later phases benefit from the model's conversation cache, significantly reducing per-turn inference time.

**Note:** Inference latency is still a real bottleneck. Each CLI invocation spawns a fresh OS process, and model reasoning time for complex problems can exceed 2-3 minutes per turn. Session reuse mitigates redundant context processing but does not eliminate the fundamental inference cost. For large prompts with grounding context (40k+ chars), expect the initial analysis phase to take several minutes.

## Security considerations

Crossfire is designed for **local, single-user use**. If you are considering exposing it to a network or running it on a shared server, be aware of the following limitations that have not been addressed:

- **No rate limiting or abuse control.** Every accepted request can spawn expensive, long-running LLM work. There is no throttling, request size limit, or concurrency cap beyond per-session conflict detection. A malicious or misbehaving client could exhaust your API credits or saturate the host.

- **Single shared auth token.** Authentication is a single bearer token, not per-user credentials. Anyone with the token has full access to all sessions. There is no session ownership, role-based access, or audit trail per user.

- **Grounding reads files from the server's filesystem.** When `COUNCIL_GROUNDING_ROOT` is set, the daemon reads files from that directory and injects their contents into LLM prompts. The grounding root is set at the daemon level (not per-request), but the daemon process has whatever filesystem access its OS user has.

- **No TLS.** The daemon serves plain HTTP. If exposed beyond localhost, traffic (including the auth token) is sent in cleartext.

- **Live-path grounding is not reproducible.** Grounded file contents come from whatever is on disk at session creation time. Files can change between session creation and restart, so restarts may produce different results. There is no snapshotting or content hashing.

These are acceptable trade-offs for a tool running on your own machine against your own API keys. They would need to be addressed before any kind of shared or remote deployment.

## Testing

```bash
pnpm test           # run all tests once
pnpm test:watch     # watch mode
```

## Project structure

```
apps/
  daemon/src/
    main.ts                    Entry point, provider wiring, startup recovery
    server.ts                  Fastify setup, SSE, artifact download routes
    routes/sessions.ts         REST endpoints for session CRUD + continuation
    services/
      session-service.ts       Session lifecycle and phase transitions
      phase-orchestrator.ts    Dual-LLM phase coordination (analysis, debate, spec)
      orchestrator.ts          Multi-turn adversarial debate engine
      progress.ts              SSE event emitter
      debug-log.ts             LLM I/O file logging
      artifacts.ts             Markdown artifact writer
      grounding.ts             File context collector
    plugins/
      access-token.ts          Bearer token auth

  web/src/
    App.tsx                    Main SPA router and state
    lib/api.ts                 REST client + types
    lib/render-markdown.ts     Lightweight markdown-to-HTML renderer
    components/                UI components (analysis, interview, debate, spec cards)
    styles/app.css             Full stylesheet

packages/
  core/src/
    contracts/session.ts       Zod schemas for turns, checkpoints, phases
    orchestration/             Session and phase state machines

  adapters/src/
    base/provider-adapter.ts   Shared adapter interface
    claude/                    Claude CLI adapter with cross-phase session reuse
    codex/                     Codex CLI adapter with cross-phase session reuse
    prompts/                   Phase-specific prompt templates

  storage/src/
    database.ts                SQLite schema and migrations
    session-repository.ts      CRUD + interview questions + phase results
```
