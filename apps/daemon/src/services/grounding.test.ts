import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGroundingContext } from "./grounding";

let tempDir: string | undefined;

describe("collectGroundingContext", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("filters files to a read-only, size-limited context bundle", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-grounding-"));
    await writeFile(path.join(tempDir, "README.md"), "# Hello\n");
    await writeFile(path.join(tempDir, "index.ts"), "export const demo = true;\n");
    await writeFile(path.join(tempDir, "ignored.txt"), "ignore me\n");

    const result = await collectGroundingContext({
      rootDir: tempDir,
      maxFiles: 2,
      includeExtensions: [".md", ".ts"]
    });

    expect(result.files.length).toBeLessThanOrEqual(2);
    expect(result.files.every((file) => [".md", ".ts"].includes(path.extname(file.absolutePath)))).toBe(true);
  });

  it("returns empty files when rootDir does not exist (greenfield)", async () => {
    const result = await collectGroundingContext({
      rootDir: "/tmp/council-nonexistent-dir-" + Date.now(),
      maxFiles: 5,
      includeExtensions: [".md", ".ts"]
    });

    expect(result.files).toEqual([]);
  });
});
