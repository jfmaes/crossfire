import type { SessionPhase } from "../contracts/session";

const PHASE_ORDER: SessionPhase[] = [
  "analysis",
  "interview",
  "approach_debate",
  "spec_generation"
];

export function nextPhase(current: SessionPhase): SessionPhase | null {
  const index = PHASE_ORDER.indexOf(current);
  if (index === -1 || index === PHASE_ORDER.length - 1) {
    return null;
  }
  return PHASE_ORDER[index + 1];
}

export function phaseRequiresHumanInput(phase: SessionPhase): boolean {
  return phase === "interview";
}

export function phaseIndex(phase: SessionPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export const PHASE_COUNT = PHASE_ORDER.length;
