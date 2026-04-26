// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgressFeed } from "./progress-feed";

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

describe("ProgressFeed", () => {
  beforeEach(() => {
    getRunEventsMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("can transition from hidden to visible without violating hook order", () => {
    const { rerender } = render(
      <ProgressFeed sessionId={null} runId={null} />
    );

    rerender(
      <ProgressFeed
        sessionId="sess_1"
        runId={null}
        pendingState={{
          title: "Starting session",
          detail: "Waiting for fresh progress from the daemon…",
          startedAt: Date.now()
        }}
      />
    );

    expect(screen.getByText("Live progress")).toBeTruthy();
    expect(screen.getByText("starting")).toBeTruthy();
    expect(screen.getAllByText("Waiting for fresh progress from the daemon…").length).toBeGreaterThan(0);
  });

  it("renders fresh-context and oversize-blocking badges from persisted metadata", async () => {
    getRunEventsMock.mockResolvedValue([
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "info",
        phase: "spec_generation",
        message: "Spec generation blocked - authority input too large",
        metadata: {
          blockedReason: "spec_generation_input_too_large",
          conversationReused: false,
          canonicalApproachHandoff: true,
          authorityPathUncompacted: true,
          blockedByOversize: true
        },
        createdAt: new Date().toISOString()
      }
    ]);

    render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

    await waitFor(() => {
      expect(screen.getByText("blocked: spec input too large")).toBeTruthy();
    });

    expect(screen.getByText("fresh context")).toBeTruthy();
    expect(screen.getByText("canonical handoff")).toBeTruthy();
    expect(screen.getByText("authority path uncompressed")).toBeTruthy();
  });

  it("labels feedback digest and oversized feedback events", async () => {
    getRunEventsMock.mockResolvedValue([
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_start",
        model: "gpt",
        phase: "feedback_digest",
        message: "Extracting requested changes from large feedback",
        metadata: null,
        createdAt: new Date().toISOString()
      },
      {
        id: "evt_2",
        runId: "run_1",
        sessionId: "sess_1",
        type: "info",
        phase: "spec_generation",
        message: "feedback input too large",
        metadata: { blockedReason: "feedback_input_too_large" },
        createdAt: new Date().toISOString()
      }
    ]);

    render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

    await waitFor(() => {
      expect(screen.getByText("Extracting feedback changes")).toBeTruthy();
    });

    expect(screen.getByText("Extracting requested changes from large feedback")).toBeTruthy();
    expect(screen.getByText("blocked: feedback too large")).toBeTruthy();
  });
});
