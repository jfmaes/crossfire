// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const {
  getHealthMock,
  listSessionsMock,
  getSessionMock,
  createSessionMock
} = vi.hoisted(() => ({
  getHealthMock: vi.fn(),
  listSessionsMock: vi.fn(),
  getSessionMock: vi.fn(),
  createSessionMock: vi.fn()
}));

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual("./lib/api") as object;
  return {
    ...actual,
    getHealth: getHealthMock,
    listSessions: listSessionsMock,
    getSession: getSessionMock,
    createSession: createSessionMock
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
    createSessionMock.mockReset();
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
    const scrollTargets: HTMLElement[] = [];
    const scrollOptions: unknown[] = [];
    window.HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement, options?: unknown) {
      scrollTargets.push(this);
      scrollOptions.push(options);
    });
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
    expect(screen.getByPlaceholderText("Provide the clarification the models asked for...")).toBeTruthy();

    await waitFor(() => {
      expect(scrollTargets.at(-1)?.classList.contains("challenge-feedback-submit")).toBe(true);
      expect(scrollOptions.at(-1)).toEqual({ behavior: "auto", block: "center" });
    });
  });

  it("switches to existing spec review and creates an existing-spec session", async () => {
    createSessionMock.mockResolvedValue({
      session: {
        id: "sess_existing",
        title: "uploaded-spec.md",
        status: "debating",
        phase: "analysis",
        prompt: "HUMAN REVIEW CONTEXT:\nNo additional context supplied.",
        executionPolicy: { mode: "existing_spec" }
      },
      summary: {
        currentUnderstanding: "Existing spec review session created. Phase 1 is starting.",
        recommendation: "Watch live progress while Crossfire reviews the supplied documents.",
        changedSinceLastCheckpoint: ["Session created"],
        openRisks: [],
        decisionsNeeded: []
      },
      activeRun: {
        id: "run_existing",
        sessionId: "sess_existing",
        kind: "create",
        status: "running",
        phase: "analysis",
        startedAt: new Date().toISOString()
      },
      recentRuns: []
    });

    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Review Existing Spec" }));
    fireEvent.change(screen.getByLabelText("Specification text"), {
      target: { value: "# Existing Spec" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
        mode: "existing_spec",
        title: "Existing spec review",
        existingSpec: { spec: "# Existing Spec" }
      }));
    });
  });
});
