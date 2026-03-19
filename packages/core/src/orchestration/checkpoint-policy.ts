import type { ModelTurn } from "../contracts/session";

export interface SessionState {
  exchangeCount: number;
  turns: ModelTurn[];
}
