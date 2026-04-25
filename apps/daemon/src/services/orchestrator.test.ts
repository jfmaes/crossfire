import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { FakeProvider } from "@council/adapters";
import { createOrchestrator } from "./orchestrator";

function makeTurn(overrides: Partial<ModelTurn> & { actor: "gpt" | "claude" }): ModelTurn {
  return {
    rawText: `${overrides.actor} response`,
    summary: `${overrides.actor} summary`,
    newInsights: [],
    assumptions: [],
    disagreements: [],
    questionsForPeer: [],
    questionsForHuman: [],
    proposedSpecDelta: "",
    milestoneReached: null,
    implementationPlan: null,
    proposedQuestions: null,
    synthesizedQuestions: null,
    followUpQuestions: null,
    sufficientContext: null,
    walkthroughGaps: null,
    degraded: false,
    ...overrides
  };
}

function singleTurnProvider(turn: ModelTurn): ProviderAdapter {
  return {
    name: turn.actor,
    async *sendTurn(_input: ProviderTurnInput) {
      yield { type: "structured_turn", actor: turn.actor, turn, rawResponse: JSON.stringify(turn) } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

function invalidStructuredTurnProvider(
  actor: "gpt" | "claude",
  rawTurn: Record<string, unknown>
): ProviderAdapter {
  return {
    name: actor,
    async *sendTurn(_input: ProviderTurnInput) {
      yield {
        type: "structured_turn",
        actor,
        turn: rawTurn as ModelTurn,
        rawResponse: JSON.stringify(rawTurn)
      } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

describe("orchestrator", () => {
  it("reaches consensus when both models have no disagreements", async () => {
    const orchestrator = createOrchestrator({
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Spec a local collaboration tool"
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.stopReason).toBe("consensus");
    expect(result.state.turns).toHaveLength(4);
  });

  it("preserves consensus when it happens on the final allowed turn", async () => {
    const orchestrator = createOrchestrator({
      gpt: new FakeProvider("gpt"),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Spec a local collaboration tool",
      maxTurns: 4
    });

    expect(result.stopReason).toBe("consensus");
    expect(result.state.turns).toHaveLength(4);
  });

  it("stops early when a provider asks a human question", async () => {
    const orchestrator = createOrchestrator({
      gpt: singleTurnProvider(makeTurn({
        actor: "gpt",
        questionsForHuman: ["Should we support repo grounding in v1?"]
      })),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Spec a local collaboration tool"
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.stopReason).toBe("questions_for_human");
    expect(result.state.turns).toHaveLength(1);
  });

  it("does not stop early when only the latest turn is clean", async () => {
    const orchestrator = createOrchestrator({
      gpt: singleTurnProvider(makeTurn({
        actor: "gpt",
        disagreements: ["The proposed caching layer adds unacceptable complexity"]
      })),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Design a caching layer",
      maxTurns: 4
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.stopReason).toBe("max_turns");
    expect(result.state.turns).toHaveLength(4);
    expect(result.state.turns.at(-1)?.disagreements).toEqual([]);
    expect(result.state.turns.at(-2)?.disagreements).toHaveLength(1);
  });

  it("hits safety cap when both models keep disagreeing", async () => {
    const orchestrator = createOrchestrator({
      gpt: singleTurnProvider(makeTurn({
        actor: "gpt",
        disagreements: ["GPT concern"]
      })),
      claude: singleTurnProvider(makeTurn({
        actor: "claude",
        disagreements: ["Claude concern"]
      }))
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Irreconcilable differences",
      maxTurns: 6
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.stopReason).toBe("max_turns");
    expect(result.state.turns).toHaveLength(6);
  });

  it("throws when an approach debate turn omits milestoneReached", async () => {
    const orchestrator = createOrchestrator({
      gpt: invalidStructuredTurnProvider("gpt", {
        actor: "gpt",
        rawText: "I agree with the current direction.",
        summary: "Agreement",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Ship the simpler architecture."
      }),
      claude: new FakeProvider("claude")
    });

    await expect(orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Clarify requirements"
    })).rejects.toThrow("GPT approach_debate failed on turn 1: missing required fields: milestoneReached");
  });

  it("passes original problem and peer context through turns", async () => {
    const capturedInputs: ProviderTurnInput[] = [];

    const capturingProvider: ProviderAdapter = {
      name: "gpt",
      async *sendTurn(input: ProviderTurnInput) {
        capturedInputs.push({ ...input });
        yield {
          type: "structured_turn",
          actor: "gpt",
          turn: makeTurn({ actor: "gpt", rawText: "gpt analysis" }),
          rawResponse: JSON.stringify(makeTurn({ actor: "gpt", rawText: "gpt analysis" }))
        } as const;
        yield { type: "done" } as const;
      },
      async healthCheck() {
        return { ok: true, detail: "ready" };
      }
    };

    const orchestrator = createOrchestrator({
      gpt: capturingProvider,
      claude: new FakeProvider("claude")
    });

    await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Original problem statement"
    });

    // GPT is called on turns 1, 3, etc. — at least once
    expect(capturedInputs.length).toBeGreaterThanOrEqual(1);
    expect(capturedInputs[0].originalProblem).toBe("Original problem statement");
    expect(capturedInputs[0].turnNumber).toBe(1);
    expect(capturedInputs[0].peerResponse).toBeUndefined();
  });

  it("throws when a provider emits an error instead of a structured turn", async () => {
    const failingProvider: ProviderAdapter = {
      name: "gpt",
      async *sendTurn(_input: ProviderTurnInput) {
        yield { type: "stderr", text: "worker quit with fatal" } as const;
        yield { type: "error", message: "Transport channel closed" } as const;
        yield { type: "done" } as const;
      },
      async healthCheck() {
        return { ok: true, detail: "ready" };
      }
    };

    const orchestrator = createOrchestrator({
      gpt: failingProvider,
      claude: new FakeProvider("claude")
    });

    await expect(orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Spec a local collaboration tool"
    })).rejects.toThrow("GPT approach_debate failed on turn 1: Transport channel closed");
  });
});
