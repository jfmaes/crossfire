import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexCliTransport } from "./codex-cli-transport";

function createFakeChild({
  stdoutLines,
  stderrLines = [],
  autoClose = true
}: {
  stdoutLines: string[];
  stderrLines?: string[];
  autoClose?: boolean;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill(signal?: string): void;
  };

  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1);
  };

  queueMicrotask(() => {
    for (const line of stdoutLines) {
      child.stdout.write(`${line}\n`);
    }

    for (const line of stderrLines) {
      child.stderr.write(`${line}\n`);
    }

    if (autoClose) {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    }
  });

  return child;
}

describe("CodexCliTransport", () => {
  it("parses JSONL output and surfaces stderr", async () => {
    const transport = new CodexCliTransport({
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item_1", type: "agent_message", text: "codex-ok" }
            }),
            JSON.stringify({ type: "turn.completed" })
          ],
          stderrLines: ["codex stderr"]
        })
    });

    const events = [];

    for await (const event of transport.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: codex-ok"
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { kind: "stderr", text: "codex stderr" },
      { kind: "result", text: "codex-ok" }
    ]);
  });

  it("emits an error when the subprocess times out", async () => {
    const transport = new CodexCliTransport({
      timeoutMs: 10,
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [],
          autoClose: false
        })
    });

    const events = [];

    for await (const event of transport.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: codex-ok"
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ kind: "error", message: "Codex process timed out" }]);
  });
});
