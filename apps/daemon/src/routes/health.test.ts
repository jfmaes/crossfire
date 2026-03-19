import { describe, expect, it } from "vitest";
import { buildServer } from "../server";

describe("health routes", () => {
  it("returns live provider status", async () => {
    const app = buildServer({
      accessToken: "secret-token",
      providerMode: "fake",
      providers: {
        gpt: { async healthCheck() { return { ok: true, detail: "fake gpt ready" }; } },
        claude: { async healthCheck() { return { ok: true, detail: "fake claude ready" }; } }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerMode: "fake",
      providers: {
        gpt: { ok: true, detail: "fake gpt ready" },
        claude: { ok: true, detail: "fake claude ready" }
      }
    });
    await app.close();
  });

  it("returns unconfigured when no providers given", async () => {
    const app = buildServer({ accessToken: "secret-token" });

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers.gpt.ok).toBe(false);
    await app.close();
  });
});
