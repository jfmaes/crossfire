// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InterviewCard } from "./interview-card";
import type { InterviewState } from "../lib/api";

describe("InterviewCard", () => {
  afterEach(cleanup);
  const baseState: InterviewState = {
    questions: [
      { id: "q1", text: "What is the scope?", priority: 1, rationale: "Bounds the project", proposedBy: "gpt", answer: null },
      { id: "q2", text: "What is the tech stack?", priority: 2, rationale: "Tech choice", proposedBy: "claude", answer: null }
    ],
    currentQuestion: { id: "q1", text: "What is the scope?", rationale: "Bounds the project" },
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
});
