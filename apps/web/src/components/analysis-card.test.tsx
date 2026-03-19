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
      { text: "What is the scope?", priority: 1, rationale: "Bounds the project", proposedBy: "gpt" },
      { text: "What compliance requirements apply?", priority: 2, rationale: "Legal", proposedBy: "claude" }
    ]
  };

  it("renders both analyses side by side", () => {
    render(<AnalysisCard result={result} />);
    expect(screen.getByText("GPT (Dr. Chen)")).toBeTruthy();
    expect(screen.getByText("Claude (Dr. Rivera)")).toBeTruthy();
    expect(screen.getByText(result.gptAnalysis)).toBeTruthy();
    expect(screen.getByText(result.claudeAnalysis)).toBeTruthy();
  });

  it("does not render proposed questions", () => {
    render(<AnalysisCard result={result} />);
    expect(screen.queryByText("Proposed Interview Questions")).toBeNull();
    expect(screen.queryByText("What is the scope?")).toBeNull();
  });
});
