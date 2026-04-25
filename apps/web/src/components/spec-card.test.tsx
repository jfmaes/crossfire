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

  it("shows finalized status when finalized", () => {
    render(<SpecCard result={result} isFinalized={true} />);
    expect(screen.getByText("Finalized")).toBeTruthy();
  });

  it("surfaces fresh-context and authority-path status in trace pills", () => {
    render(
      <SpecCard
        result={{
          ...result,
          trace: {
            draft: { conversationReused: false },
            review: { conversationReused: false },
            revision: { conversationReused: false },
            revisedAfterWalkthrough: true,
            gapCount: 2,
            authorityPathUncompacted: true,
            canonicalApproachHandoff: true,
            compaction: {
              approachResult: false,
              peerDraft: false,
              revisionPeerDraft: false
            }
          }
        }}
        isFinalized={false}
      />
    );

    expect(screen.getByText("Walkthrough gaps: 2")).toBeTruthy();
    expect(screen.getByText("Revision after walkthrough: yes")).toBeTruthy();
    expect(screen.getByText("Fresh context throughout spec path")).toBeTruthy();
    expect(screen.getByText("Canonical approach handoff")).toBeTruthy();
    expect(screen.getByText("Authority path: uncompressed")).toBeTruthy();
  });

  it("surfaces backend trace field names from spec generation", () => {
    render(
      <SpecCard
        result={{
          ...result,
          trace: {
            freshContext: {
              draft: true,
              review: true,
              walkthrough: true,
              revision: false
            },
            canonicalHandoffUsed: true,
            authorityPathUncompressed: true
          }
        }}
        isFinalized={false}
      />
    );

    expect(screen.getByText("Fresh context throughout spec path")).toBeTruthy();
    expect(screen.getByText("Canonical approach handoff")).toBeTruthy();
    expect(screen.getByText("Authority path: uncompressed")).toBeTruthy();
  });

  it("warns when the spec path hits oversize blocking", () => {
    render(
      <SpecCard
        result={{
          ...result,
          trace: {
            blockedReason: "revision_input_too_large",
            blockedByOversize: true
          }
        }}
        isFinalized={false}
      />
    );

    expect(screen.getByText("Blocked: Revision input too large")).toBeTruthy();
    expect(screen.getByText("The spec path did not stay in the ideal handoff state")).toBeTruthy();
  });
});
