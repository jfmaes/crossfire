# Crossfire

Adversarial dual-LLM spec workshop. Claude and Codex argue about your project until they agree on a spec and implementation plan worth building from.

## How it works

1. You describe what you want to build
2. Both models independently analyze the problem, then debate which questions to ask you
3. You answer their agreed interview questions
4. The models run a consensus-driven adversarial debate on the best approach (up to 14 turns)
5. GPT drafts a spec + implementation plan, Claude reviews and refines
6. You approve or request revisions — both documents are downloadable as `.md` artifacts

## Running

Terminal 1 — daemon:
```bash
pnpm install
pnpm dev:daemon
```

Terminal 2 — web:
```bash
pnpm dev:web
```

Open `http://localhost:5173`. Both `claude` and `codex` CLIs must be authenticated on your machine.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COUNCIL_PROVIDER_MODE` | `real` | `real` or `fake` (fake uses canned responses for testing) |
| `COUNCIL_ACCESS_TOKEN` | `local-dev-token` | Auth token for the daemon API |
| `COUNCIL_DATABASE_PATH` | `data/council.sqlite` | SQLite database path |
| `COUNCIL_GROUNDING_ROOT` | — | Optional: default directory for grounding context |

## Architecture

TypeScript monorepo (pnpm workspaces):

```
packages/
  core/       — Zod schemas, phase state machine
  adapters/   — Claude CLI + Codex CLI adapters, phase prompts
  storage/    — SQLite persistence
apps/
  daemon/     — Fastify server, phase orchestrator, session service
  web/        — React frontend
```

## Tests

```bash
pnpm test
```

96 tests across all packages.
