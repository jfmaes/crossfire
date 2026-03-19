import fp from "fastify-plugin";

export const accessTokenPlugin = fp(async (app, input: { accessToken: string }) => {
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers["x-council-token"] !== input.accessToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
});
