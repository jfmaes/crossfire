export interface CodexTransport {
  runTurn(input: {
    sessionId: string;
    prompt: string;
  }): AsyncGenerator<
    | { kind: "stderr"; text: string }
    | { kind: "error"; message: string }
    | { kind: "result"; text: string }
  >;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
