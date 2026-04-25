export interface CodexTransport {
  runTurn(input: {
    sessionId: string;
    prompt: string;
    resumeThreadId?: string;
  }): AsyncGenerator<
    | { kind: "progress"; text: string }
    | { kind: "stderr"; text: string }
    | { kind: "error"; message: string }
    | { kind: "result"; text: string }
    | { kind: "thread_started"; threadId: string }
  >;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
