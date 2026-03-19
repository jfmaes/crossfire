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
    degraded: false,
    ...overrides
  };
}

function singleTurnProvider(turn: ModelTurn): ProviderAdapter {
  return {
    name: turn.actor,
    async *sendTurn(_input: ProviderTurnInput) {
      yield { type: "structured_turn", actor: turn.actor, turn } as const;
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
    // Both models have 0 disagreements → consensus after 4 turns (minimum 2 full exchanges)
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
    expect(result.state.turns).toHaveLength(1);
  });

  it("keeps debating while one model has disagreements", async () => {
    // GPT always disagrees, Claude never does.
    // The debate continues because the last two turns aren't both clean.
    // After turn 4 (Claude), i>=3 and Claude's disagreementCount===0 triggers early exit.
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
      maxTurns: 14
    });

    expect(result.shouldCheckpoint).toBe(true);
    // Runs past 2 turns because GPT keeps disagreeing
    expect(result.state.turns.length).toBeGreaterThan(2);
    expect(result.state.turns[0].disagreements).toHaveLength(1);
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
    expect(result.state.turns).toHaveLength(6);
  });

  it("stops on milestone reached", async () => {
    const orchestrator = createOrchestrator({
      gpt: singleTurnProvider(makeTurn({
        actor: "gpt",
        milestoneReached: "requirements_clarified"
      })),
      claude: new FakeProvider("claude")
    });

    const result = await orchestrator.runRound({
      sessionId: "sess_1",
      prompt: "Clarify requirements"
    });

    expect(result.shouldCheckpoint).toBe(true);
    // Milestone requires at least 2 turns before it can trigger consensus
    // GPT turn 1 (milestone), Claude turn 2 (clean), GPT turn 3 (milestone) → consensus at 3
    expect(result.state.turns.length).toBeGreaterThanOrEqual(2);
    expect(result.state.turns[0].milestoneReached).toBe("requirements_clarified");
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
          turn: makeTurn({ actor: "gpt", rawText: "gpt analysis" })
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
});
