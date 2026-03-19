import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

interface GroundingInput {
  rootDir: string;
  maxFiles: number;
  includeExtensions: string[];
}

export async function collectGroundingContext(input: GroundingInput) {
  let entries;
  try {
    entries = await readdir(input.rootDir, { withFileTypes: true });
  } catch {
    return { files: [] };
  }

  const matching = entries
    .filter(
      (entry) =>
        entry.isFile() && input.includeExtensions.includes(path.extname(entry.name))
    )
    .slice(0, input.maxFiles);

  const files = await Promise.all(
    matching.map(async (entry) => {
      const absolutePath = path.join(input.rootDir, entry.name);
      try {
        return {
          absolutePath,
          content: await readFile(absolutePath, "utf8")
        };
      } catch {
        return null;
      }
    })
  );

  return { files: files.filter((f): f is NonNullable<typeof f> => f !== null) };
}
