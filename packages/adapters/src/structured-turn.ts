import { modelTurnSchema, type ModelTurn } from "@council/core";

const providerTurnSchema = modelTurnSchema.omit({
  actor: true,
  degraded: true
}).partial({
  newInsights: true,
  assumptions: true,
  disagreements: true,
  questionsForPeer: true,
  questionsForHuman: true,
  proposedSpecDelta: true,
  milestoneReached: true,
  implementationPlan: true,
  proposedQuestions: true,
  synthesizedQuestions: true,
  followUpQuestions: true,
  sufficientContext: true,
  walkthroughGaps: true
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

export function detectProviderFailureText(rawValue: unknown): string | null {
  const rawText = toRawString(rawValue).trim();
  if (!rawText) return null;

  if (/^Failed to authenticate\./i.test(rawText)) {
    return rawText;
  }

  if (
    /^\{"type":"error","error":\{"type":"authentication_error"/i.test(rawText) ||
    (/Invalid authentication credentials/i.test(rawText) && /request_id/i.test(rawText))
  ) {
    return rawText;
  }

  return null;
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

  const turn: Record<string, unknown> = {
    rawText: validated.data.rawText,
    summary: validated.data.summary,
    newInsights: validated.data.newInsights ?? [],
    assumptions: validated.data.assumptions ?? [],
    questionsForPeer: validated.data.questionsForPeer ?? [],
    actor,
    degraded: false
  };

  const controlFields = [
    "disagreements",
    "questionsForHuman",
    "proposedSpecDelta",
    "milestoneReached",
    "implementationPlan",
    "proposedQuestions",
    "synthesizedQuestions",
    "followUpQuestions",
    "sufficientContext",
    "walkthroughGaps"
  ] as const;

  for (const field of controlFields) {
    if (Object.prototype.hasOwnProperty.call(validated.data, field)) {
      turn[field] = validated.data[field];
    }
  }

  return turn as ModelTurn;
}
