import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

let enabled = false;
let logDir = "data/debug";

export function enableDebugLogging(dir?: string): void {
  enabled = true;
  if (dir) logDir = dir;
  if (!existsSync(logDir)) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }
  console.log(`  [DEBUG] Prompt logging enabled → ${logDir}/`);
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function debugLogPrompt(opts: {
  sessionId: string;
  phase: string;
  model: "gpt" | "claude";
  prompt: string;
  turnNumber?: number;
}): void {
  if (!enabled) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const turn = opts.turnNumber ? `-turn${opts.turnNumber}` : "";
  const fileName = `${opts.sessionId.slice(0, 8)}_${opts.phase}_${opts.model}${turn}_${timestamp}.txt`;
  const filePath = join(logDir, fileName);

  const header = [
    `Session:  ${opts.sessionId}`,
    `Phase:    ${opts.phase}`,
    `Model:    ${opts.model}`,
    `Turn:     ${opts.turnNumber ?? "N/A"}`,
    `Time:     ${new Date().toISOString()}`,
    `Prompt length: ${opts.prompt.length} chars`,
    "═".repeat(80),
    ""
  ].join("\n");

  writeFile(filePath, header + opts.prompt, "utf-8").catch(() => {
    // Non-fatal — don't crash the daemon over debug logging
  });
}

export function debugLogResponse(opts: {
  sessionId: string;
  phase: string;
  model: "gpt" | "claude";
  rawText: string;
  parsed: Record<string, unknown> | null;
  turnNumber?: number;
  elapsedMs?: number;
}): void {
  if (!enabled) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const turn = opts.turnNumber ? `-turn${opts.turnNumber}` : "";
  const fileName = `${opts.sessionId.slice(0, 8)}_${opts.phase}_${opts.model}${turn}_response_${timestamp}.txt`;
  const filePath = join(logDir, fileName);

  const disagreements = Array.isArray(opts.parsed?.disagreements)
    ? (opts.parsed!.disagreements as string[])
    : [];

  const header = [
    `Session:       ${opts.sessionId}`,
    `Phase:         ${opts.phase}`,
    `Model:         ${opts.model}`,
    `Turn:          ${opts.turnNumber ?? "N/A"}`,
    `Elapsed:       ${opts.elapsedMs ? `${(opts.elapsedMs / 1000).toFixed(1)}s` : "N/A"}`,
    `Raw length:    ${opts.rawText.length} chars`,
    `Degraded:      ${opts.parsed?.degraded ?? "unknown"}`,
    `Disagreements: ${disagreements.length} — ${disagreements.join("; ") || "none"}`,
    "═".repeat(80),
    ""
  ].join("\n");

  const body = opts.parsed
    ? JSON.stringify(opts.parsed, null, 2)
    : opts.rawText;

  writeFile(filePath, header + body, "utf-8").catch(() => {
    // Non-fatal — don't crash the daemon over debug logging
  });
}
