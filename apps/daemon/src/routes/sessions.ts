import type { FastifyInstance } from "fastify";
import { SessionConflictError } from "../services/session-service";

interface SessionService {
  createSession(input: { title: string; prompt: string }): Promise<Record<string, unknown>>;
  continueSession(input: { id: string; humanResponse: string }): Promise<Record<string, unknown> | null>;
  restartSession(id: string): Promise<Record<string, unknown> | null>;
  deleteSession(id: string): void;
  listSessions(): Array<{ id: string; title: string; status: string; phase?: string | null }>;
  getSession(id: string): Promise<Record<string, unknown> | null>;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  input: { sessionService?: SessionService } = {}
) {
  app.post("/sessions", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const body = request.body as Record<string, unknown> | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

    if (!title || !prompt) {
      return reply.code(400).send({ error: "title and prompt are required" });
    }

    try {
      const created = await input.sessionService.createSession({ title, prompt });
      return reply.code(201).send(created);
    } catch (error) {
      request.log.error(error, "session creation failed");
      return reply.code(500).send({ error: "session creation failed" });
    }
  });

  app.post("/sessions/:id/continue", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    const humanResponse = typeof body?.humanResponse === "string" ? body.humanResponse.trim() : "";

    if (!humanResponse) {
      return reply.code(400).send({ error: "humanResponse is required" });
    }

    try {
      const result = await input.sessionService.continueSession({
        id: params.id,
        humanResponse
      });

      if (!result) {
        return reply.code(404).send({ error: "not found" });
      }

      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof SessionConflictError) {
        return reply.code(409).send({ error: "session is already processing" });
      }
      request.log.error(error, "session continuation failed");
      return reply.code(500).send({ error: "session continuation failed" });
    }
  });

  app.get("/sessions", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    return reply.code(200).send(input.sessionService.listSessions());
  });

  app.post("/sessions/:id/restart", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };

    try {
      const result = await input.sessionService.restartSession(params.id);

      if (!result) {
        return reply.code(404).send({ error: "not found" });
      }

      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof SessionConflictError) {
        return reply.code(409).send({ error: "session is already processing" });
      }
      request.log.error(error, "session restart failed");
      return reply.code(500).send({ error: "session restart failed" });
    }
  });

  app.delete("/sessions/:id", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    try {
      input.sessionService.deleteSession(params.id);
      return reply.code(204).send();
    } catch (error) {
      request.log.error(error, "session delete failed");
      return reply.code(500).send({ error: "session delete failed" });
    }
  });

  app.get("/sessions/:id", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    const found = await input.sessionService.getSession(params.id);

    if (!found) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.code(200).send(found);
  });
}
