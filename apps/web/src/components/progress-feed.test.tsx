// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
    cleanup();
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

  it("renders the latest concrete milestone as the active headline when persisted events exist", async () => {
    getRunEventsMock.mockResolvedValue([
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "phase_start",
        phase: "analysis",
        message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
        createdAt: new Date().toISOString()
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
        createdAt: new Date().toISOString()
      }
    ]);

    render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

    await waitFor(() => {
      expect(
        screen.getByText("Claude finished analysis in 2m 56s", {
          selector: ".progress-feed__milestone-title"
        })
      ).toBeTruthy();
    });
  });

  it("shows a capped rolling list of recent milestones newest first", async () => {
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
        type: "phase_start",
        phase: "approach_debate",
        message: "Phase 2: Approach Debate",
        createdAt: new Date("2026-04-27T17:32:00.000Z").toISOString()
      },
      {
        id: "evt_4",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_start",
        model: "gpt",
        phase: "approach_debate",
        message: "Starting debate turn",
        createdAt: new Date("2026-04-27T17:32:10.000Z").toISOString()
      },
      {
        id: "evt_5",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_done",
        model: "gpt",
        turnNumber: 1,
        elapsedMs: 42000,
        message: "Done in 42.0s",
        createdAt: new Date("2026-04-27T17:32:52.000Z").toISOString()
      },
      {
        id: "evt_6",
        runId: "run_1",
        sessionId: "sess_1",
        type: "consensus",
        message: "Consensus reached on the implementation approach",
        createdAt: new Date("2026-04-27T17:33:10.000Z").toISOString()
      }
    ]);

    render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

    await waitFor(() => {
      expect(
        screen.getByText("Recent milestones", {
          selector: ".progress-feed__milestones-heading"
        })
      ).toBeTruthy();
    });

    expect(screen.queryByText("starting")).toBeNull();
    expect(
      screen.getByText("Consensus reached on the implementation approach", {
        selector: ".progress-feed__milestone-title"
      })
    ).toBeTruthy();

    const milestoneRows = document.querySelectorAll(".progress-feed__milestone-row");
    expect(milestoneRows).toHaveLength(5);

    const milestoneTexts = [...milestoneRows].map((row) => {
      const text = within(row as HTMLElement).getByText(/.+/, {
        selector: ".progress-feed__milestone-text"
      });
      return text.textContent;
    });

    expect(milestoneTexts).toEqual([
      "Consensus reached on the implementation approach",
      "GPT finished debate turn 1 in 42s",
      "GPT started approach debate",
      "Phase 2: Approach Debate",
      "Claude finished analysis in 2m 56s"
    ]);
    expect(screen.queryByText("Phase 1: Dual Analysis (GPT + Claude in parallel)", {
      selector: ".progress-feed__milestone-text"
    })).toBeNull();
  });
});
