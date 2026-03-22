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

  it("renders converged approach inline (no details collapse)", () => {
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

  it("shows disagreement counts per turn", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 3"
        summary="Summary"
        turns={[
          { actor: "gpt", summary: "Initial analysis", disagreements: [] },
          { actor: "claude", summary: "Counter analysis", disagreements: ["Cache invalidation risk", "Missing auth"] }
        ]}
      />
    );
    expect(screen.getByText("0 disagreements")).toBeTruthy();
    expect(screen.getByText("2 disagreements")).toBeTruthy();
  });

  it("renders feedback inputs when canSubmitFeedback is true", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 3"
        summary="Summary"
        convergedApproach="**Challenge 1: Test challenge**\nBody text."
        canSubmitFeedback={true}
        onSubmitFeedback={() => {}}
      />
    );
    expect(screen.getByText("Submit feedback & generate spec")).toBeTruthy();
    expect(screen.getByPlaceholderText("Feedback on challenge 1 (optional)...")).toBeTruthy();
  });
});
