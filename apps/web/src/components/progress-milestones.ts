import type { SessionRunEvent } from "../lib/api";

export interface ProgressMilestone {
  id: string;
  createdAt: string;
  model?: string;
  phase?: string | null;
  text: string;
}

export function formatElapsed(ms?: number | null): string | null {
  if (typeof ms !== "number") return null;

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

export function isMaterialMilestone(event: Pick<SessionRunEvent, "type">): boolean {
  return event.type === "phase_start" ||
    event.type === "model_start" ||
    event.type === "model_done" ||
    event.type === "consensus" ||
    event.type === "info";
}

function formatModel(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatPhase(value: string): string {
  return value.replaceAll("_", " ");
}

export function milestoneText(
  event: Pick<SessionRunEvent, "type" | "model" | "phase" | "message" | "elapsedMs">
): string {
  if (event.type === "model_done" && event.model && event.phase) {
    const elapsed = formatElapsed(event.elapsedMs);
    return `${formatModel(event.model)} finished ${formatPhase(event.phase)}${elapsed ? ` in ${elapsed}` : ""}`;
  }

  if (event.type === "model_start" && event.model && event.phase) {
    return `${formatModel(event.model)} started ${formatPhase(event.phase)}`;
  }

  return event.message;
}

export function deriveMilestones(events: SessionRunEvent[]): ProgressMilestone[] {
  return events
    .filter(isMaterialMilestone)
    .map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      model: event.model ?? undefined,
      phase: event.phase ?? null,
      text: milestoneText(event)
    }));
}
