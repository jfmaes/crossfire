import { describe, expect, it } from "vitest";
import { parseStructuredTurn } from "./structured-turn";

describe("parseStructuredTurn", () => {
  it("defaults only harmless fields and keeps omitted control fields observable", () => {
    const turn = parseStructuredTurn("gpt", JSON.stringify({
      rawText: "Analysis text",
      summary: "Analysis summary"
    }));

    expect(turn.degraded).toBe(false);
    expect(turn.newInsights).toEqual([]);
    expect(turn.assumptions).toEqual([]);
    expect(turn.questionsForPeer).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(turn, "disagreements")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "questionsForHuman")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "proposedQuestions")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "implementationPlan")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "walkthroughGaps")).toBe(false);
  });

  it("preserves explicit question-debate fields without inventing trimmed control fields", () => {
    const turn = parseStructuredTurn("gpt", JSON.stringify({
      rawText: "We still need deployment-target clarification before final pruning.",
      summary: "Blocked on deployment-target clarification",
      newInsights: ["Platform scope changes which interview questions are still necessary."],
      assumptions: ["The product might be web-only."],
      disagreements: [
        "Keep the platform-scope question until the target platforms are explicitly confirmed."
      ],
      questionsForHuman: ["Which platforms must v1 support?"],
      synthesizedQuestions: [
        {
          text: "Which platforms must v1 support?",
          priority: 1,
          rationale: "Platform scope drives architecture, testing, and rollout decisions."
        }
      ]
    }));

    expect(turn.degraded).toBe(false);
    expect(turn.questionsForHuman).toEqual(["Which platforms must v1 support?"]);
    expect(turn.synthesizedQuestions).toEqual([
      {
        text: "Which platforms must v1 support?",
        priority: 1,
        rationale: "Platform scope drives architecture, testing, and rollout decisions."
      }
    ]);
    expect(Object.prototype.hasOwnProperty.call(turn, "disagreements")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(turn, "questionsForHuman")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(turn, "synthesizedQuestions")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(turn, "proposedQuestions")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "implementationPlan")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "walkthroughGaps")).toBe(false);
  });

  it("preserves phase-specific fields on valid non-degraded turns", () => {
    const turn = parseStructuredTurn("claude", JSON.stringify({
      rawText: "Walkthrough found concrete issues.",
      summary: "Found walkthrough issues",
      newInsights: [],
      assumptions: [],
      disagreements: [],
      questionsForPeer: [],
      questionsForHuman: [],
      proposedSpecDelta: "Updated spec",
      milestoneReached: null,
      implementationPlan: "Updated plan",
      proposedQuestions: null,
      synthesizedQuestions: null,
      followUpQuestions: null,
      sufficientContext: null,
      walkthroughGaps: [
        {
          location: "Phase 5.5",
          issue: "No dynamic importer check",
          fix: "Add dynamic importer analysis"
        }
      ]
    }));

    expect(turn.degraded).toBe(false);
    expect(turn.implementationPlan).toBe("Updated plan");
    expect(turn.walkthroughGaps).toEqual([
      {
        location: "Phase 5.5",
        issue: "No dynamic importer check",
        fix: "Add dynamic importer analysis"
      }
    ]);
  });
});
