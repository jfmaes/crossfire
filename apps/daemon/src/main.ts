import { ClaudeAdapter, ClaudeCliProcess, CodexAdapter, CodexCliTransport, FakeProvider } from "@council/adapters";
import { createDatabase, createInMemoryDatabase, SessionRepository } from "@council/storage";
import { createSessionService } from "./services/session-service";
import { buildServer } from "./server";
import { enableDebugLogging } from "./services/debug-log";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const accessToken = process.env.COUNCIL_ACCESS_TOKEN ?? "local-dev-token";
const providerMode = process.env.COUNCIL_PROVIDER_MODE ?? "real";
const databasePath = process.env.COUNCIL_DATABASE_PATH ?? "data/council.sqlite";
const groundingRoot = process.env.COUNCIL_GROUNDING_ROOT;
const debugMode = process.env.CROSSFIRE_DEBUG === "1" || process.env.CROSSFIRE_DEBUG === "true";

if (debugMode) {
  enableDebugLogging();
}

const repository = new SessionRepository(
  providerMode === "fake" ? createInMemoryDatabase() : createDatabase(databasePath)
);
const gpt =
  providerMode === "fake"
    ? new FakeProvider("gpt")
    : new CodexAdapter(new CodexCliTransport());
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

const app = buildServer({
  accessToken,
  providerMode,
  artifactsDirectory: "data/artifacts",
  providers: { gpt, claude },
  sessionService
});

const address = await app.listen({ port, host });

console.log(`Crossfire daemon listening on ${address} (${providerMode} providers)`);
