// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InterviewCard } from "./interview-card";
import type { InterviewState } from "../lib/api";

describe("InterviewCard", () => {
  afterEach(cleanup);
  const baseState: InterviewState = {
    questions: [
      {
        id: "q1",
        text: "What is the scope?",
        priority: 1,
        rationale: "Bounds the project",
        context: "This decides what the first release is actually responsible for.",
        recommendation: "Start with a narrow web-only v1.",
        recommendationReasoning: "That keeps the rollout safer and cheaper while proving the workflow.",
        proposedBy: "gpt",
        answer: null
      },
      { id: "q2", text: "What is the tech stack?", priority: 2, rationale: "Tech choice", proposedBy: "claude", answer: null }
    ],
    currentQuestion: {
      id: "q1",
      text: "What is the scope?",
      rationale: "Bounds the project",
      context: "This decides what the first release is actually responsible for.",
      recommendation: "Start with a narrow web-only v1.",
      recommendationReasoning: "That keeps the rollout safer and cheaper while proving the workflow."
    },
    totalQuestions: 2,
    answeredCount: 0
  };

  it("shows the current question", () => {
    render(<InterviewCard state={baseState} />);
    expect(screen.getByText("What is the scope?")).toBeTruthy();
  });

  it("shows progress count", () => {
    render(<InterviewCard state={baseState} />);
    expect(screen.getByText("0 of 2")).toBeTruthy();
  });

  it("shows plain-language context and a recommendation for the current question", () => {
    render(<InterviewCard state={baseState} />);
    expect(screen.getByText("What this means in practice")).toBeTruthy();
    expect(screen.getByText("This decides what the first release is actually responsible for.")).toBeTruthy();
    expect(screen.getByText("Crossfire recommendation")).toBeTruthy();
    expect(screen.getByText("Start with a narrow web-only v1.")).toBeTruthy();
  });

  it("shows completion message when all questions answered", () => {
    const doneState: InterviewState = {
      questions: [
        { id: "q1", text: "Scope?", priority: 1, rationale: "R", proposedBy: "gpt", answer: "Web only" }
      ],
      currentQuestion: null,
      totalQuestions: 1,
      answeredCount: 1
    };

    render(<InterviewCard state={doneState} />);
    expect(screen.getByText("All questions have been answered.")).toBeTruthy();
  });

  it("shows answered questions in accordion", () => {
    const partialState: InterviewState = {
      questions: [
        { id: "q1", text: "Scope?", priority: 1, rationale: "R", proposedBy: "gpt", answer: "Web only" },
        { id: "q2", text: "Stack?", priority: 2, rationale: "R", proposedBy: "claude", answer: null }
      ],
      currentQuestion: { id: "q2", text: "Stack?", rationale: "R" },
      totalQuestions: 2,
      answeredCount: 1
    };

    render(<InterviewCard state={partialState} />);
    expect(screen.getByText("Answered questions (1)")).toBeTruthy();
  });

  it("lets the user accept the Crossfire recommendation directly", () => {
    let submitted: string | null = null;
    render(
      <InterviewCard
        state={baseState}
        onUseRecommendation={(answer) => {
          submitted = answer;
        }}
      />
    );

    screen.getByRole("button", { name: "Use Crossfire recommendation" }).click();
    expect(submitted).toBe("Start with a narrow web-only v1.");
  });
});
