import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const verbose = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

if (!process.env.COUNCIL_ACCESS_TOKEN) {
  process.env.COUNCIL_ACCESS_TOKEN = "local-dev-token";
}
const token = process.env.COUNCIL_ACCESS_TOKEN;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  prefix: string,
  dest: NodeJS.WritableStream,
) {
  if (!stream) return;
  let leftover = "";
  stream.on("data", (chunk: Buffer) => {
    const text = leftover + chunk.toString();
    const lines = text.split("\n");
    leftover = lines.pop() ?? "";
    for (const line of lines) {
      dest.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (leftover) {
      dest.write(`${prefix} ${leftover}\n`);
    }
  });
}

function pipeChild(child: ChildProcess, label: string) {
  if (verbose) {
    const prefix = `[${label}]`;
    prefixStream(child.stdout, prefix, process.stdout);
    prefixStream(child.stderr, prefix, process.stderr);
  } else {
    // In normal mode, only forward stderr so errors are visible.
    prefixStream(child.stderr, `[${label}]`, process.stderr);
    // Drain stdout to prevent backpressure.
    child.stdout?.resume();
  }
}

function waitForHealth(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  const interval = 250;

  return new Promise<void>((resolve, reject) => {
    function poll() {
      if (signal?.aborted) {
        reject(new Error("Daemon process exited before becoming healthy"));
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            `Daemon did not become healthy within ${timeoutMs / 1000}s`,
          ),
        );
        return;
      }

      const req = http.get(
        url,
        { headers: { "x-council-token": token } },
        (res) => {
          res.resume(); // drain
          if (res.statusCode === 200) {
            resolve();
          } else {
            setTimeout(poll, interval);
          }
        },
      );
      req.on("error", () => {
        setTimeout(poll, interval);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(poll, interval);
      });
    }

    poll();
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let daemon: ChildProcess | undefined;
let web: ChildProcess | undefined;
let shuttingDown = false;

function shutdown(code: number = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const children = [daemon, web].filter(Boolean) as ChildProcess[];
  const exited = new Set<ChildProcess>();
  for (const child of children) {
    child.once("exit", () => exited.add(child));
    child.kill("SIGTERM");
  }

  // Escalate to SIGKILL if children don't exit, then force-quit.
  setTimeout(() => {
    for (const child of children) {
      if (!exited.has(child) && child.exitCode === null) child.kill("SIGKILL");
    }
    process.exit(code);
  }, 2000);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 2. Spawn daemon
  daemon = spawn("tsx", ["apps/daemon/src/main.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  pipeChild(daemon, "daemon");

  daemon.on("error", (err) => {
    console.error(`[daemon] failed to start: ${err.message}`);
    shutdown(1);
  });

  // Abort the health check poll if the daemon exits early.
  const healthAbort = new AbortController();

  daemon.on("exit", (code) => {
    if (!shuttingDown) {
      healthAbort.abort();
      console.error(`[daemon] exited unexpectedly with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  // 3. Poll health check
  try {
    await waitForHealth(
      "http://127.0.0.1:8787/health",
      15_000,
      healthAbort.signal,
    );
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    daemon.kill();
    process.exit(1);
  }

  // 4. Spawn Vite dev server
  web = spawn("pnpm", ["dev:web"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  pipeChild(web, "web");

  web.on("error", (err) => {
    console.error(`[web] failed to start: ${err.message}`);
    shutdown(1);
  });

  web.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[web] exited unexpectedly with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  // 5. Startup banner
  console.log(`
Crossfire running
  Web UI:  http://localhost:5173
  API:     http://localhost:8787
  Token:   ${token}

  Press Ctrl+C to stop.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
