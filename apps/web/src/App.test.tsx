// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the landing page with session form", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Crossfire" })).toBeTruthy();
    expect(screen.getByLabelText("Problem statement")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start session" })).toBeTruthy();
  });

  it("renders without crashing on a run-deeplink hash", () => {
    location.hash = "#/session/sess_1/run/run_1";
    const { unmount } = render(<App />);
    expect(screen.getAllByRole("heading", { name: "Crossfire" }).length).toBeGreaterThan(0);
    unmount();
    location.hash = "";
  });
});
