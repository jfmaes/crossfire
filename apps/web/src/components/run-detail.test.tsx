// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./run-detail";

const { getRunEventsMock } = vi.hoisted(() => ({
  getRunEventsMock: vi.fn()
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual("../lib/api") as object;
  return {
    ...actual,
    getRunEvents: getRunEventsMock
  };
});

describe("RunDetail", () => {
  beforeEach(() => {
    getRunEventsMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders recent milestones above the raw event log", async () => {
    getRunEventsMock.mockResolvedValue([
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "phase_start",
        phase: "analysis",
        message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
        createdAt: new Date("2026-04-27T17:28:34.760Z").toISOString()
      },
      {
        id: "evt_2",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_done",
        model: "claude",
        phase: "analysis",
        elapsedMs: 176497,
        message: "Done in 176.5s — 10989 chars",
        createdAt: new Date("2026-04-27T17:31:31.260Z").toISOString()
      },
      {
        id: "evt_3",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_stream",
        model: "gpt",
        phase: "analysis",
        message: "Reading additional input from stdin...",
        createdAt: new Date("2026-04-27T17:31:45.000Z").toISOString()
      }
    ]);

    render(
      <RunDetail
        run={{
          id: "run_1",
          sessionId: "sess_1",
          kind: "analysis",
          status: "completed",
          phase: "analysis",
          startedAt: new Date("2026-04-27T17:28:00.000Z").toISOString(),
          finishedAt: new Date("2026-04-27T17:32:00.000Z").toISOString()
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Recent milestones")).toBeTruthy();
    });

    expect(screen.getByText("Claude finished analysis in 2m 56s")).toBeTruthy();
    expect(screen.getByText("Done in 176.5s — 10989 chars")).toBeTruthy();
    expect(screen.getByText("Reading additional input from stdin...")).toBeTruthy();

    const heading = screen.getByText("Recent milestones");
    const firstEvent = document.querySelector(".run-detail__event");

    expect(firstEvent).toBeTruthy();
    expect(
      heading.compareDocumentPosition(firstEvent as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
