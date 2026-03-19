import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_SIZE_BYTES = 100 * 1024; // 100 KB per file
const MAX_TOTAL_BYTES = 500 * 1024; // 500 KB total grounding budget

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

  let totalBytes = 0;
  const files = await Promise.all(
    matching.map(async (entry) => {
      const absolutePath = path.join(input.rootDir, entry.name);
      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.size > MAX_FILE_SIZE_BYTES) {
          return null;
        }
        if (totalBytes + fileStat.size > MAX_TOTAL_BYTES) {
          return null;
        }
        const content = await readFile(absolutePath, "utf8");
        totalBytes += fileStat.size;
        return { absolutePath, content };
      } catch {
        return null;
      }
    })
  );

  return { files: files.filter((f): f is NonNullable<typeof f> => f !== null) };
}
