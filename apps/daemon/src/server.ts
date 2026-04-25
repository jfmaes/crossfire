import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { accessTokenPlugin } from "./plugins/access-token";
import { registerSessionRoutes } from "./routes/sessions";
import { onProgress } from "./services/progress";

interface HealthCheckProvider {
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

interface SessionService {
  createSession(input: {
    title: string;
    prompt: string;
    executionPolicy?: { approachDebateMaxTurns?: number };
  }): Promise<Record<string, unknown>>;
  continueSession(input: { id: string; humanResponse: string }): Promise<Record<string, unknown> | null>;
  restartSession(id: string): Promise<Record<string, unknown> | null>;
  rewindSession(id: string): Promise<Record<string, unknown> | null>;
  deleteSession(id: string): void;
  listSessions(): Array<{ id: string; title: string; status: string; phase?: string | null }>;
  getSession(id: string): Promise<Record<string, unknown> | null>;
  exportSession?(id: string): Record<string, unknown> | null;
  getRun(id: string): unknown | null;
  listRunEvents(runId: string): Array<unknown>;
}

const SAFE_ARTIFACT_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function resolveArtifactPath(input: {
  artifactsDirectory: string;
  sessionId: string;
  type: string;
}) {
  if (!SAFE_ARTIFACT_SESSION_ID.test(input.sessionId)) {
    return null;
  }

  const fileName = `${input.sessionId}-${input.type}.md`;
  const artifactsRoot = path.resolve(input.artifactsDirectory);
  const filePath = path.resolve(artifactsRoot, fileName);

  if (filePath !== artifactsRoot && !filePath.startsWith(`${artifactsRoot}${path.sep}`)) {
    return null;
  }

  return { fileName, filePath };
}

export function buildServer(input: {
  accessToken: string;
  providerMode?: string;
  artifactsDirectory?: string;
  providers?: {
    gpt: HealthCheckProvider;
    claude: HealthCheckProvider;
  };
  sessionService?: SessionService;
}) {
  const app = Fastify();

  app.register(accessTokenPlugin, { accessToken: input.accessToken });

  app.get("/health", async (_request, reply) => {
    if (!input.providers) {
      return reply.code(200).send({
        providerMode: input.providerMode ?? "unknown",
        providers: {
          gpt: { ok: false, detail: "unconfigured" },
          claude: { ok: false, detail: "unconfigured" }
        }
      });
    }

    const [gpt, claude] = await Promise.all([
      input.providers.gpt.healthCheck(),
      input.providers.claude.healthCheck()
    ]);

    return reply.code(200).send({
      providerMode: input.providerMode ?? "unknown",
      providers: { gpt, claude }
    });
  });

  app.register(registerSessionRoutes, { sessionService: input.sessionService });

  app.get("/artifacts/:sessionId/:type", async (request, reply) => {
    const params = request.params as { sessionId: string; type: string };
    const validTypes = ["spec", "plan"];
    if (!validTypes.includes(params.type)) {
      return reply.code(400).send({ error: "type must be spec or plan" });
    }

    if (!input.artifactsDirectory) {
      return reply.code(404).send({ error: "no artifacts directory configured" });
    }

    const artifact = resolveArtifactPath({
      artifactsDirectory: input.artifactsDirectory,
      sessionId: params.sessionId,
      type: params.type
    });
    if (!artifact) {
      return reply.code(400).send({ error: "invalid session id" });
    }

    try {
      const content = await readFile(artifact.filePath, "utf8");
      reply.header("content-type", "text/markdown; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${artifact.fileName}"`);
      return reply.send(content);
    } catch (error) {
      request.log.error(error, "artifact read failed");
      return reply.code(404).send({ error: "artifact not found" });
    }
  });

  app.get("/progress", async (request, reply) => {
    const query = request.query as { sessionId?: string; runId?: string; token?: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive"
    });

    reply.raw.write(":\n\n"); // SSE comment to keep connection alive

    const unsubscribe = onProgress((event) => {
      if (query.runId && event.runId !== query.runId) {
        return;
      }
      if (query.sessionId && event.sessionId !== query.sessionId) {
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    request.raw.on("close", () => {
      unsubscribe();
    });
  });

  return app;
}
