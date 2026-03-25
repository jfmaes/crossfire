import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown";

describe("renderMarkdown", () => {
  it("renders JSON into structured HTML", () => {
    const html = renderMarkdown('{"status":"ok","items":[1,2]}');

    expect(html).toContain("md-structured--json");
    expect(html).toContain("status");
    expect(html).toContain("items");
    expect(html).not.toContain("<p>{");
  });

  it("repairs trivial broken JSON with trailing commas", () => {
    const html = renderMarkdown('{"status":"ok","items":[1,2,],}');

    expect(html).toContain("md-structured--json");
    expect(html).toContain("status");
    expect(html).toContain("items");
  });

  it("renders YAML-like content into structured rows", () => {
    const html = renderMarkdown([
      "status: ok",
      "items:",
      "  - alpha",
      "  - beta"
    ].join("\n"));

    expect(html).toContain("md-structured--yaml");
    expect(html).toContain("status");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
  });

  it("falls back to markdown for normal prose", () => {
    const html = renderMarkdown("## Title\n\nA normal paragraph.");

    expect(html).toContain("md-h2");
    expect(html).toContain("<p>A normal paragraph.</p>");
  });

  it("does not render prose with colons as YAML", () => {
    const analysis = [
      "## Analysis",
      "",
      "The system has several concerns:",
      "",
      "- Architecture: The current design uses a monolith",
      "- Risk: There is no failover mechanism in place",
      "- Performance: Latency is acceptable for now",
      "",
      "Overall the approach is sound but needs iteration."
    ].join("\n");
    const html = renderMarkdown(analysis);

    expect(html).not.toContain("md-structured");
    expect(html).toContain("md-h2");
    expect(html).toContain("md-list");
  });

  it("does not render prose with bold and colons as YAML", () => {
    const analysis = [
      "**Key finding:** The API layer is well-structured.",
      "",
      "Scalability: The service handles 10k requests per second.",
      "However, the database connection pool is undersized.",
      "",
      "**Recommendation:** Increase the pool size to 50 connections."
    ].join("\n");
    const html = renderMarkdown(analysis);

    expect(html).not.toContain("md-structured");
    expect(html).toContain("<strong>");
  });
});
