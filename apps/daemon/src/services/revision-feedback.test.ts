import { describe, expect, it } from "vitest";
import {
  chunkFeedback,
  selectFeedbackExcerpts,
  buildRevisionBudgetLedger
} from "./revision-feedback";

describe("revision-feedback", () => {
  it("rejects non-positive chunk size", () => {
    expect(() => chunkFeedback("abc", { chunkSize: 0 })).toThrow(
      "chunkSize must be greater than 0"
    );
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects invalid chunk size: %s", (_name, chunkSize) => {
    expect(() => chunkFeedback("abc", { chunkSize })).toThrow(
      "chunkSize must be a safe integer"
    );
  });

  it("rejects overlap equal to chunk size", () => {
    expect(() => chunkFeedback("abc", { chunkSize: 3, overlap: 3 })).toThrow(
      "overlap must be less than chunkSize"
    );
  });

  it("rejects negative overlap", () => {
    expect(() => chunkFeedback("abc", { chunkSize: 3, overlap: -1 })).toThrow(
      "overlap must be greater than or equal to 0"
    );
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["fractional", 1.5]
  ])("rejects invalid overlap: %s", (_name, overlap) => {
    expect(() => chunkFeedback("abc", { chunkSize: 3, overlap })).toThrow(
      "overlap must be a safe integer"
    );
  });

  it("returns no chunks for empty feedback", () => {
    expect(chunkFeedback("")).toEqual([]);
  });

  it("chunks exact chunk-size feedback as one verbatim chunk", () => {
    const raw = "abc";
    const chunks = chunkFeedback(raw, { chunkSize: 3, overlap: 0 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(raw.slice(chunks[0].startOffset, chunks[0].endOffset));
  });

  it("chunks feedback with stable offsets and verbatim text", () => {
    const raw = "A".repeat(10) + "B".repeat(10) + "C".repeat(10);
    const chunks = chunkFeedback(raw, { chunkSize: 12, overlap: 2 });

    expect(chunks[0]).toMatchObject({
      id: "feedback-chunk-1",
      index: 0,
      startOffset: 0,
      endOffset: 12,
      text: raw.slice(0, 12)
    });
    expect(chunks[1].startOffset).toBe(10);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain("BBBB");
  });

  it("selects exact excerpts for requested source chunks within budget", () => {
    const chunks = chunkFeedback("alpha beta gamma delta epsilon", { chunkSize: 12, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1"] }],
      budgetChars: 50
    });

    expect(excerpts.blocked).toBe(false);
    expect(excerpts.text).toContain("feedback-chunk-1");
    expect(excerpts.text).toContain(chunks[0].text);
  });

  it("selects duplicate requested chunk ids once", () => {
    const chunks = chunkFeedback("alpha beta gamma", { chunkSize: 6, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [
        { summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1", "feedback-chunk-1"] }
      ],
      budgetChars: 100
    });

    expect(excerpts.selectedChunkIds).toEqual(["feedback-chunk-1"]);
    expect(excerpts.text.match(/feedback-chunk-1/g)).toHaveLength(1);
  });

  it("blocks and reports missing requested chunk ids", () => {
    const chunks = chunkFeedback("alpha beta gamma", { chunkSize: 6, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "Unknown", sourceChunkIds: ["feedback-chunk-99"] }],
      budgetChars: 100
    });

    expect(excerpts.blocked).toBe(true);
    expect(excerpts.missingChunkIds).toEqual(["feedback-chunk-99"]);
    expect(excerpts.selectedChunkIds).toEqual([]);
  });

  it("does not block when selected excerpts exactly match budget", () => {
    const chunks = chunkFeedback("alpha beta", { chunkSize: 10, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1"] }],
      budgetChars: Number.MAX_SAFE_INTEGER
    });

    const exactBudget = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1"] }],
      budgetChars: excerpts.text.length
    });

    expect(exactBudget.blocked).toBe(false);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["fractional", 1.5],
    ["negative", -1]
  ])("rejects invalid budget chars: %s", (_name, budgetChars) => {
    const chunks = chunkFeedback("alpha beta", { chunkSize: 10, overlap: 0 });

    expect(() =>
      selectFeedbackExcerpts({
        chunks,
        requestedChanges: [{ summary: "Use alpha", sourceChunkIds: ["feedback-chunk-1"] }],
        budgetChars
      })
    ).toThrow("budgetChars must be a non-negative safe integer");
  });

  it("blocks when selected excerpts exceed budget", () => {
    const chunks = chunkFeedback("x".repeat(100), { chunkSize: 50, overlap: 0 });
    const excerpts = selectFeedbackExcerpts({
      chunks,
      requestedChanges: [{ summary: "All", sourceChunkIds: ["feedback-chunk-1", "feedback-chunk-2"] }],
      budgetChars: 20
    });

    expect(excerpts.blocked).toBe(true);
  });

  it("builds a budget ledger", () => {
    const ledger = buildRevisionBudgetLedger({
      feedbackRaw: "raw",
      feedbackDigest: "digest",
      feedbackExcerpts: "excerpt",
      currentSpec: "spec",
      currentPlan: "plan"
    });

    expect(ledger.feedbackRawChars).toBe(3);
    expect(ledger.currentSpecChars).toBe(4);
  });
});
