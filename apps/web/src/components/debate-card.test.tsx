// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DebateCard } from "./debate-card";

describe("DebateCard", () => {
  afterEach(cleanup);

  it("renders the title and summary", () => {
    render(
      <DebateCard
        title="Question Debate"
        badge="Phase 2"
        summary="GPT argued X. Claude countered with Y."
      />
    );
    expect(screen.getByText("Question Debate")).toBeTruthy();
    expect(screen.getByText("Phase 2")).toBeTruthy();
  });

  it("renders debate turns with actor labels", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 4"
        summary="Summary"
        turns={[
          { actor: "gpt", summary: "We should use CRDTs" },
          { actor: "claude", summary: "CRDTs have trade-offs with large documents" }
        ]}
      />
    );
    expect(screen.getByText("Dr. Chen (GPT)")).toBeTruthy();
    expect(screen.getByText("Dr. Rivera (Claude)")).toBeTruthy();
    expect(screen.getByText("We should use CRDTs")).toBeTruthy();
    expect(screen.getByText("CRDTs have trade-offs with large documents")).toBeTruthy();
  });

  it("renders converged approach inline when there are no structured challenges", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 4"
        summary="Summary"
        convergedApproach="Use Yjs with ProseMirror for the editor model."
      />
    );
    expect(screen.getByText("Converged approach")).toBeTruthy();
    expect(screen.getByText("Use Yjs with ProseMirror for the editor model.")).toBeTruthy();
  });

  it("parses challenges from converged approach and renders individually", () => {
    const convergedApproach = [
      "Preamble text.",
      "",
      "**Challenge 1: Database selection is premature**",
      "The analysis picks Postgres without considering alternatives.",
      "",
      "**Challenge 2: Missing error handling strategy**",
      "No discussion of retry logic or circuit breakers."
    ].join("\n");

    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 3"
        summary="Summary"
        convergedApproach={convergedApproach}
      />
    );
    expect(screen.getByText("Database selection is premature")).toBeTruthy();
    expect(screen.getByText("Missing error handling strategy")).toBeTruthy();
    expect(screen.getByText("C1")).toBeTruthy();
    expect(screen.getByText("C2")).toBeTruthy();
  });

  it("shows clarification-needed state and requires explicit input", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 3"
        summary="Summary"
        canSubmitFeedback={true}
        onSubmitFeedback={() => {}}
        questionsForHuman={["Which deployment environment is authoritative?"]}
        trace={{
          stopReason: "questions_for_human",
          turnsUsed: 3,
          maxTurns: 6
        }}
      />
    );

    expect(screen.getByText("Clarification needed")).toBeTruthy();
    expect(screen.getByText("The debate paused for your input")).toBeTruthy();
    expect(screen.getByText("Which deployment environment is authoritative?")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Submit clarification & continue debate" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("shows unresolved max-turn state with decision-specific submit copy", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 3"
        summary="Summary"
        canSubmitFeedback={true}
        onSubmitFeedback={() => {}}
        trace={{
          stopReason: "max_turns",
          turnsUsed: 6,
          maxTurns: 6,
          finalDisagreementCount: 2,
          finalDisagreements: ["Cache invalidation risk", "Missing auth rollback"]
        }}
      />
    );

    expect(screen.getByText("Needs human judgment")).toBeTruthy();
    expect(screen.getByText("Remaining disagreements")).toBeTruthy();
    expect(screen.getByText("Cache invalidation risk")).toBeTruthy();
    expect(screen.getByText("Missing auth rollback")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit decision & continue" })).toBeTruthy();
  });
});
