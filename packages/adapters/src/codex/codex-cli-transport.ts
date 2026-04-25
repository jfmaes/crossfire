import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import modelTurnSchemaJson from "../../schemas/model-turn.schema.json";
import type { CodexTransport } from "./codex-transport";

type CodexTransportEvent =
  | { kind: "progress"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "error"; message: string }
  | { kind: "result"; text: string }
  | { kind: "thread_started"; threadId: string };

type ParsedCodexLine =
  | { kind: "thread_started"; threadId: string }
  | { kind: "agent_message"; text: string }
  | { kind: "turn_completed" }
  | { kind: "error"; message: string };

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

function checkCliVersion(input: {
  command: string;
  spawnProcess: (command: string, args: string[]) => SpawnedChild;
  timeoutMs: number;
}): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = input.spawnProcess(input.command, ["--version"]);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;

    const finish = (result: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, detail: `${input.command} --version timed out` });
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
    child.on("error", (error: Error) => {
      finish({ ok: false, detail: `${input.command} unavailable: ${error.message}` });
    });
    child.on("close", (code?: number | null) => {
      const stdout = stdoutChunks.join("").trim();
      const stderr = stderrChunks.join("").trim();
      if (code === 0) {
        finish({ ok: true, detail: stdout || `${input.command} available` });
        return;
      }

      finish({
        ok: false,
        detail: stderr || stdout || `${input.command} --version exited with code ${code ?? "unknown"}`
      });
    });
  });
}

function parseCodexLine(line: string): ParsedCodexLine[] {
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
    return [{ kind: "agent_message", text: parsed.item.text }];
  }

  if (parsed.type === "turn.completed") {
    return [{ kind: "turn_completed" }];
  }

  if (parsed.type === "error" || parsed.type === "turn.failed") {
    return [{ kind: "error", message: parsed.message ?? parsed.error?.message ?? "Codex turn failed" }];
  }

  return [];
}

function isFatalCodexStderr(line: string): boolean {
  return /rmcp::transport::worker:\s*worker quit with fatal/i.test(line)
    || /transport channel closed/i.test(line)
    || /data did not match any variant of untagged/i.test(line)
    || /^error:/i.test(line);
}

function looksLikeStructuredPayload(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```");
}

let schemaFilePathPromise: Promise<string> | undefined;

/**
 * Codex is governed by both prompt prose and `--output-schema`. In this pass
 * we intentionally keep Codex on the canonical full model-turn schema file
 * instead of generating phase-specific schema variants: prompt trimming helps
 * Claude more immediately, while Codex keeps the simpler transport path.
 * Provider-specific Codex phase schemas remain a separate follow-up.
 *
 * Codex CLI expects `--output-schema` to point at a file on disk, so we
 * materialize the shared model-turn schema into a stable cache location instead
 * of creating a throwaway temp file for each turn. The cached file path stays
 * deterministic and is only rewritten when the schema contents change.
 */
async function ensureSchemaFilePath() {
  if (!schemaFilePathPromise) {
    schemaFilePathPromise = (async () => {
      const directory = path.join(os.homedir(), ".cache", "crossfire");
      const filePath = path.join(directory, "model-turn.schema.json");
      const schemaContents = JSON.stringify(modelTurnSchemaJson);
      await mkdir(directory, { recursive: true });

      let existingContents: string | null = null;
      try {
        existingContents = await readFile(filePath, "utf8");
      } catch {
        existingContents = null;
      }

      if (existingContents !== schemaContents) {
        await writeFile(filePath, schemaContents, "utf8");
      }

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
    this.timeoutMs = input.timeoutMs ?? 1_200_000;
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
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        ...fastFlags,
        input.resumeThreadId,
        input.prompt
      ];
    } else {
      args = [
        "exec",
        "--json",
        "--output-schema", schemaFilePath,
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        ...fastFlags,
        input.prompt
      ];
    }

    const child = this.spawnProcess(this.command, args);

    const queue: CodexTransportEvent[] = [];
    let closed = false;
    let childClosed = false;
    let stdoutFinished = false;
    let stderrFinished = false;
    let emittedTerminalError = false;
    let emittedResult = false;
    let latestAgentMessage: string | null = null;
    let wake: (() => void) | undefined;
    const timeout = setTimeout(() => {
      push({ kind: "error", message: "Codex process timed out" });
      child.kill("SIGKILL");
    }, this.timeoutMs);

    const push = (event: CodexTransportEvent) => {
      if (event.kind === "error") {
        emittedTerminalError = true;
      }
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    const maybeClose = () => {
      if (!childClosed || !stdoutFinished || !stderrFinished || closed) {
        return;
      }

      if (!emittedTerminalError && !emittedResult && latestAgentMessage !== null) {
        push({ kind: "result", text: latestAgentMessage });
        latestAgentMessage = null;
      }

      closed = true;
      wake?.();
      wake = undefined;
    };

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    void (async () => {
      try {
        for await (const line of stdoutReader) {
          for (const event of parseCodexLine(line)) {
            if (event.kind === "thread_started") {
              push(event);
              continue;
            }

            if (event.kind === "agent_message") {
              if (latestAgentMessage && !looksLikeStructuredPayload(latestAgentMessage)) {
                push({ kind: "progress", text: latestAgentMessage });
              }
              latestAgentMessage = event.text;
              continue;
            }

            if (event.kind === "turn_completed") {
              if (latestAgentMessage !== null) {
                emittedResult = true;
                push({ kind: "result", text: latestAgentMessage });
                latestAgentMessage = null;
              }
              continue;
            }

            push(event);
          }
        }
      } finally {
        stdoutFinished = true;
        maybeClose();
      }
    })();

    void (async () => {
      try {
        for await (const line of stderrReader) {
          if (line.trim()) {
            push({ kind: "stderr", text: line });

            if (!emittedTerminalError && isFatalCodexStderr(line)) {
              push({ kind: "error", message: line.trim() });
              child.kill("SIGKILL");
            }
          }
        }
      } finally {
        stderrFinished = true;
        maybeClose();
      }
    })();

    child.on("error", (error) => {
      clearTimeout(timeout);
      push({ kind: "error", message: error.message });
      childClosed = true;
      maybeClose();
    });

    child.on("close", () => {
      clearTimeout(timeout);
      childClosed = true;
      maybeClose();
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
    return checkCliVersion({
      command: this.command,
      spawnProcess: this.spawnProcess,
      timeoutMs: Math.min(this.timeoutMs, 5_000)
    });
  }
}
