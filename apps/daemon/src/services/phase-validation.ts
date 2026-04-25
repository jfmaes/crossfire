type PhaseValidationPhase =
  | "analysis"
  | "analysis_debate"
  | "approach_debate"
  | "spec_generation"
  | "walkthrough";

type RequiredPhaseField =
  | "rawText"
  | "summary"
  | "disagreements"
  | "questionsForHuman"
  | "proposedSpecDelta"
  | "milestoneReached"
  | "implementationPlan"
  | "proposedQuestions"
  | "synthesizedQuestions"
  | "walkthroughGaps";

const REQUIRED_FIELDS_BY_PHASE: Record<PhaseValidationPhase, readonly RequiredPhaseField[]> = {
  analysis: ["rawText", "summary", "proposedQuestions", "questionsForHuman"],
  analysis_debate: ["rawText", "summary", "disagreements", "questionsForHuman", "synthesizedQuestions"],
  approach_debate: ["rawText", "summary", "disagreements", "questionsForHuman", "proposedSpecDelta", "milestoneReached"],
  spec_generation: ["rawText", "summary", "proposedSpecDelta", "implementationPlan", "milestoneReached"],
  walkthrough: ["rawText", "summary", "walkthroughGaps"]
};

export interface PhaseValidationResult {
  ok: boolean;
  phase: PhaseValidationPhase;
  requiredFields: readonly RequiredPhaseField[];
  missingFields: RequiredPhaseField[];
}

export function getRequiredFieldsForPhase(phase: PhaseValidationPhase): readonly RequiredPhaseField[] {
  return REQUIRED_FIELDS_BY_PHASE[phase];
}

export function validatePhaseTurn(
  phase: PhaseValidationPhase,
  parsed: Record<string, unknown> | null
): PhaseValidationResult {
  const requiredFields = getRequiredFieldsForPhase(phase);
  const missingFields = !parsed
    ? [...requiredFields]
    : requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(parsed, field));

  return {
    ok: missingFields.length === 0,
    phase,
    requiredFields,
    missingFields
  };
}

export type { PhaseValidationPhase, RequiredPhaseField };
