// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SpecCard } from "./spec-card";

describe("SpecCard", () => {
  afterEach(cleanup);
  const result = {
    spec: "# Specification\n\n## Goal\nBuild a task manager\n\n## Architecture\nReact + Node",
    summary: "A task manager specification covering frontend and backend"
  };

  it("renders the spec summary", () => {
    render(<SpecCard result={result} isFinalized={false} />);
    expect(screen.getByText(result.summary)).toBeTruthy();
  });

  it("renders the spec document content", () => {
    render(<SpecCard result={result} isFinalized={false} />);
    const specDoc = document.querySelector(".spec-document");
    expect(specDoc).toBeTruthy();
    expect(specDoc?.textContent).toContain("Specification");
  });

  it("shows 'Needs review' badge when not finalized", () => {
    render(<SpecCard result={result} isFinalized={false} />);
    expect(screen.getByText("Needs review")).toBeTruthy();
  });

  it("shows 'Finalized' badge when finalized", () => {
    render(<SpecCard result={result} isFinalized={true} />);
    expect(screen.getByText("Finalized")).toBeTruthy();
  });
});
