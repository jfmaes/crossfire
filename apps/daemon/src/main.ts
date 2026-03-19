import { ClaudeAdapter, ClaudeCliProcess, CodexAdapter, CodexCliTransport, FakeProvider } from "@council/adapters";
import { createDatabase, createInMemoryDatabase, SessionRepository } from "@council/storage";
import { createSessionService } from "./services/session-service";
import { buildServer } from "./server";
import { enableDebugLogging } from "./services/debug-log";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
import { randomUUID } from "node:crypto";
const accessToken = process.env.COUNCIL_ACCESS_TOKEN || randomUUID();
const providerMode = process.env.COUNCIL_PROVIDER_MODE ?? "real";
const databasePath = process.env.COUNCIL_DATABASE_PATH ?? "data/council.sqlite";
const groundingRoot = process.env.COUNCIL_GROUNDING_ROOT;
const debugDir = process.env.CROSSFIRE_DEBUG_DIR ?? "data/debug";
const codexFastMode = process.env.CODEX_FAST_MODE !== "0" && process.env.CODEX_FAST_MODE !== "false";

// Only enable detailed prompt/response logging when explicitly requested.
// Logs may contain grounded source code and should not be written by default.
if (process.env.CROSSFIRE_DEBUG === "1" || process.env.CROSSFIRE_DEBUG === "true") {
  enableDebugLogging(debugDir);
}

const repository = new SessionRepository(
  providerMode === "fake" ? createInMemoryDatabase() : createDatabase(databasePath)
);
const gpt =
  providerMode === "fake"
    ? new FakeProvider("gpt")
    : new CodexAdapter(new CodexCliTransport({ fastMode: codexFastMode }));
const claude =
  providerMode === "fake"
    ? new FakeProvider("claude")
    : new ClaudeAdapter(new ClaudeCliProcess());
const sessionService = createSessionService({
  repository,
  gpt,
  claude,
  artifactsDirectory: "data/artifacts",
  grounding: groundingRoot
    ? {
        rootDir: groundingRoot,
        maxFiles: 5,
        includeExtensions: [".md", ".ts", ".tsx", ".js", ".json"]
      }
    : undefined
});

// Recover any sessions left in "debating" status from a previous unclean shutdown.
// These sessions had in-flight LLM processes that were killed when the daemon stopped;
// marking them "errored" lets the user retry from the UI.
const recovered = repository.recoverStaleDebatingSessions();
if (recovered > 0) {
  console.log(`Recovered ${recovered} orphaned session(s) from previous shutdown`);
}

const app = buildServer({
  accessToken,
  providerMode,
  artifactsDirectory: "data/artifacts",
  providers: { gpt, claude },
  sessionService
});

const address = await app.listen({ port, host });

console.log(`Crossfire daemon listening on ${address} (${providerMode} providers${codexFastMode ? ", codex fast mode" : ""})`);
if (!process.env.COUNCIL_ACCESS_TOKEN) {
  console.log(`  Generated access token: ${accessToken}`);
  console.log(`  Set COUNCIL_ACCESS_TOKEN in your environment to use a fixed token.`);
}
