export interface ClaudeProcess {
  runTurn(input: {
    sessionId: string;
    prompt: string;
    degraded?: boolean;
    resumeSessionId?: string;
  }): AsyncGenerator<
    | { type: "result"; text: string; cliSessionId?: string }
    | { type: "stderr"; text: string }
    | { type: "error"; message: string }
  >;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
