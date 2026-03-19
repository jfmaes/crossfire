import type { ModelTurn } from "../contracts/session";
import type { SessionState } from "./checkpoint-policy";

export type { SessionState };

export function createSessionState(): SessionState {
  return {
    exchangeCount: 0,
    turns: []
  };
}

export function applyModelTurn(state: SessionState, turn: ModelTurn): SessionState {
  return {
    exchangeCount: state.exchangeCount + 1,
    turns: [...state.turns, turn]
  };
}
