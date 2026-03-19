import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { FakeProvider } from "@council/adapters";
import { createInMemoryDatabase, SessionRepository } from "@council/storage";
import { afterEach } from "vitest";
import { createSessionService } from "./session-service";

let tempDir: string | undefined;

describe("createSessionService", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates a session and advances past analysis", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await service.createSession({
      title: "Spec a local collaboration tool",
      prompt: "Help me design a dual-LLM planning app"
    });

    expect(result.session.id).toBeTruthy();
    // FakeProvider produces no questions, so analysis skips interview
    // and goes straight to approach debate checkpoint.
    expect(await service.getSession(result.session.id)).not.toBeNull();
  });

  it("progresses through phases via continueSession", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const created = await service.createSession({
      title: "Continuable session",
      prompt: "Initial problem"
    });

    // FakeProvider produces no questions, so it skips to approach debate
    expect(created.session.phase).toBe("approach_debate");

    const continued = await service.continueSession({
      id: created.session.id,
      humanResponse: "Proceed to spec"
    });

    expect(continued).not.toBeNull();
    expect(continued!.session.id).toBe(created.session.id);
    expect(continued!.summary.currentUnderstanding).toBeTruthy();
  });

  it("returns null when continuing a nonexistent session", async () => {
    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await service.continueSession({
      id: "nonexistent",
      humanResponse: "Hello"
    });

    expect(result).toBeNull();
  });

  it("injects grounding context into the first prompt when configured", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-session-grounding-"));
    await writeFile(path.join(tempDir, "README.md"), "# Grounded context\n");

    let seenPrompt = "";

    class CapturingProvider implements ProviderAdapter {
      readonly name = "gpt" as const;

      async *sendTurn(input: ProviderTurnInput) {
        if (!seenPrompt) {
          seenPrompt = input.prompt;
        }

        const turn: ModelTurn = {
          actor: "gpt",
          rawText: "grounded response",
          summary: "grounded response",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "",
          milestoneReached: null,
          degraded: false
        };

        yield { type: "structured_turn", actor: "gpt", turn } as const;
        yield { type: "done" } as const;
      }

      async healthCheck() {
        return { ok: true, detail: "capturing provider ready" };
      }
    }

    const service = createSessionService({
      repository: new SessionRepository(createInMemoryDatabase()),
      gpt: new CapturingProvider(),
      claude: new FakeProvider("claude"),
      grounding: {
        rootDir: tempDir,
        maxFiles: 1,
        includeExtensions: [".md"]
      }
    });

    await service.createSession({
      title: "Grounded session",
      prompt: "Use repo context"
    });

    expect(seenPrompt).toContain("Grounding context:");
    expect(seenPrompt).toContain("# Grounded context");
  });
});
