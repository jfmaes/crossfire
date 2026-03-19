export interface ClaudeProcess {
  runTurn(input: {
    sessionId: string;
    prompt: string;
    degraded?: boolean;
  }): AsyncGenerator<
    | { type: "result"; text: string }
    | { type: "stderr"; text: string }
    | { type: "error"; message: string }
  >;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
