import fp from "fastify-plugin";

export const accessTokenPlugin = fp(async (app, input: { accessToken: string }) => {
  app.addHook("onRequest", async (request, reply) => {
    // Check header first (fetch/XHR), then query param (EventSource, <a> downloads).
    const headerToken = request.headers["x-council-token"];
    const queryToken = (request.query as Record<string, string>)?.token;

    if (headerToken !== input.accessToken && queryToken !== input.accessToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
});
