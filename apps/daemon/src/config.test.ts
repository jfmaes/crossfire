import { describe, expect, it } from "vitest";
import { resolveAccessToken } from "./config";

describe("daemon config", () => {
  it("uses an explicit access token unchanged", () => {
    expect(resolveAccessToken({ COUNCIL_ACCESS_TOKEN: "fixed-token" })).toEqual({
      accessToken: "fixed-token",
      generated: false
    });
  });

  it("generates a random access token when none is configured", () => {
    const first = resolveAccessToken({});
    const second = resolveAccessToken({});

    expect(first.generated).toBe(true);
    expect(second.generated).toBe(true);
    expect(first.accessToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.accessToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.accessToken).not.toBe(second.accessToken);
  });
});
