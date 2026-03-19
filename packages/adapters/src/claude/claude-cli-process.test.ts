import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeCliProcess } from "./claude-cli-process";

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

describe("ClaudeCliProcess", () => {
  it("parses stream-json output and returns the final result text", async () => {
    const runner = new ClaudeCliProcess({
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [
            JSON.stringify({ structured_output: { ok: "claude-ok" } })
          ],
          stderrLines: ["claude stderr"]
        })
    });

    const events = [];

    for await (const event of runner.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: claude-ok"
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stderr", text: "claude stderr" },
      { type: "result", text: JSON.stringify({ ok: "claude-ok" }) }
    ]);
  });

  it("emits an error when the subprocess times out", async () => {
    const runner = new ClaudeCliProcess({
      timeoutMs: 10,
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [],
          autoClose: false
        })
    });

    const events = [];

    for await (const event of runner.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: claude-ok"
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", message: "Claude process timed out" }]);
  });
});
