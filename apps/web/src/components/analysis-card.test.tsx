// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AnalysisCard } from "./analysis-card";

describe("AnalysisCard", () => {
  afterEach(cleanup);

  const result = {
    gptAnalysis: "GPT sees three main concerns with this design",
    claudeAnalysis: "Claude identifies security risks in the auth layer",
    proposedQuestions: [
      {
        text: "What is the scope?",
        priority: 1,
        rationale: "Bounds the project",
        context: "In plain English, this decides what the first version actually includes.",
        recommendation: "Start with a narrow first release.",
        recommendationReasoning: "That reduces delivery risk while proving the workflow.",
        proposedBy: "gpt"
      },
      { text: "What compliance requirements apply?", priority: 2, rationale: "Legal", proposedBy: "claude" }
    ],
    questionDebateTrace: {
      stopReason: "consensus",
      turnsUsed: 4,
      maxTurns: 6
    }
  };

  it("renders both analyses in collapsible panes", () => {
    render(<AnalysisCard result={result} />);
    expect(screen.getByText("GPT (Dr. Chen)")).toBeTruthy();
    expect(screen.getByText("Claude (Dr. Rivera)")).toBeTruthy();
    expect(screen.getByText(result.gptAnalysis)).toBeTruthy();
    expect(screen.getByText(result.claudeAnalysis)).toBeTruthy();
  });

  it("renders the interview question set without legacy synthesis copy", () => {
    render(<AnalysisCard result={result} />);

    expect(screen.getByText("Interview question set")).toBeTruthy();
    expect(screen.getByText("Questions ready: 2")).toBeTruthy();
    expect(screen.getByText("Outcome: Consensus reached")).toBeTruthy();
    expect(screen.getByText("What is the scope?")).toBeTruthy();
    expect(screen.getByText("In plain English, this decides what the first version actually includes.")).toBeTruthy();
    expect(screen.getByText(/Start with a narrow first release/)).toBeTruthy();
    expect(screen.getByText("What compliance requirements apply?")).toBeTruthy();
    expect(screen.queryByText("Question synthesis")).toBeNull();
    expect(screen.queryByText(/Dual-endorsed/i)).toBeNull();
  });
});
