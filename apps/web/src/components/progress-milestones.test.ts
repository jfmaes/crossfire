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
});
