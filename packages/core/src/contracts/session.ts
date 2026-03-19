import { z } from "zod";

export const actorSchema = z.enum(["human", "gpt", "claude", "system"]);
export const milestoneReachedSchema = z.enum([
  "requirements_clarified",
  "architecture_selected",
  "implementation_plan_ready"
]);

export const sessionStatusSchema = z.enum([
  "draft",
  "grounding",
  "debating",
  "checkpoint",
  "waiting_for_human",
  "interviewing",
  "finalized",
  "errored"
]);

export const sessionPhaseSchema = z.enum([
  "analysis",
  "interview",
  "approach_debate",
  "spec_generation"
]);

export const interviewQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  priority: z.number(),
  rationale: z.string(),
  proposedBy: z.enum(["gpt", "claude", "synthesized"]),
  answer: z.string().nullable()
});

export const modelTurnSchema = z.object({
  actor: z.enum(["gpt", "claude"]),
  rawText: z.string(),
  summary: z.string(),
  newInsights: z.array(z.string()),
  assumptions: z.array(z.string()),
  disagreements: z.array(z.string()),
  questionsForPeer: z.array(z.string()),
  questionsForHuman: z.array(z.string()),
  proposedSpecDelta: z.string(),
  milestoneReached: milestoneReachedSchema.nullable(),
  degraded: z.boolean()
});

export const checkpointSummarySchema = z.object({
  currentUnderstanding: z.string(),
  recommendation: z.string(),
  changedSinceLastCheckpoint: z.array(z.string()),
  openRisks: z.array(z.string()),
  decisionsNeeded: z.array(z.string())
});

export type ModelTurn = z.infer<typeof modelTurnSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;
export type InterviewQuestion = z.infer<typeof interviewQuestionSchema>;
