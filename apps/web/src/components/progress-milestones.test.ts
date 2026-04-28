import { describe, expect, it } from "vitest";
import type { SessionRunEvent } from "../lib/api";
import { deriveMilestones } from "./progress-milestones";

function makeEvent(overrides: Partial<SessionRunEvent>): SessionRunEvent {
  return {
    id: "evt_default",
    runId: "run_1",
    sessionId: "sess_1",
    type: "info",
    message: "default event",
    createdAt: "2026-04-27T17:28:34.760Z",
    ...overrides
  };
}

describe("deriveMilestones", () => {
  it("turns material run events into concrete milestones", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "phase_start",
        phase: "analysis",
        message: "Phase 1: Dual Analysis (GPT + Claude in parallel)"
      }),
      makeEvent({
        id: "evt_2",
        type: "model_done",
        model: "claude",
        phase: "analysis",
        elapsedMs: 176497,
        message: "Done in 176.5s - 10989 chars",
        createdAt: "2026-04-27T17:31:31.260Z"
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "Phase 1: Dual Analysis (GPT + Claude in parallel)",
      "Claude finished analysis in 2m 56s"
    ]);
  });

  it("filters noisy stream/progress chatter from the milestone list", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "model_stream",
        model: "gpt",
        phase: "analysis",
        message: "Reading additional input from stdin..."
      }),
      makeEvent({
        id: "evt_2",
        type: "model_progress",
        model: "gpt",
        phase: "analysis",
        message: "Still working",
        createdAt: "2026-04-27T17:28:36.000Z"
      })
    ]);

    expect(milestones).toEqual([]);
  });

  it("formats debate turn milestones without requiring a phase", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "model_start",
        model: "gpt",
        turnNumber: 1,
        message: "Turn 1..."
      }),
      makeEvent({
        id: "evt_2",
        type: "model_done",
        model: "gpt",
        turnNumber: 1,
        elapsedMs: 42500,
        message: "Turn 1 done in 42.5s - 0 disagreements",
        createdAt: "2026-04-27T17:29:16.000Z"
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "GPT started debate turn 1",
      "GPT finished debate turn 1 in 42s"
    ]);
  });

  it("excludes non-material info events by default", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "info",
        phase: "gap_synthesis",
        message: "Synthesized 4 walkthrough gap(s) into 6210 chars"
      }),
      makeEvent({
        id: "evt_2",
        type: "info",
        phase: "spec_generation",
        message: "Adversarial Walkthrough (both models simulate execution in parallel)",
        createdAt: "2026-04-27T17:30:00.000Z"
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "Adversarial Walkthrough (both models simulate execution in parallel)"
    ]);
  });

  it("includes blocked info events from metadata", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "info",
        phase: "spec_generation",
        message: "feedback input too large: prioritize the latest comments",
        metadata: { blockedReason: "feedback_input_too_large" }
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "feedback input too large: prioritize the latest comments"
    ]);
  });

  it("includes material gap synthesis info events driven by metadata", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "info",
        phase: "gap_synthesis",
        message: "Synthesized walkthrough gap brief omitted coverage for 2 original gap(s)",
        metadata: { blockedReason: "gap_synthesis_coverage_incomplete" }
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "Synthesized walkthrough gap brief omitted coverage for 2 original gap(s)"
    ]);
  });

  it("keeps non-material gap synthesis info excluded", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "info",
        phase: "gap_synthesis",
        message: "Synthesized 4 walkthrough gap(s) into 6210 chars",
        metadata: {}
      })
    ]);

    expect(milestones).toEqual([]);
  });

  it("does not depend on undeclared metadata fields to keep material events", () => {
    const milestones = deriveMilestones([
      makeEvent({
        id: "evt_1",
        type: "info",
        phase: "spec_generation",
        message: "Claude spec revision retry returned phase-invalid structured output",
        metadata: { outputStatus: "phase_invalid" }
      })
    ]);

    expect(milestones.map((milestone) => milestone.text)).toEqual([
      "Claude spec revision retry returned phase-invalid structured output"
    ]);
  });
});
