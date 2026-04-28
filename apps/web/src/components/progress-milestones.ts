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

function isMaterialInfoEvent(
  event: Pick<SessionRunEvent, "message" | "phase" | "metadata">
): boolean {
  const blockedReason = event.metadata?.blockedReason;
  if (typeof blockedReason === "string" && blockedReason.length > 0) {
    return true;
  }

  if (
    event.metadata?.outputStatus === "degraded" ||
    event.metadata?.outputStatus === "phase_invalid" ||
    event.metadata?.outputStatus === "provider_error"
  ) {
    return true;
  }

  if (event.phase === "gap_synthesis") {
    return false;
  }

  return event.message.startsWith("Debate:") ||
    event.message.startsWith("Debate stopped") ||
    event.message.startsWith("Debate finished") ||
    event.message.startsWith("Adversarial Walkthrough") ||
    event.message.includes("operational gap(s) found");
}

export function isMaterialMilestone(
  event: Pick<SessionRunEvent, "type" | "message" | "phase" | "metadata">
): boolean {
  return event.type === "phase_start" ||
    event.type === "model_start" ||
    event.type === "model_done" ||
    event.type === "consensus" ||
    (event.type === "info" && isMaterialInfoEvent(event));
}

function formatModel(value: string): string {
  if (value === "gpt") return "GPT";
  if (value === "claude") return "Claude";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatPhase(value: string): string {
  return value.replaceAll("_", " ");
}

export function milestoneText(
  event: Pick<SessionRunEvent, "type" | "model" | "phase" | "turnNumber" | "message" | "elapsedMs">
): string {
  if (event.type === "model_done" && event.model && event.phase) {
    const elapsed = formatElapsed(event.elapsedMs);
    return `${formatModel(event.model)} finished ${formatPhase(event.phase)}${elapsed ? ` in ${elapsed}` : ""}`;
  }

  if (event.type === "model_start" && event.model && event.phase) {
    return `${formatModel(event.model)} started ${formatPhase(event.phase)}`;
  }

  if (event.type === "model_done" && event.model && typeof event.turnNumber === "number") {
    const elapsed = formatElapsed(event.elapsedMs);
    return `${formatModel(event.model)} finished debate turn ${event.turnNumber}${elapsed ? ` in ${elapsed}` : ""}`;
  }

  if (event.type === "model_start" && event.model && typeof event.turnNumber === "number") {
    return `${formatModel(event.model)} started debate turn ${event.turnNumber}`;
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
