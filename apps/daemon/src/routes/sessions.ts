import type { FastifyInstance } from "fastify";
import { SessionConflictError } from "../services/session-service";

interface SessionService {
  createSession(input: { title: string; prompt: string }): Promise<Record<string, unknown>>;
  continueSession(input: { id: string; humanResponse: string }): Promise<Record<string, unknown> | null>;
  restartSession(id: string): Promise<Record<string, unknown> | null>;
  deleteSession(id: string): void;
  listSessions(): Array<{ id: string; title: string; status: string; phase?: string | null }>;
  getSession(id: string): Promise<Record<string, unknown> | null>;
  exportSession(id: string): Record<string, unknown> | null;
  getRun(id: string): Record<string, unknown> | null;
  listRunEvents(runId: string): Array<Record<string, unknown>>;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  input: { sessionService?: SessionService } = {}
) {
  function responseCode(payload: Record<string, unknown> | null, pendingCode: number, readyCode: number) {
    return payload && "activeRun" in payload && payload.activeRun ? pendingCode : readyCode;
  }

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
      return reply.code(responseCode(created, 202, 201)).send(created);
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

      return reply.code(responseCode(result, 202, 200)).send(result);
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

      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof SessionConflictError) {
        return reply.code(202).send({ error: "session is already processing" });
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

  app.get("/sessions/:id/export", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    const data = input.sessionService.exportSession(params.id);

    if (!data) {
      return reply.code(404).send({ error: "not found" });
    }

    const fileName = `crossfire-session-${params.id.slice(0, 8)}.json`;
    return reply
      .code(200)
      .header("content-type", "application/json")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .send(data);
  });

  app.get("/runs/:id", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    const run = input.sessionService.getRun(params.id);

    if (!run) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.code(200).send(run);
  });

  app.get("/runs/:id/events", async (request, reply) => {
    if (!input.sessionService) {
      return reply.code(503).send({ error: "session service unavailable" });
    }

    const params = request.params as { id: string };
    const run = input.sessionService.getRun(params.id);

    if (!run) {
      return reply.code(404).send({ error: "not found" });
    }

    return reply.code(200).send(input.sessionService.listRunEvents(params.id));
  });
}
