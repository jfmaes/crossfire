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

  it("renders converged approach in a details element", () => {
    render(
      <DebateCard
        title="Approach Debate"
        badge="Phase 4"
        summary="Summary"
        convergedApproach="Use Yjs with ProseMirror for the editor model."
      />
    );
    expect(screen.getByText("Converged approach (full text)")).toBeTruthy();
    expect(screen.getByText("Use Yjs with ProseMirror for the editor model.")).toBeTruthy();
  });
});
