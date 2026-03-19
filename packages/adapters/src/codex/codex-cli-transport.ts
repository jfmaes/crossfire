import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import modelTurnSchemaJson from "../../schemas/model-turn.schema.json";
import type { CodexTransport } from "./codex-transport";

type CodexTransportEvent =
  | { kind: "stderr"; text: string }
  | { kind: "error"; message: string }
  | { kind: "result"; text: string }
  | { kind: "thread_started"; threadId: string };

type SpawnedChild = Pick<ChildProcess, "on"> & {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
};

function defaultSpawnProcess(command: string, args: string[]): SpawnedChild {
  return spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function parseCodexLine(line: string): CodexTransportEvent[] {
  let parsed: {
    type?: string;
    thread_id?: string;
    message?: string;
    error?: { message?: string };
    item?: { type?: string; text?: string };
  };
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  if (parsed.type === "thread.started" && parsed.thread_id) {
    return [{ kind: "thread_started", threadId: parsed.thread_id }];
  }

  if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
    return [{ kind: "result", text: parsed.item.text }];
  }

  if (parsed.type === "error" || parsed.type === "turn.failed") {
    return [{ kind: "error", message: parsed.message ?? parsed.error?.message ?? "Codex turn failed" }];
  }

  return [];
}

let schemaFilePathPromise: Promise<string> | undefined;

async function ensureSchemaFilePath() {
  if (!schemaFilePathPromise) {
    schemaFilePathPromise = (async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "council-codex-schema-"));
      const filePath = path.join(directory, "model-turn.schema.json");
      await writeFile(filePath, JSON.stringify(modelTurnSchemaJson), "utf8");

      const cleanup = () => { void rm(directory, { recursive: true, force: true }); };
      process.on("exit", cleanup);

      return filePath;
    })();
  }

  return schemaFilePathPromise;
}

export class CodexCliTransport implements CodexTransport {
  private readonly command: string;
  private readonly spawnProcess: (command: string, args: string[]) => SpawnedChild;
  private readonly timeoutMs: number;
  private readonly fastMode: boolean;

  constructor(input: {
    command?: string;
    spawnProcess?: (command: string, args: string[]) => SpawnedChild;
    timeoutMs?: number;
    fastMode?: boolean;
  } = {}) {
    this.command = input.command ?? "codex";
    this.spawnProcess = input.spawnProcess ?? defaultSpawnProcess;
    this.timeoutMs = input.timeoutMs ?? 300_000;
    this.fastMode = input.fastMode ?? false;
  }

  async *runTurn(input: { sessionId: string; prompt: string; resumeThreadId?: string }) {
    const schemaFilePath = await ensureSchemaFilePath();

    const fastFlags = this.fastMode
      ? ["-c", 'service_tier="fast"', "--enable", "fast_mode"]
      : [];

    let args: string[];
    if (input.resumeThreadId) {
      args = [
        "exec", "resume",
        input.resumeThreadId,
        "--json",
        "--output-schema", schemaFilePath,
        "--skip-git-repo-check",
        "--full-auto",
        ...fastFlags,
        input.prompt
      ];
    } else {
      args = [
        "exec",
        "--json",
        "--output-schema", schemaFilePath,
        "--skip-git-repo-check",
        "--full-auto",
        ...fastFlags,
        input.prompt
      ];
    }

    const child = this.spawnProcess(this.command, args);

    const queue: CodexTransportEvent[] = [];
    let closed = false;
    let wake: (() => void) | undefined;
    const timeout = setTimeout(() => {
      push({ kind: "error", message: "Codex process timed out" });
      child.kill("SIGKILL");
    }, this.timeoutMs);

    const push = (event: CodexTransportEvent) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    void (async () => {
      for await (const line of stdoutReader) {
        for (const event of parseCodexLine(line)) {
          push(event);
        }
      }
    })();

    void (async () => {
      for await (const line of stderrReader) {
        if (line.trim()) {
          push({ kind: "stderr", text: line });
        }
      }
    })();

    child.on("error", (error) => {
      clearTimeout(timeout);
      push({ kind: "error", message: error.message });
      closed = true;
      wake?.();
      wake = undefined;
    });

    child.on("close", () => {
      clearTimeout(timeout);
      closed = true;
      wake?.();
      wake = undefined;
    });

    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }

      yield queue.shift()!;
    }
  }

  async healthCheck() {
    return { ok: true, detail: `${this.command} configured` };
  }
}
