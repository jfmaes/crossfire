// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointCard } from "./checkpoint-card";

describe("CheckpointCard", () => {
  afterEach(cleanup);
  it("renders decisions needed and open risks", () => {
    render(
      <CheckpointCard
        summary={{
          currentUnderstanding: "The app coordinates Claude and GPT locally.",
          recommendation: "Use a daemon-backed architecture.",
          changedSinceLastCheckpoint: ["Added mobile web support"],
          openRisks: ["Claude session continuity may degrade"],
          decisionsNeeded: ["Confirm the default checkpoint interval"]
        }}
      />
    );

    expect(screen.getByText("Confirm the default checkpoint interval")).toBeTruthy();
    expect(screen.getByText("Claude session continuity may degrade")).toBeTruthy();
  });

  it("hides empty sections", () => {
    render(
      <CheckpointCard
        summary={{
          currentUnderstanding: "Summary text.",
          recommendation: "Continue.",
          changedSinceLastCheckpoint: [],
          openRisks: [],
          decisionsNeeded: []
        }}
      />
    );

    expect(screen.queryByText("Decisions needed")).toBeNull();
    expect(screen.queryByText("Open risks")).toBeNull();
  });

  it("shows degraded banner and filters the marker from risks", () => {
    render(
      <CheckpointCard
        summary={{
          currentUnderstanding: "Partial analysis.",
          recommendation: "Needs review.",
          changedSinceLastCheckpoint: [],
          openRisks: ["Limited analysis used for at least one turn", "Real risk"],
          decisionsNeeded: ["Review the first checkpoint"]
        }}
      />
    );

    expect(screen.getByText(/at least one model returned unstructured output/)).toBeTruthy();
    expect(screen.getByText("Real risk")).toBeTruthy();
    expect(screen.queryByText("Limited analysis used for at least one turn")).toBeNull();
  });
});
