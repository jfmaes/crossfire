import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("buildServer", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

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

  it("rejects artifact session IDs that would escape the artifacts directory", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-artifacts-"));
    const artifactsDirectory = path.join(tempDir, "artifacts");
    await mkdir(artifactsDirectory);
    await writeFile(path.join(tempDir, "secret-spec.md"), "do not serve", "utf8");

    const app = buildServer({
      accessToken: "secret-token",
      artifactsDirectory
    });

    const response = await app.inject({
      method: "GET",
      url: "/artifacts/..%2Fsecret/spec",
      headers: { "x-council-token": "secret-token" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("do not serve");
    await app.close();
  });
});
