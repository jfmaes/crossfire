// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const {
  getHealthMock,
  listSessionsMock,
  getSessionMock
} = vi.hoisted(() => ({
  getHealthMock: vi.fn(),
  listSessionsMock: vi.fn(),
  getSessionMock: vi.fn()
}));

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual("./lib/api") as object;
  return {
    ...actual,
    getHealth: getHealthMock,
    listSessions: listSessionsMock,
    getSession: getSessionMock
  };
});

describe("App", () => {
  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    getHealthMock.mockResolvedValue({
      providerMode: "local",
      providers: {
        gpt: { ok: true, detail: "ready" },
        claude: { ok: true, detail: "ready" }
      }
    });
    listSessionsMock.mockResolvedValue([]);
    getSessionMock.mockReset();
    location.hash = "";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    location.hash = "";
  });

  it("renders the landing page with session form", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Crossfire" })).toBeTruthy();
    expect(screen.getByLabelText("Problem statement")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start session" })).toBeTruthy();

    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalled();
    });
  });

  it("renders clarification-needed approach debate state from a session deeplink", async () => {
    location.hash = "#/session/sess_1";
    getSessionMock.mockResolvedValue({
      session: {
        id: "sess_1",
        title: "Build a deploy pipeline",
        status: "waiting_for_human",
        phase: "approach_debate",
        prompt: "Build a deploy pipeline"
      },
      summary: {
        currentUnderstanding: "The debate paused on deployment authority.",
        recommendation: "The models need clarification before they can converge.",
        changedSinceLastCheckpoint: ["Approach debate paused"],
        openRisks: [],
        decisionsNeeded: ["Which deployment environment is authoritative?"]
      },
      phaseResult: {
        convergedApproach: "Use staged deployments with manual promotion gates.",
        questionsForHuman: ["Which deployment environment is authoritative?"],
        trace: {
          stopReason: "questions_for_human",
          turnsUsed: 3,
          maxTurns: 6
        }
      },
      recentRuns: [],
      analysisResult: {
        gptAnalysis: "GPT analysis",
        claudeAnalysis: "Claude analysis",
        proposedQuestions: []
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("The models stopped because they need clarification from you before they can reach full agreement.")).toBeTruthy();
    });

    expect(screen.getAllByText("The debate paused for your input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("The approach debate is blocked on your input").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Which deployment environment is authoritative?").length).toBeGreaterThan(0);
  });
});
