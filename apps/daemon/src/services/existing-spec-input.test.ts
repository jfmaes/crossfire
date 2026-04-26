import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExistingSpecInput } from "./existing-spec-input";

let tempDir: string | undefined;

describe("resolveExistingSpecInput", () => {
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("requires a spec text or path", async () => {
    await expect(resolveExistingSpecInput({ existingSpec: {} }))
      .rejects.toThrow("existingSpec.spec or existingSpec.specPath is required");
  });

  it("rejects text and path for the same spec", async () => {
    await expect(resolveExistingSpecInput({
      existingSpec: { spec: "# Spec", specPath: "/tmp/spec.md" }
    })).rejects.toThrow("Provide either spec text or specPath, not both");
  });

  it("reads daemon-local markdown paths", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-existing-spec-"));
    const specPath = path.join(tempDir, "spec.md");
    const planPath = path.join(tempDir, "plan.txt");
    await writeFile(specPath, "# Existing Spec", "utf8");
    await writeFile(planPath, "# Existing Plan", "utf8");

    const resolved = await resolveExistingSpecInput({
      prompt: "Focus on rollout risk.",
      existingSpec: { specPath, implementationPlanPath: planPath }
    });

    expect(resolved.spec).toBe("# Existing Spec");
    expect(resolved.implementationPlan).toBe("# Existing Plan");
    expect(resolved.prompt).toContain("Focus on rollout risk.");
    expect(resolved.prompt).toContain("EXISTING SPECIFICATION");
    expect(resolved.sources).toEqual([
      { label: "spec", sourceType: "path", path: specPath, fileName: "spec.md", chars: 15 },
      { label: "implementationPlan", sourceType: "path", path: planPath, fileName: "plan.txt", chars: 15 }
    ]);
  });

  it("rejects unsupported extensions and directories", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "crossfire-existing-spec-"));
    const unsupported = path.join(tempDir, "spec.pdf");
    const directory = path.join(tempDir, "docs");
    await writeFile(unsupported, "not really pdf", "utf8");
    await mkdir(directory);

    await expect(resolveExistingSpecInput({ existingSpec: { specPath: unsupported } }))
      .rejects.toThrow("Unsupported spec file extension");
    await expect(resolveExistingSpecInput({ existingSpec: { specPath: directory } }))
      .rejects.toThrow("spec path must be a file");
  });

  it("rejects oversized text before model calls", async () => {
    await expect(resolveExistingSpecInput({
      existingSpec: { spec: "x".repeat(250_001) }
    })).rejects.toThrow("spec exceeds");
  });
});
