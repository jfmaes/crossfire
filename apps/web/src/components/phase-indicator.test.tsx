// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PhaseIndicator } from "./phase-indicator";

describe("PhaseIndicator", () => {
  afterEach(cleanup);

  it("renders all 4 phases", () => {
    render(<PhaseIndicator currentPhase="analysis" />);
    expect(screen.getByText("Analysis")).toBeTruthy();
    expect(screen.getByText("Interview")).toBeTruthy();
    expect(screen.getByText("Approach Debate")).toBeTruthy();
    expect(screen.getByText("Spec Generation")).toBeTruthy();
  });

  it("marks the current phase with aria-current", () => {
    render(<PhaseIndicator currentPhase="interview" />);
    const currentStep = screen.getByText("Interview").closest("li");
    expect(currentStep?.getAttribute("aria-current")).toBe("step");
  });

  it("marks earlier phases as completed", () => {
    render(<PhaseIndicator currentPhase="interview" />);
    const analysisStep = screen.getByText("Analysis").closest("li");
    expect(analysisStep?.className).toContain("completed");
  });

  it("marks later phases as upcoming", () => {
    render(<PhaseIndicator currentPhase="interview" />);
    const specStep = screen.getByText("Spec Generation").closest("li");
    expect(specStep?.className).toContain("upcoming");
  });
});
