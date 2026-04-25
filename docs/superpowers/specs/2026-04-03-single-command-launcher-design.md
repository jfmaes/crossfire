# Single-Command Launcher for Crossfire

**Date:** 2026-04-03
**Status:** Approved

## Problem

Running crossfire requires two terminals (`pnpm dev:daemon` + `pnpm dev:web`) and knowledge of the monorepo layout. First-time users and regular users alike want a single command that starts everything.

## Solution

A Node.js launcher script at `scripts/start.ts` that spawns both the daemon and web dev server, coordinates startup, and presents a clean output.

## Launcher Script (`scripts/start.ts`)

### Startup Sequence

1. Set `COUNCIL_ACCESS_TOKEN=local-dev-token` in the environment if not already set — guarantees daemon and web frontend agree on the token without manual configuration.
2. Spawn the daemon process (`tsx apps/daemon/src/main.ts`) with stdout/stderr piped.
3. Poll `http://127.0.0.1:8787/health` until it responds (timeout after 15 seconds, exit with error if it doesn't come up).
4. Spawn the Vite dev server (`pnpm dev:web`) with stdout/stderr piped.
5. Print a startup banner:
   ```
   Crossfire running
     Web UI:  http://localhost:5173
     API:     http://localhost:8787
     Token:   local-dev-token

     Press Ctrl+C to stop.
   ```

### Output Modes

- **Normal mode (default):** Suppress child stdout. Only show the startup banner. Stderr from either process is always forwarded so errors are visible.
- **Verbose mode (`--verbose` flag):** Forward all child output with prefixes (`[daemon]` / `[web]`) for identification.

### Shutdown

On SIGINT or SIGTERM, kill both child processes and exit cleanly. Use process group or tree-kill approach to ensure no orphaned processes.

### Error Handling

- If the daemon fails to start (health check timeout), print an error message and exit with code 1.
- If either child process exits unexpectedly, kill the other and exit with the failed process's exit code.

## Package.json Scripts

Add to the root `package.json`:

```json
"start": "tsx scripts/start.ts",
"dev": "tsx scripts/start.ts",
"start:verbose": "tsx scripts/start.ts --verbose"
```

- `pnpm start` and `pnpm dev` — run the clean launcher (identical behavior).
- `pnpm start:verbose` — same launcher with full log output.
- Existing `dev:daemon` and `dev:web` scripts remain for running components individually.

## Dependencies

Add `tsx` as a root devDependency. It currently exists in `apps/daemon` and `packages/adapters` but not at the root, and the `pnpm start` script runs from the root workspace.

## Scope Boundaries

This design intentionally does NOT include:

- Preflight checks for CLI installations (claude, codex) — future work.
- Docker or production mode changes.
- Changes to the daemon or web app source code.
- New npm dependencies.
