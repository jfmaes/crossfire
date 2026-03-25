import { modelTurnSchema, type ModelTurn } from "@council/core";

const providerTurnSchema = modelTurnSchema.omit({
  actor: true,
  degraded: true
});

function toRawString(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createDegradedTurn(actor: "gpt" | "claude", rawValue: unknown): ModelTurn {
  const rawText = toRawString(rawValue);

  return {
    actor,
    rawText,
    summary: rawText,
    newInsights: [],
    assumptions: [],
    disagreements: [],
    questionsForPeer: [],
    questionsForHuman: [],
    proposedSpecDelta: "",
    milestoneReached: null,
    implementationPlan: null,
    proposedQuestions: null,
    synthesizedQuestions: null,
    followUpQuestions: null,
    sufficientContext: null,
    walkthroughGaps: null,
    degraded: true
  };
}

function stripCodeFences(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return match ? match[1].trim() : text;
}

export function parseStructuredTurn(actor: "gpt" | "claude", rawValue: unknown): ModelTurn {
  let parsedJson: unknown = rawValue;

  if (typeof rawValue === "string") {
    const cleaned = stripCodeFences(rawValue.trim());
    try {
      parsedJson = JSON.parse(cleaned);
    } catch {
      return createDegradedTurn(actor, rawValue);
    }
  }

  const validated = providerTurnSchema.safeParse(parsedJson);

  if (!validated.success) {
    return createDegradedTurn(actor, rawValue);
  }

  return {
    ...validated.data,
    actor,
    degraded: false
  };
}
