import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function renderSpecArtifact(input: {
  title: string;
  goals: string[];
  constraints: string[];
}) {
  return [
    `# ${input.title}`,
    "",
    "## Goals",
    ...input.goals.map((goal) => `- ${goal}`),
    "",
    "## Constraints",
    ...input.constraints.map((constraint) => `- ${constraint}`)
  ].join("\n");
}

export async function writeSpecArtifact(input: {
  directory: string;
  fileName: string;
  markdown: string;
}) {
  await mkdir(input.directory, { recursive: true });

  const filePath = path.join(input.directory, input.fileName);
  await writeFile(filePath, input.markdown, "utf8");

  return filePath;
}
