// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RuntimeStatusCard } from "./runtime-status-card";

describe("RuntimeStatusCard", () => {
  it("renders provider mode and provider status details", () => {
    render(
      <RuntimeStatusCard
        status={{
          providerMode: "fake",
          providers: {
            gpt: { ok: true, detail: "fake gpt ready" },
            claude: { ok: true, detail: "fake claude ready" }
          }
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "Runtime status" })).toBeTruthy();
    expect(screen.getByText("fake gpt ready")).toBeTruthy();
    expect(screen.getByText("fake claude ready")).toBeTruthy();
    expect(screen.getByText("fake")).toBeTruthy();
  });
});
