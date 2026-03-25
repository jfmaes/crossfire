type ProgressListener = (event: ProgressEvent) => void;

export interface ProgressEvent {
  sessionId: string;
  runId?: string;
  type: "phase_start" | "model_start" | "model_done" | "model_stream" | "phase_done" | "consensus" | "info";
  message: string;
  model?: "gpt" | "claude";
  phase?: string;
  turnNumber?: number;
  elapsedMs?: number;
  disagreements?: number;
}

export function summarizeProgressText(text: string, maxLength = 220): string {
  const normalized = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

const listeners = new Set<ProgressListener>();

export function onProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitProgress(event: ProgressEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Don't let a broken listener kill the pipeline
    }
  }

  // Also log to terminal
  const prefix = event.model ? `[${event.model.toUpperCase()}]` : "▸";
  console.log(`  ${prefix} ${event.message}`);
}
