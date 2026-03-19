import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSpecArtifact } from "./artifacts";

let tempDir: string | undefined;

describe("writeSpecArtifact", () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("writes the rendered artifact to disk", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "council-artifacts-"));
    const filePath = await writeSpecArtifact({
      directory: tempDir,
      fileName: "session-1.md",
      markdown: "# Session 1\n"
    });

    const contents = await readFile(filePath, "utf8");

    expect(filePath).toBe(path.join(tempDir, "session-1.md"));
    expect(contents).toBe("# Session 1\n");
  });
});
