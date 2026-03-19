import type { ModelTurn } from "@council/core";

export interface ProviderTurnInput {
  sessionId: string;
  prompt: string;
  originalProblem?: string;
  peerResponse?: string;
  turnNumber?: number;
  totalTurns?: number;
  phase?: string;
}

export type NormalizedProviderEvent =
  | { type: "status"; value: "started" | "streaming" }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "structured_turn"; actor: "gpt" | "claude"; turn: ModelTurn }
  | { type: "done" };

export interface ProviderAdapter {
  name: "gpt" | "claude";
  sendTurn(input: ProviderTurnInput): AsyncGenerator<NormalizedProviderEvent>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
