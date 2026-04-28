import { describe, expect, it } from "vitest";
import { buildRecommendationBrief } from "./build-recommendation-brief";
import { classifyChildSession } from "./classify-child-session";

const baseSnapshot = {
  sessionId: "sess_1",
  label: "release-risk",
  lens: "implementation and rollout risk",
  session: {
    id: "sess_1",
    title: "Release risk",
    status: "draft",
    phase: "analysis"
  },
  summary: {
    currentUnderstanding: "Missing platform scope.",
    recommendation: "Answer the question below.",
    changedSinceLastCheckpoint: [],
    openRisks: ["Platform choice is unresolved."],
    decisionsNeeded: ["Answer the interview question"]
  },
  interviewState: {
    questions: [],
    currentQuestion: {
      id: "q_1",
      text: "What is the target platform?",
      rationale: "Need scope",
      context: "This changes rollout planning.",
      recommendation: "Start with web only.",
      recommendationReasoning: "Smaller first release."
    },
    totalQuestions: 1,
    answeredCount: 0
  },
  activeRun: null,
  recentRuns: []
} as const;

describe("classifyChildSession", () => {
  it("maps waiting_for_human to human_blocked and builds an interview recommendation brief", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "waiting_for_human" }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "human_blocked"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "human_blocked",
      label: "release-risk",
      lens: "implementation and rollout risk",
      summary: "Missing platform scope.",
      recommendedDirection: "Start with web only."
    });
    expect(brief?.questions).toEqual(["What is the target platform?"]);
    expect(brief?.risks).toEqual(["Platform choice is unresolved."]);
  });

  it("maps interviewing to human_blocked", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "interviewing" }
    };

    expect(classifyChildSession(snapshot, [])).toMatchObject({
      state: "human_blocked"
    });
  });

  it("maps checkpoint to human_blocked", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "checkpoint", phase: "approach_debate" },
      interviewState: undefined,
      summary: {
        currentUnderstanding: "Approach is ready.",
        recommendation: "Approve approach to proceed.",
        changedSinceLastCheckpoint: [],
        openRisks: [],
        decisionsNeeded: ["Approve approach to proceed to spec generation"]
      }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "human_blocked"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "human_blocked",
      label: "release-risk",
      lens: "implementation and rollout risk",
      summary: "Approach is ready.",
      recommendedDirection: "Approve approach to proceed."
    });
    expect(brief?.questions).toEqual([
      "Approve approach to proceed to spec generation"
    ]);
  });

  it("returns null for finalized sessions", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "finalized", phase: "spec_generation" }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "finalized"
    });
    expect(buildRecommendationBrief(snapshot, classification)).toBeNull();
  });

  it("maps transient errored runs to recoverable_transient", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "errored" },
      activeRun: {
        id: "run_1",
        status: "errored",
        phase: "analysis",
        errorMessage: "Provider timeout while streaming response"
      }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "errored",
      errorState: "recoverable_transient",
      reason: "Provider timeout while streaming response"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "recovery_needed",
      summary: "Provider timeout while streaming response",
      recommendedDirection:
        "Retry or restart this child session after reviewing the latest run error."
    });
    expect(brief?.questions).toEqual([]);
  });

  it("maps non-transient errored runs to recoverable_operator", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "errored" },
      activeRun: {
        id: "run_2",
        status: "errored",
        phase: "analysis",
        errorMessage: "Spec artifact needs manual reconciliation with the latest branch state"
      }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "errored",
      errorState: "recoverable_operator",
      reason: "Spec artifact needs manual reconciliation with the latest branch state"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "recovery_needed",
      summary: "Spec artifact needs manual reconciliation with the latest branch state",
      recommendedDirection: "Inspect the child session manually before continuing."
    });
    expect(brief?.questions).toEqual([]);
  });

  it("maps unrecoverable errored runs to terminal and avoids retry guidance", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "errored" },
      activeRun: {
        id: "run_3",
        status: "errored",
        phase: "analysis",
        errorMessage: "Spec artifact missing required sections for this workflow"
      }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "errored",
      errorState: "terminal",
      reason: "Spec artifact missing required sections for this workflow"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "recovery_needed",
      summary: "Spec artifact missing required sections for this workflow",
      recommendedDirection:
        "Do not retry automatically. Repair the underlying input or workflow state manually before continuing."
    });
    expect(brief?.recommendedDirection).not.toBe(
      "Retry or restart this child session after reviewing the latest run error."
    );
    expect(brief?.recommendedDirection).not.toBe(
      "Inspect the child session manually before continuing."
    );
  });

  it("treats phase_invalid errors as terminal", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "errored" },
      activeRun: {
        id: "run_4",
        status: "errored",
        phase: "analysis",
        errorMessage: "phase_invalid_turn: debate output did not match the active phase"
      }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "errored",
      errorState: "terminal",
      reason: "phase_invalid_turn: debate output did not match the active phase"
    });

    const brief = buildRecommendationBrief(snapshot, classification);
    expect(brief).toMatchObject({
      kind: "recovery_needed",
      recommendedDirection:
        "Do not retry automatically. Repair the underlying input or workflow state manually before continuing."
    });
  });

  it("falls back to recent errored runs when activeRun is null", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "errored" },
      activeRun: null,
      recentRuns: [
        {
          id: "run_older",
          status: "finalized",
          phase: "analysis",
          errorMessage: null
        },
        {
          id: "run_recent",
          status: "errored",
          phase: "analysis",
          errorMessage: "phase_invalid: output status is invalid for this phase"
        }
      ]
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "errored",
      errorState: "terminal",
      reason: "phase_invalid: output status is invalid for this phase"
    });
  });

  it("returns null for running sessions", () => {
    const snapshot = {
      ...baseSnapshot,
      session: { ...baseSnapshot.session, status: "debating", phase: "approach_debate" }
    };

    const classification = classifyChildSession(snapshot, []);

    expect(classification).toMatchObject({
      state: "running"
    });
    expect(buildRecommendationBrief(snapshot, classification)).toBeNull();
  });
});
