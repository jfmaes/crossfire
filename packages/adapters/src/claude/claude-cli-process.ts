import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import modelTurnSchemaJson from "../../schemas/model-turn.schema.json";
import type { ClaudeProcess } from "./claude-process";

type ClaudeProcessEvent =
  | { type: "result"; text: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string };

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

interface ExtractedResult {
  text: string | null;
  cliSessionId?: string;
}

/**
 * Extract the actual model response from Claude CLI output.
 * Handles multiple wrapping layers:
 * 1. CLI JSON envelope: {"type":"result","result":"...","structured_output":{...}}
 * 2. Code fences inside result: ```json\n{...}\n```
 * 3. structured_output as string or object
 * Also extracts session_id for conversation resumption.
 */
function extractResult(rawOutput: string): ExtractedResult {
  try {
    const parsed = JSON.parse(rawOutput) as {
      structured_output?: unknown;
      result?: string;
      session_id?: string;
    };

    const cliSessionId = parsed.session_id;

    // Prefer structured_output (JSON schema mode)
    if (parsed.structured_output != null) {
      const text = typeof parsed.structured_output === "string"
        ? parsed.structured_output
        : JSON.stringify(parsed.structured_output);
      return { text, cliSessionId };
    }

    // Fall back to result field (plain text mode)
    if (typeof parsed.result === "string") {
      return { text: parsed.result, cliSessionId };
    }

    // No recognized fields — return raw
    return { text: rawOutput, cliSessionId };
  } catch {
    // rawOutput isn't JSON — might be plain text or a partial response
    return { text: rawOutput || null };
  }
}

export class ClaudeCliProcess implements ClaudeProcess {
  private readonly command: string;
  private readonly spawnProcess: (command: string, args: string[]) => SpawnedChild;
  private readonly timeoutMs: number;

  constructor(input: {
    command?: string;
    spawnProcess?: (command: string, args: string[]) => SpawnedChild;
    timeoutMs?: number;
  } = {}) {
    this.command = input.command ?? "claude";
    this.spawnProcess = input.spawnProcess ?? defaultSpawnProcess;
    this.timeoutMs = input.timeoutMs ?? 1_200_000;
  }

  async *runTurn(input: { sessionId: string; prompt: string; degraded?: boolean; resumeSessionId?: string }) {
    const args = [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(modelTurnSchemaJson)
    ];

    if (input.resumeSessionId) {
      args.push("--resume", input.resumeSessionId);
    }

    args.push(input.prompt);

    const child = this.spawnProcess(this.command, args);

    const stderrEvents: ClaudeProcessEvent[] = [];
    const stdoutChunks: string[] = [];
    let timeoutTriggered = false;
    const timeout = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGKILL");
    }, this.timeoutMs);

    void (async () => {
      const stderrReader = createInterface({ input: child.stderr });
      for await (const line of stderrReader) {
        if (line.trim()) {
          stderrEvents.push({ type: "stderr", text: line });
        }
      }
    })();

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk.toString());
    });

    child.on("error", (error) => {
      stderrEvents.push({ type: "error", message: error.message });
    });

    await once(child as never, "close");
    clearTimeout(timeout);

    for (const event of stderrEvents) {
      yield event;
    }

    if (timeoutTriggered) {
      yield { type: "error", message: "Claude process timed out" } as const;
      return;
    }

    const rawOutput = stdoutChunks.join("");

    const result = extractResult(rawOutput);
    if (result.text !== null) {
      yield { type: "result", text: result.text, cliSessionId: result.cliSessionId } as const;
    } else {
      yield { type: "error", message: "Claude result parse failed" } as const;
    }
  }

  async healthCheck() {
    return { ok: true, detail: `${this.command} configured` };
  }
}
