import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("buildServer", () => {
  it("rejects requests without the local access token", async () => {
    const app = buildServer({ accessToken: "secret-token" });
    const response = await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { title: "New session" }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects health requests without the local access token", async () => {
    const app = buildServer({ accessToken: "secret-token" });
    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
