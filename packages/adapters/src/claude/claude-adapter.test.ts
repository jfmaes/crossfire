import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude-adapter";

class FakeClaudeProcess {
  readonly calls: Array<{ sessionId: string; prompt: string; resumeSessionId?: string }> = [];

  async *runTurn(input: { sessionId: string; prompt: string; resumeSessionId?: string }) {
    this.calls.push(input);
    yield {
      type: "result",
      text: JSON.stringify({
        rawText: "Need the human to confirm mobile support.",
        summary: "Need human confirmation on mobile support",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: ["Should mobile support be included in v1?"],
        proposedSpecDelta: "Include mobile web support",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null
      }),
      cliSessionId: `${input.prompt}-session`
    } as const;
  }

  async healthCheck() {
    return { ok: true, detail: "claude ready" };
  }
}

describe("ClaudeAdapter", () => {
  it("normalizes streamed Claude messages", async () => {
    const adapter = new ClaudeAdapter(new FakeClaudeProcess());
    const events: string[] = [];

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Find hidden risks"
    })) {
      events.push(event.type);
    }

    expect(events).toContain("structured_turn");
  });

  it("only resumes within the same phase context", async () => {
    const process = new FakeClaudeProcess();
    const adapter = new ClaudeAdapter(process);

    const send = async (phase: string | undefined, prompt: string) => {
      for await (const _event of adapter.sendTurn({
        sessionId: "sess_1",
        phase,
        prompt
      })) {
        // exhaust generator
      }
    };

    await send("analysis", "analysis prompt");
    await send("interview", "interview prompt 1");
    await send("interview", "interview prompt 2");
    await send("spec_generation", "spec prompt 1");
    await send("spec_generation", "spec prompt 2");
    await send(undefined, "debate prompt 1");
    await send(undefined, "debate prompt 2");

    expect(process.calls).toHaveLength(7);
    expect(process.calls[0]).toMatchObject({
      sessionId: "sess_1",
      phase: "analysis",
      prompt: "analysis prompt",
      resumeSessionId: undefined
    });
    expect(process.calls[1]).toMatchObject({
      sessionId: "sess_1",
      phase: "interview",
      prompt: "interview prompt 1",
      resumeSessionId: undefined
    });
    expect(process.calls[2]).toMatchObject({
      sessionId: "sess_1",
      phase: "interview",
      prompt: "interview prompt 2",
      resumeSessionId: undefined
    });
    expect(process.calls[3]).toMatchObject({
      sessionId: "sess_1",
      phase: "spec_generation",
      prompt: "spec prompt 1",
      resumeSessionId: undefined
    });
    expect(process.calls[4]).toMatchObject({
      sessionId: "sess_1",
      phase: "spec_generation",
      prompt: "spec prompt 2",
      resumeSessionId: undefined
    });
    expect(process.calls[5].sessionId).toBe("sess_1");
    expect(process.calls[5].resumeSessionId).toBeUndefined();
    expect(process.calls[5].prompt).toContain("ORIGINAL PROBLEM STATEMENT:\ndebate prompt 1");
    expect(process.calls[6].sessionId).toBe("sess_1");
    expect(process.calls[6].resumeSessionId).toContain("debate prompt 1-session");
    expect(process.calls[6].prompt).toContain("conversation context above");
  });

  it("surfaces provider auth failures as errors instead of degraded turns", async () => {
    const process = {
      async *runTurn() {
        yield {
          type: "result",
          text: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_123"}'
        } as const;
      },
      async healthCheck() {
        return { ok: true, detail: "claude ready" };
      }
    };

    const adapter = new ClaudeAdapter(process);
    const eventTypes: string[] = [];
    let errorMessage = "";

    for await (const event of adapter.sendTurn({
      sessionId: "sess_1",
      prompt: "Find hidden risks"
    })) {
      eventTypes.push(event.type);
      if (event.type === "error") {
        errorMessage = event.message;
      }
    }

    expect(eventTypes).toContain("error");
    expect(eventTypes).not.toContain("structured_turn");
    expect(errorMessage).toContain("Failed to authenticate.");
  });
});
