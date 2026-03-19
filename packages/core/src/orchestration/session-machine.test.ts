import { describe, expect, it } from "vitest";
import type { ModelTurn } from "../contracts/session";
import { applyModelTurn, createSessionState } from "./session-machine";

function emptyTurn(actor: "gpt" | "claude"): ModelTurn {
  return {
    actor,
    rawText: "",
    summary: "",
    newInsights: [],
    assumptions: [],
    disagreements: [],
    questionsForPeer: [],
    questionsForHuman: [],
    proposedSpecDelta: "",
    milestoneReached: null,
    degraded: false
  };
}

describe("session machine", () => {
  it("creates an empty session state", () => {
    const state = createSessionState();
    expect(state.exchangeCount).toBe(0);
    expect(state.turns).toHaveLength(0);
  });

  it("increments exchange count and appends turns", () => {
    let state = createSessionState();

    state = applyModelTurn(state, emptyTurn("gpt"));
    expect(state.exchangeCount).toBe(1);
    expect(state.turns).toHaveLength(1);

    state = applyModelTurn(state, emptyTurn("claude"));
    expect(state.exchangeCount).toBe(2);
    expect(state.turns).toHaveLength(2);
  });

  it("preserves turn data through applications", () => {
    const turn: ModelTurn = {
      ...emptyTurn("gpt"),
      disagreements: ["This will not scale"],
      questionsForHuman: ["Which repo?"]
    };

    const state = applyModelTurn(createSessionState(), turn);
    expect(state.turns[0].disagreements).toEqual(["This will not scale"]);
    expect(state.turns[0].questionsForHuman).toEqual(["Which repo?"]);
  });
});
