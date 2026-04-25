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
  it("checks Codex CLI availability with --version", async () => {
    let capturedArgs: string[] = [];
    const transport = new CodexCliTransport({
      spawnProcess: (_command, args) => {
        capturedArgs = args;
        return createFakeChild({
          stdoutLines: ["codex-cli 1.2.3"]
        });
      }
    });

    await expect(transport.healthCheck()).resolves.toEqual({
      ok: true,
      detail: "codex-cli 1.2.3"
    });
    expect(capturedArgs).toEqual(["--version"]);
  });

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
      { kind: "thread_started", threadId: "thread-1" },
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

  it("fails fast when Codex logs a fatal RMCP transport error to stderr", async () => {
    const transport = new CodexCliTransport({
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [],
          stderrLines: [
            "2026-03-27T19:06:44.821893Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Decode, source: Error(\"data did not match any variant of untagged enum\") }))"
          ],
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

    expect(events).toEqual([
      {
        kind: "stderr",
        text: "2026-03-27T19:06:44.821893Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Decode, source: Error(\"data did not match any variant of untagged enum\") }))"
      },
      {
        kind: "error",
        message: "2026-03-27T19:06:44.821893Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(Reqwest(reqwest::Error { kind: Decode, source: Error(\"data did not match any variant of untagged enum\") }))"
      }
    ]);
  });

  it("uses the current codex exec resume syntax without output-schema", async () => {
    let capturedArgs: string[] = [];

    const transport = new CodexCliTransport({
      spawnProcess: (_command, args) => {
        capturedArgs = args;
        return createFakeChild({
          stdoutLines: [
            JSON.stringify({
              type: "item.completed",
              item: { id: "item_1", type: "agent_message", text: "codex-ok" }
            }),
            JSON.stringify({ type: "turn.completed" })
          ]
        });
      }
    });

    const events = [];

    for await (const event of transport.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: codex-ok",
      resumeThreadId: "thread-123"
    })) {
      events.push(event);
    }

    expect(capturedArgs).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "thread-123",
      "Reply with exactly: codex-ok"
    ]);
    expect(capturedArgs).not.toContain("--output-schema");
    expect(events).toEqual([{ kind: "result", text: "codex-ok" }]);
  });

  it("surfaces intermediate codex agent messages as progress before the final result", async () => {
    const transport = new CodexCliTransport({
      spawnProcess: () =>
        createFakeChild({
          stdoutLines: [
            JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item_0", type: "agent_message", text: "Planning the next step before final output." }
            }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item_1", type: "agent_message", text: "{\"ok\":true}" }
            }),
            JSON.stringify({ type: "turn.completed" })
          ]
        })
    });

    const events = [];

    for await (const event of transport.runTurn({
      sessionId: "sess_1",
      prompt: "Reply with exactly: {\"ok\":true}"
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { kind: "thread_started", threadId: "thread-1" },
      { kind: "progress", text: "Planning the next step before final output." },
      { kind: "result", text: "{\"ok\":true}" }
    ]);
  });
});
