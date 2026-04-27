import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "@council/adapters";
import {
  buildAnalysisPrompt,
  buildFeedbackDigestPrompt,
  buildQuestionDebatePrompt,
  buildSpecRevisionPrompt,
  buildSpecPrompt,
  buildWalkthroughPrompt
} from "@council/adapters";
import { emitProgress, summarizeProgressText } from "./progress";
import { createOrchestrator } from "./orchestrator";
import { debugLogPrompt, debugLogResponse } from "./debug-log";
import { validatePhaseTurn, type PhaseValidationPhase } from "./phase-validation";
import {
  buildRevisionBudgetLedger,
  chunkFeedback,
  selectFeedbackExcerpts,
  type FeedbackChunk
} from "./revision-feedback";

interface PhaseOrchestratorInput {
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
}

interface ProposedQuestion {
  text: string;
  priority: number;
  rationale: string;
  context?: string | null;
  recommendation?: string | null;
  recommendationReasoning?: string | null;
}

interface AnalysisResult {
  gptAnalysis: string;
  claudeAnalysis: string;
  proposedQuestions: Array<ProposedQuestion & { proposedBy: "gpt" | "claude" }>;
  trace: {
    gpt: TurnTrace;
    claude: TurnTrace;
  };
}

interface QuestionDebateResult {
  synthesizedQuestions: Array<ProposedQuestion & {
    id: string;
    proposedBy: "synthesized";
  }>;
  debateSummary: string;
  turns: QuestionDebateTurn[];
  trace: DebateTrace & {
    clarificationRequested: boolean;
    finalQuestionCount: number;
    turnTraces: TurnTrace[];
  };
}

interface ApproachDebateResult {
  convergedApproach: string;
  finalApproachHandoff: string;
  turns: Array<{
    actor: "gpt" | "claude";
    summary: string;
    disagreements: string[];
    rawText: string;
    proposedSpecDelta: string;
  }>;
  questionsForHuman: string[];
  trace: DebateTrace;
}

interface WalkthroughGap {
  location: string;
  issue: string;
  fix: string;
}

interface RevisionInputShapingTrace {
  applied: boolean;
  trigger: "none" | "soft_budget" | "hard_budget";
  budgetChars: number | null;
  originalChars: number;
  finalChars: number;
  gapReportSynthesized: boolean;
  specCompacted: boolean;
  planCompacted: boolean;
  specSectionsCompacted: string[];
  planSectionsCompacted: string[];
}

interface SpecGenerationResult {
  spec: string;
  implementationPlan: string;
  summary: string;
  walkthroughGaps?: WalkthroughGap[];
  trace: {
    draft: TurnTrace;
    review: TurnTrace;
    gptWalkthrough: TurnTrace;
    claudeWalkthrough: TurnTrace;
    gapSynthesis?: TurnTrace;
    revision?: TurnTrace;
    revisedAfterWalkthrough: boolean;
    revisionInputSynthesized: boolean;
    revisionInputShaping: RevisionInputShapingTrace;
    gapCount: number;
    freshContext: {
      draft: boolean;
      review: boolean;
      walkthrough: boolean;
      revision: boolean;
    };
    canonicalHandoffUsed: boolean;
    canonicalApproachHandoff: boolean;
    usedCanonicalApproachHandoff: boolean;
    authorityPathUncompressed: boolean;
    authorityPathUncompacted: boolean;
    degradedOutputRetry: {
      attempted: boolean;
      reason: "degraded_structured_output" | null;
      succeeded: boolean;
    };
    compaction: {
      approachResult: boolean;
      peerDraft: boolean;
      revisionPeerDraft: boolean;
    };
  };
}

interface SpecRevisionResult {
  spec: string;
  implementationPlan: string;
  summary: string;
  blockedReason?: "feedback_input_too_large";
  revisionRequest: {
    feedbackChunks: Array<Record<string, unknown>>;
    feedbackDigest: Record<string, unknown> | null;
    budgetLedger: Record<string, unknown>;
  };
  trace: {
    feedbackDigest?: TurnTrace;
    revision?: TurnTrace;
  };
}

interface DebateTrace {
  stopReason: "consensus" | "questions_for_human" | "max_turns";
  totalTurns: number;
  turnsUsed: number;
  maxTurns: number;
  finalDisagreementCount: number;
  finalDisagreements: string[];
}

interface QuestionDebateTurn {
  actor: "gpt" | "claude";
  summary: string;
  disagreements: string[];
  questionsForHuman: string[];
  rawText: string;
  synthesizedQuestions: ProposedQuestion[];
}

interface PromptLedgerEntry {
  name: string;
  originalChars: number;
  finalChars: number;
  compacted: boolean;
  omitted: boolean;
  viaConversationReuse: boolean;
}

interface CompactionMetadata {
  component: string;
  originalChars: number;
  finalChars: number;
  sectionsCompacted: string[];
}

interface TurnTrace {
  outputStatus: "ok" | "degraded" | "phase_invalid";
  missingFields: string[];
  conversationReused: boolean;
  promptLedger: PromptLedgerEntry[];
}

export interface SpecGenerationFailureDiagnostics {
  phase: "spec_generation";
  provider: "claude";
  substep: "revision";
  outputStatus: "degraded" | "phase_invalid";
  missingFields: string[];
  degradedOutputRetry?: {
    attempted: boolean;
    reason: "degraded_structured_output";
    succeeded: boolean;
  };
  rawResponsePreview: string;
  promptLedgerSizes: {
    originalProblem: number;
    interviewResults: number;
    finalApproachHandoff: number;
    revisionPeerDraft: number;
  };
  revisionPeerDraftChars: number;
}

export class SpecGenerationDiagnosticsError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: SpecGenerationFailureDiagnostics
  ) {
    super(message);
    this.name = "SpecGenerationDiagnosticsError";
  }
}

interface InvalidTurnOutputDetails {
  model: "gpt" | "claude";
  phase: PhaseValidationPhase;
  outputStatus: TurnTrace["outputStatus"];
  missingFields: string[];
  conversationReused: boolean;
  promptLedger: PromptLedgerEntry[];
  rawText: string;
  rawResponse: string;
  parsed: Record<string, unknown> | null;
}

class AuthorityInputTooLargeError extends Error {
  constructor(
    public readonly code: "spec_generation_input_too_large" | "revision_input_too_large",
    public readonly component: string,
    public readonly actualChars: number,
    public readonly budgetChars: number
  ) {
    super(`${code}: ${component} is ${actualChars} chars (budget ${budgetChars})`);
    this.name = "AuthorityInputTooLargeError";
  }
}

const FINAL_APPROACH_HANDOFF_BUDGET_CHARS = 100_000;
const SPEC_GENERATION_DRAFT_BUDGET_CHARS = 250_000;
const REVISION_INPUT_BUDGET_CHARS = 250_000;
const CLAUDE_REVISION_SOFT_BUDGET_CHARS = 45_000;
const RAW_RESPONSE_PREVIEW_MAX_CHARS = 1_200;
const SPEC_GENERATION_RECOVERY_INSTRUCTION = [
  "Recovery retry: previous response was rejected because it was not a valid raw JSON object.",
  "do not explain.",
  "output one raw JSON object only."
].join("\n");

function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON from markdown code blocks or mixed text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toStructuredRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function collectTurnOutput(
  provider: ProviderAdapter,
  input: {
    sessionId: string;
    runId?: string;
    prompt: string;
    phase: PhaseValidationPhase;
    promptLedger?: PromptLedgerEntry[];
    invalidOutputErrorFactory?: (details: InvalidTurnOutputDetails) => Error;
  }
): Promise<{ rawText: string; parsed: Record<string, unknown> | null; trace: TurnTrace }> {
  const model = provider.name as "gpt" | "claude";
  const startTime = Date.now();
  emitProgress({
    sessionId: input.sessionId, runId: input.runId, type: "model_start", model,
    phase: input.phase, message: `Sending ${input.phase} prompt...`
  });

  debugLogPrompt({
    sessionId: input.sessionId,
    phase: input.phase,
    model,
    prompt: input.prompt
  });

  let rawText = "";
  let parsed: Record<string, unknown> | null = null;
  let providerError: string | null = null;
  let conversationReused = false;
  let rawResponse = "";

  for await (const event of provider.sendTurn({
    sessionId: input.sessionId,
    prompt: input.prompt,
    phase: input.phase
  })) {
    if (event.type === "stderr") {
      emitProgress({
        sessionId: input.sessionId,
        runId: input.runId,
        type: "model_stream",
        model,
        phase: input.phase,
        message: summarizeProgressText(event.text)
      });
      continue;
    }

    if (event.type === "progress") {
      emitProgress({
        sessionId: input.sessionId,
        runId: input.runId,
        type: "model_progress",
        model,
        phase: input.phase,
        message: summarizeProgressText(event.text)
      });
      continue;
    }

    if (event.type === "error") {
      providerError = event.message;
      continue;
    }

    if (event.type === "structured_turn") {
      rawResponse = event.rawResponse;
      conversationReused = event.conversationReused ?? false;
      rawText = event.turn.rawText || event.turn.summary;
      parsed = { ...event.turn };

      // For degraded turns, rawText contains the full model JSON response.
      // Re-parse it to extract phase-specific fields (proposedQuestions, etc.)
      // and the actual text content.
      if (event.turn.degraded) {
        const fullResponse = extractJsonFromText(rawText);
        if (fullResponse) {
          parsed = { ...parsed, ...fullResponse };
          // Use the inner rawText if available (the actual analysis text, not the JSON wrapper)
          if (typeof fullResponse.rawText === "string") {
            rawText = fullResponse.rawText;
            parsed.rawText = fullResponse.rawText;
          }
        }
      }
    }
  }

  // If we didn't get a structured turn, the raw output might still have JSON
  if (!parsed && rawText) {
    parsed = extractJsonFromText(rawText);
  }

  const elapsedMs = Date.now() - startTime;
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const chars = rawText.length;

  if (providerError || (!parsed && chars === 0)) {
    const errorMessage = providerError ?? `${model.toUpperCase()} returned no output`;
    emitProgress({
      sessionId: input.sessionId,
      runId: input.runId,
      type: "info",
      model,
      phase: input.phase,
      elapsedMs,
      metadata: {
        outputStatus: "provider_error",
        conversationReused,
        promptLedger: input.promptLedger ?? []
      },
      message: `Failed in ${elapsed}s — ${errorMessage}`
    });

    debugLogResponse({
      sessionId: input.sessionId,
      phase: input.phase,
      model,
      rawText,
      parsed: { error: errorMessage },
      elapsedMs
    });

    throw new Error(`${model.toUpperCase()} ${input.phase} failed: ${errorMessage}`);
  }

  const validation = validatePhaseTurn(
    input.phase,
    rawResponse ? extractJsonFromText(rawResponse) : toStructuredRecord(parsed)
  );
  const missingFields = validation.missingFields;
  const outputStatus: TurnTrace["outputStatus"] =
    parsed?.degraded ? "degraded"
    : missingFields.length > 0 ? "phase_invalid"
    : "ok";

  const degraded = outputStatus === "degraded" ? " (degraded)" : outputStatus === "phase_invalid" ? " (phase-invalid)" : "";
  emitProgress({
    sessionId: input.sessionId, runId: input.runId, type: "model_done", model,
    phase: input.phase, elapsedMs,
    metadata: {
      outputStatus,
      missingFields,
      conversationReused,
      promptLedger: input.promptLedger ?? []
    },
    message: `Done in ${elapsed}s — ${chars} chars${degraded}`
  });

  debugLogResponse({
    sessionId: input.sessionId,
    phase: input.phase,
    model,
    rawText,
    parsed,
    elapsedMs
  });

  if (outputStatus !== "ok") {
    const details: InvalidTurnOutputDetails = {
      model,
      phase: input.phase,
      outputStatus,
      missingFields,
      conversationReused,
      promptLedger: input.promptLedger ?? [],
      rawText,
      rawResponse,
      parsed
    };
    throw input.invalidOutputErrorFactory?.(details)
      ?? new Error(buildInvalidTurnOutputMessage(details));
  }

  return {
    rawText,
    parsed,
    trace: {
      outputStatus,
      missingFields,
      conversationReused,
      promptLedger: input.promptLedger ?? []
    }
  };
}

export function createPhaseOrchestrator(input: PhaseOrchestratorInput) {
  const classicOrchestrator = createOrchestrator({
    gpt: input.gpt,
    claude: input.claude
  });

  return {
    async runDualAnalysis(
      sessionId: string,
      prompt: string,
      runId?: string,
      mode?: "new_spec" | "existing_spec"
    ): Promise<AnalysisResult> {
      emitProgress({ sessionId, runId, type: "phase_start", phase: "analysis", message: "Phase 1: Dual Analysis (GPT + Claude in parallel)" });
      const gptPrompt = buildAnalysisPrompt({ role: "gpt", originalProblem: prompt, mode });
      const claudePrompt = buildAnalysisPrompt({ role: "claude", originalProblem: prompt, mode });
      const analysisLedger = [
        makePromptLedgerEntry("originalProblem", prompt)
      ];

      const [gptResult, claudeResult] = await Promise.all([
        collectTurnOutput(input.gpt, {
          sessionId, runId, prompt: gptPrompt, phase: "analysis",
          promptLedger: analysisLedger
        }),
        collectTurnOutput(input.claude, {
          sessionId, runId, prompt: claudePrompt, phase: "analysis",
          promptLedger: analysisLedger
        })
      ]);

      const gptQuestions: Array<ProposedQuestion & { proposedBy: "gpt" }> =
        extractProposedQuestions(gptResult.parsed, "gpt");
      const claudeQuestions: Array<ProposedQuestion & { proposedBy: "claude" }> =
        extractProposedQuestions(claudeResult.parsed, "claude");

      // Deduplicate by combining both lists
      const allQuestions = [...gptQuestions, ...claudeQuestions];
      const deduplicated = deduplicateQuestions(allQuestions);

      return {
        gptAnalysis: gptResult.rawText || (gptResult.parsed?.rawText as string) || "Analysis unavailable",
        claudeAnalysis: claudeResult.rawText || (claudeResult.parsed?.rawText as string) || "Analysis unavailable",
        proposedQuestions: deduplicated,
        trace: {
          gpt: gptResult.trace,
          claude: claudeResult.trace
        }
      };
    },

    async runQuestionDebate(
      sessionId: string,
      prompt: string,
      gptAnalysis: string,
      claudeAnalysis: string,
      questions: Array<ProposedQuestion & { proposedBy: string }>,
      runId?: string
    ): Promise<QuestionDebateResult> {
      const maxTurns = 4;
      emitProgress({
        sessionId,
        runId,
        type: "phase_start",
        phase: "analysis_debate",
        message: `Question Debate (${questions.length} proposed — up to ${maxTurns} turns)`
      });

      const providers: Array<{ role: "gpt" | "claude"; provider: ProviderAdapter }> = [
        { role: "gpt", provider: input.gpt },
        { role: "claude", provider: input.claude }
      ];

      const turns: QuestionDebateTurn[] = [];
      const turnTraces: TurnTrace[] = [];
      let peerResponse: string | undefined;
      let currentQuestions = deduplicateQuestions(questions.map((question) => ({
        text: question.text,
        priority: question.priority,
        rationale: question.rationale,
        context: question.context ?? null,
        recommendation: question.recommendation ?? null,
        recommendationReasoning: question.recommendationReasoning ?? null
      })));
      let stopReason: DebateTrace["stopReason"] = "max_turns";

      for (let i = 0; i < maxTurns; i++) {
        const { role, provider } = providers[i % 2];
        const debatePrompt = buildQuestionDebatePrompt({
          role,
          originalProblem: prompt,
          gptAnalysis,
          claudeAnalysis,
          allQuestions: currentQuestions.map((question) => ({
            ...question,
            proposedBy: "current_list"
          })),
          peerResponse,
          turnNumber: i + 1,
          totalTurns: maxTurns
        });

        const promptLedger = [
          makePromptLedgerEntry("originalProblem", prompt),
          makePromptLedgerEntry("gptAnalysis", gptAnalysis),
          makePromptLedgerEntry("claudeAnalysis", claudeAnalysis),
          makePromptLedgerEntry(
            "currentQuestions",
            currentQuestions.map((question) => [
              `${question.priority}. ${question.text}`,
              question.rationale,
              question.context ?? "",
              question.recommendation ?? "",
              question.recommendationReasoning ?? ""
            ].filter(Boolean).join("\n")).join("\n\n")
          ),
          ...(peerResponse ? [makePromptLedgerEntry("peerResponse", peerResponse)] : [])
        ];

        const result = await collectTurnOutput(provider, {
          sessionId,
          runId,
          prompt: debatePrompt,
          phase: "analysis_debate",
          promptLedger
        });

        const synthesizedQuestions = deduplicateQuestions(
          extractSynthesizedQuestions(result.parsed).map((question) => ({
            text: question.text,
            priority: question.priority,
            rationale: question.rationale,
            context: question.context ?? null,
            recommendation: question.recommendation ?? null,
            recommendationReasoning: question.recommendationReasoning ?? null
          }))
        );
        const questionsForHuman = extractStringList(result.parsed, "questionsForHuman");
        const disagreements = extractStringList(result.parsed, "disagreements");
        const turn: QuestionDebateTurn = {
          actor: role,
          summary: (result.parsed?.summary as string) || result.rawText,
          disagreements,
          questionsForHuman,
          rawText: result.rawText,
          synthesizedQuestions
        };

        turns.push(turn);
        turnTraces.push(result.trace);

        if (synthesizedQuestions.length > 0) {
          currentQuestions = synthesizedQuestions;
        }

        peerResponse = buildQuestionDebatePeerResponse(turn);

        if (questionsForHuman.length > 0) {
          stopReason = "questions_for_human";
          break;
        }

        if (hasReachedQuestionConsensus(turns)) {
          stopReason = "consensus";
          break;
        }
      }

      const finalTurns = turns.slice(-2);
      const finalDisagreements = collectFinalDisagreements(finalTurns);
      const synthesizedQuestions = currentQuestions.map((question) => ({
        ...question,
        id: randomUUID(),
        proposedBy: "synthesized" as const
      }));
      const debateSummary = buildQuestionDebateNarrative(
        turns,
        stopReason,
        finalDisagreements,
        synthesizedQuestions
      );
      const trace = {
        stopReason,
        totalTurns: turns.length,
        turnsUsed: turns.length,
        maxTurns,
        finalDisagreementCount: finalDisagreements.length,
        finalDisagreements,
        clarificationRequested: stopReason === "questions_for_human",
        finalQuestionCount: synthesizedQuestions.length,
        turnTraces
      } satisfies QuestionDebateResult["trace"];

      emitProgress({
        sessionId,
        runId,
        type: stopReason === "consensus" ? "consensus" : "info",
        phase: "analysis_debate",
        metadata: {
          stopReason,
          totalTurns: turns.length,
          finalDisagreementCount: finalDisagreements.length,
          finalDisagreements
        },
        message:
          stopReason === "consensus"
            ? `Question debate reached consensus after ${turns.length} turn(s)`
            : stopReason === "questions_for_human"
              ? `Question debate paused for clarification after ${turns.length} turn(s)`
              : `Question debate stopped at the ${maxTurns}-turn cap`
      });

      return {
        synthesizedQuestions,
        debateSummary,
        turns,
        trace
      };
    },

    async runApproachDebate(
      sessionId: string,
      prompt: string,
      interviewResults: Array<{ question: string; answer: string }>,
      runIdOrMaxTurns?: string | number,
      maybeRunId?: string
    ): Promise<ApproachDebateResult> {
      const maxTurns = typeof runIdOrMaxTurns === "number" ? runIdOrMaxTurns : 14;
      const runId = typeof runIdOrMaxTurns === "string" ? runIdOrMaxTurns : maybeRunId;
      emitProgress({ sessionId, runId, type: "phase_start", phase: "approach_debate", message: `Approach Debate (consensus-driven, ${interviewResults.length} interview answers as context)` });
      const enrichedPrompt = [
        prompt,
        "",
        "---",
        "",
        "INTERVIEW RESULTS:",
        ...interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}\n`)
      ].join("\n");

      const round = await classicOrchestrator.runRound({
        sessionId,
        prompt: enrichedPrompt,
        maxTurns,
        runId
      });

      const turns = round.state.turns.map((t) => ({
        actor: t.actor as "gpt" | "claude",
        summary: t.summary,
        disagreements: t.disagreements,
        rawText: t.rawText,
        proposedSpecDelta: t.proposedSpecDelta
      }));

      const finalTurns = round.state.turns.slice(-2);
      const finalDisagreements = collectFinalDisagreements(finalTurns);
      const convergedApproach = buildBalancedApproachNarrative(finalTurns, round.stopReason, finalDisagreements);
      const finalApproachHandoff = buildCanonicalApproachHandoff(
        turns.slice(-2),
        round.stopReason,
        finalDisagreements
      );

      // Surface any questions the models have for the human (debate paused for clarification)
      const latestTurn = round.state.turns.at(-1);
      const questionsForHuman = latestTurn?.questionsForHuman ?? [];
      const finalDisagreementCount = finalDisagreements.length;

      return {
        convergedApproach,
        finalApproachHandoff,
        turns,
        questionsForHuman,
        trace: {
          stopReason: round.stopReason,
          totalTurns: round.state.turns.length,
          turnsUsed: round.state.turns.length,
          maxTurns,
          finalDisagreementCount,
          finalDisagreements
        }
      };
    },

    async runSpecGeneration(
      sessionId: string,
      prompt: string,
      interviewResults: Array<{ question: string; answer: string }>,
      finalApproachHandoff: string,
      runId?: string,
      mode?: "new_spec" | "existing_spec"
    ): Promise<SpecGenerationResult> {
      // Step 1: GPT drafts, Claude reviews — sequential so Claude can critique GPT's work.
      emitProgress({ sessionId, runId, type: "phase_start", phase: "spec_generation", message: "Spec Generation (GPT drafts → Claude reviews → both walkthrough → Claude revises)" });
      ensureAuthorityInputFits({
        sessionId,
        runId,
        phase: "spec_generation",
        component: "finalApproachHandoff",
        text: finalApproachHandoff,
        budgetChars: FINAL_APPROACH_HANDOFF_BUDGET_CHARS,
        errorCode: "spec_generation_input_too_large"
      });
      const approachLedgerEntry = makePromptLedgerEntry("finalApproachHandoff", finalApproachHandoff);

      const draftPrompt = buildSpecPrompt({
        role: "gpt",
        originalProblem: prompt,
        interviewResults,
        approachResult: finalApproachHandoff,
        mode
      });
      const draftLedger = [
        makePromptLedgerEntry("originalProblem", prompt),
        makePromptLedgerEntry("interviewResults", interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")),
        approachLedgerEntry
      ];

      const draftResult = await collectTurnOutput(input.gpt, {
        sessionId,
        runId,
        prompt: draftPrompt,
        phase: "spec_generation",
        promptLedger: draftLedger
      });

      const draftSpec =
        (draftResult.parsed?.proposedSpecDelta as string) ||
        (draftResult.parsed?.rawText as string) ||
        draftResult.rawText ||
        "Spec draft unavailable";

      const draftPlan = (draftResult.parsed?.implementationPlan as string) || "";

      // Step 2: Claude reviews GPT's draft — the adversarial document review
      const peerDraft = draftPlan
        ? `${draftSpec}\n\n---\n\nIMPLEMENTATION PLAN:\n${draftPlan}`
        : draftSpec;
      ensureAuthorityInputFits({
        sessionId,
        runId,
        phase: "spec_generation",
        component: "peerDraft",
        text: peerDraft,
        budgetChars: SPEC_GENERATION_DRAFT_BUDGET_CHARS,
        errorCode: "spec_generation_input_too_large"
      });
      const peerDraftLedgerEntry = makePromptLedgerEntry("peerDraft", peerDraft);

      const reviewPrompt = buildSpecPrompt({
        role: "claude",
        originalProblem: prompt,
        interviewResults,
        approachResult: finalApproachHandoff,
        peerDraft,
        mode
      });
      const reviewLedger = [
        makePromptLedgerEntry("originalProblem", prompt),
        makePromptLedgerEntry("interviewResults", interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")),
        approachLedgerEntry,
        peerDraftLedgerEntry
      ];

      const reviewResult = await collectTurnOutput(input.claude, {
        sessionId,
        runId,
        prompt: reviewPrompt,
        phase: "spec_generation",
        promptLedger: reviewLedger
      });

      const reviewedSpec =
        (reviewResult.parsed?.proposedSpecDelta as string) ||
        (reviewResult.parsed?.rawText as string) ||
        reviewResult.rawText ||
        draftSpec;

      const reviewedPlan =
        (reviewResult.parsed?.implementationPlan as string) ||
        (draftResult.parsed?.implementationPlan as string) ||
        "";

      // Step 3: Adversarial walkthrough — both models simulate executing the spec
      // in parallel, surfacing operational gaps that document review misses.
      emitProgress({ sessionId, runId, type: "info", phase: "spec_generation", message: "Adversarial Walkthrough (both models simulate execution in parallel)" });

      const [gptWalkthrough, claudeWalkthrough] = await Promise.all([
        collectTurnOutput(input.gpt, {
          sessionId,
          runId,
          prompt: buildWalkthroughPrompt({
            role: "gpt",
            originalProblem: prompt,
            spec: reviewedSpec,
            implementationPlan: reviewedPlan
          }),
          phase: "walkthrough",
          promptLedger: [
            makePromptLedgerEntry("originalProblem", prompt),
            makePromptLedgerEntry("spec", reviewedSpec),
            makePromptLedgerEntry("implementationPlan", reviewedPlan)
          ]
        }),
        collectTurnOutput(input.claude, {
          sessionId,
          runId,
          prompt: buildWalkthroughPrompt({
            role: "claude",
            originalProblem: prompt,
            spec: reviewedSpec,
            implementationPlan: reviewedPlan
          }),
          phase: "walkthrough",
          promptLedger: [
            makePromptLedgerEntry("originalProblem", prompt),
            makePromptLedgerEntry("spec", reviewedSpec),
            makePromptLedgerEntry("implementationPlan", reviewedPlan)
          ]
        })
      ]);

      // Collect gaps from both walkthroughs
      const gptGaps = extractWalkthroughGaps(gptWalkthrough.parsed);
      const claudeGaps = extractWalkthroughGaps(claudeWalkthrough.parsed);
      const allGaps = deduplicateGaps([...gptGaps, ...claudeGaps]);

      // Step 4: If gaps were found, Claude revises the spec incorporating the fixes
      let finalSpec = reviewedSpec;
      let implementationPlan = reviewedPlan;
      let summary = (reviewResult.parsed?.summary as string) || "Spec and implementation plan generated";
      let revisionTrace: TurnTrace | undefined;
      let gapSynthesisTrace: TurnTrace | undefined;
      let revisionInputSynthesized = false;
      let revisionInputShaping = createRevisionInputShapingTrace();
      const degradedOutputRetry: SpecGenerationResult["trace"]["degradedOutputRetry"] = {
        attempted: false,
        reason: null,
        succeeded: false
      };

      if (allGaps.length > 0) {
        emitProgress({ sessionId, runId, type: "info", phase: "spec_generation", message: `${allGaps.length} operational gap(s) found — Claude revising spec` });

        const gapReport = formatWalkthroughGapReport(allGaps);
        let revisionGapReport = gapReport;
        let revisionPeerDraft = buildRevisionPeerDraft({
          reviewedSpec,
          reviewedPlan,
          gapReport: revisionGapReport,
          synthesized: false
        });
        revisionInputShaping = createRevisionInputShapingTrace(revisionPeerDraft.length);

        if (revisionPeerDraft.length > REVISION_INPUT_BUDGET_CHARS) {
          emitProgress({
            sessionId,
            runId,
            type: "info",
            phase: "gap_synthesis",
            metadata: {
              authorityInput: {
                component: "revisionPeerDraft",
                actualChars: revisionPeerDraft.length,
                budgetChars: REVISION_INPUT_BUDGET_CHARS
              },
              gapSynthesis: {
                originalGapCount: allGaps.length,
                originalChars: gapReport.length
              }
            },
            message: `revision input exceeds ${REVISION_INPUT_BUDGET_CHARS} chars; synthesizing walkthrough gaps`
          });

          const synthesisPrompt = buildGapSynthesisPrompt({
            originalProblem: prompt,
            gaps: allGaps
          });
          const synthesisResult = await collectTurnOutput(input.claude, {
            sessionId,
            runId,
            prompt: synthesisPrompt,
            phase: "gap_synthesis",
            promptLedger: [
              makePromptLedgerEntry("originalProblem", prompt),
              makePromptLedgerEntry("walkthroughGaps", gapReport)
            ]
          });
          gapSynthesisTrace = synthesisResult.trace;
          const synthesizedGapReport = extractGapSynthesisBrief(synthesisResult, gapReport);
          revisionGapReport = synthesizedGapReport;
          revisionPeerDraft = buildRevisionPeerDraft({
            reviewedSpec,
            reviewedPlan,
            gapReport: revisionGapReport,
            synthesized: true
          });
          revisionInputSynthesized = true;
          revisionInputShaping = {
            ...revisionInputShaping,
            applied: true,
            trigger: "hard_budget",
            budgetChars: REVISION_INPUT_BUDGET_CHARS,
            gapReportSynthesized: true,
            finalChars: revisionPeerDraft.length
          };

          emitProgress({
            sessionId,
            runId,
            type: "info",
            phase: "gap_synthesis",
            metadata: {
              gapSynthesis: {
                originalGapCount: allGaps.length,
                originalChars: gapReport.length,
                finalChars: synthesizedGapReport.length
              }
            },
            message: `Synthesized ${allGaps.length} walkthrough gap(s) into ${synthesizedGapReport.length} chars`
          });
        }

        if (revisionPeerDraft.length > CLAUDE_REVISION_SOFT_BUDGET_CHARS) {
          const compactedRevisionInput = compactClaudeRevisionAuthorityDraft({
            reviewedSpec,
            reviewedPlan,
            gapReport: revisionGapReport,
            synthesized: revisionInputShaping.gapReportSynthesized,
            budgetChars: CLAUDE_REVISION_SOFT_BUDGET_CHARS
          });

          if (compactedRevisionInput.applied) {
            revisionPeerDraft = compactedRevisionInput.revisionPeerDraft;
            revisionInputSynthesized = true;
            revisionInputShaping = {
              ...revisionInputShaping,
              applied: true,
              trigger: revisionInputShaping.trigger === "hard_budget" ? "hard_budget" : "soft_budget",
              budgetChars: revisionInputShaping.trigger === "hard_budget"
                ? REVISION_INPUT_BUDGET_CHARS
                : CLAUDE_REVISION_SOFT_BUDGET_CHARS,
              finalChars: revisionPeerDraft.length,
              specCompacted: compactedRevisionInput.specCompacted,
              planCompacted: compactedRevisionInput.planCompacted,
              specSectionsCompacted: compactedRevisionInput.specSectionsCompacted,
              planSectionsCompacted: compactedRevisionInput.planSectionsCompacted
            };

            emitProgress({
              sessionId,
              runId,
              type: "info",
              phase: "spec_generation",
              metadata: {
                revisionInputShaping
              },
              message: `Claude revision input exceeded the ${CLAUDE_REVISION_SOFT_BUDGET_CHARS}-char soft budget; compacted authority-path drafts before revision`
            });
          }
        }

        ensureAuthorityInputFits({
          sessionId,
          runId,
          phase: "spec_generation",
          component: "revisionPeerDraft",
          text: revisionPeerDraft,
          budgetChars: REVISION_INPUT_BUDGET_CHARS,
          errorCode: "revision_input_too_large"
        });
        const revisionPeerDraftLedgerEntry = makePromptLedgerEntry("revisionPeerDraft", revisionPeerDraft);

        const revisionPrompt = buildSpecPrompt({
          role: "claude",
          originalProblem: prompt,
          interviewResults,
          approachResult: finalApproachHandoff,
          peerDraft: revisionPeerDraft,
          mode
        });
        const revisionPromptLedger = [
          makePromptLedgerEntry("originalProblem", prompt),
          makePromptLedgerEntry("interviewResults", interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")),
          approachLedgerEntry,
          revisionPeerDraftLedgerEntry
        ];

        const collectRevisionResult = (revisionAttemptPrompt: string) => collectTurnOutput(input.claude, {
          sessionId,
          runId,
          prompt: revisionAttemptPrompt,
          phase: "spec_generation",
          promptLedger: revisionPromptLedger,
          invalidOutputErrorFactory: (details) => {
            const shouldAttachDiagnostics =
              details.outputStatus === "degraded"
              || (details.outputStatus === "phase_invalid" && degradedOutputRetry.attempted);

            if (!shouldAttachDiagnostics) {
              return new Error(buildInvalidTurnOutputMessage(details));
            }

            const outputStatus = details.outputStatus === "degraded"
              ? "degraded"
              : "phase_invalid";
            const diagnostics = buildSpecGenerationFailureDiagnostics({
              outputStatus,
              promptLedger: revisionPromptLedger,
              rawResponse: details.rawResponse || details.rawText,
              missingFields: details.missingFields,
              revisionPeerDraftChars: revisionPeerDraft.length,
              degradedOutputRetry
            });

            emitProgress({
              sessionId,
              runId,
              type: "info",
              model: "claude",
              phase: "spec_generation",
              metadata: diagnostics as unknown as Record<string, unknown>,
              message: details.outputStatus === "degraded"
                ? "Claude spec revision returned degraded structured output"
                : "Claude spec revision retry returned phase-invalid structured output"
            });

            return new SpecGenerationDiagnosticsError(
              buildInvalidTurnOutputMessage(details),
              diagnostics
            );
          }
        });

        let revisionResult;
        try {
          revisionResult = await collectRevisionResult(revisionPrompt);
        } catch (error) {
          if (!isSpecGenerationDiagnosticsError(error)) {
            throw error;
          }

          degradedOutputRetry.attempted = true;
          degradedOutputRetry.reason = "degraded_structured_output";

          emitProgress({
            sessionId,
            runId,
            type: "info",
            model: "claude",
            phase: "spec_generation",
            metadata: {
              retryAttempted: true,
              retryReason: degradedOutputRetry.reason
            },
            message: "Retrying Claude spec revision once with fresh recovery instructions"
          });

          revisionResult = await collectRevisionResult(
            buildSpecGenerationRecoveryPrompt(revisionPrompt)
          );
          degradedOutputRetry.succeeded = true;
        }
        revisionTrace = revisionResult.trace;

        finalSpec =
          (revisionResult.parsed?.proposedSpecDelta as string) ||
          (revisionResult.parsed?.rawText as string) ||
          revisionResult.rawText ||
          reviewedSpec;

        implementationPlan =
          (revisionResult.parsed?.implementationPlan as string) ||
          reviewedPlan;

        summary =
          (revisionResult.parsed?.summary as string) ||
          `Spec revised after adversarial walkthrough found ${allGaps.length} operational gap(s)`;
      }

      return {
        spec: finalSpec,
        implementationPlan,
        summary,
        walkthroughGaps: allGaps,
        trace: {
          draft: draftResult.trace,
          review: reviewResult.trace,
          gptWalkthrough: gptWalkthrough.trace,
          claudeWalkthrough: claudeWalkthrough.trace,
          gapSynthesis: gapSynthesisTrace,
          revision: revisionTrace,
          revisedAfterWalkthrough: allGaps.length > 0,
          revisionInputSynthesized,
          revisionInputShaping,
          gapCount: allGaps.length,
          freshContext: {
            draft: true,
            review: true,
            walkthrough: true,
            revision: allGaps.length > 0
          },
          canonicalHandoffUsed: true,
          canonicalApproachHandoff: true,
          usedCanonicalApproachHandoff: true,
          authorityPathUncompressed: true,
          authorityPathUncompacted: !revisionInputShaping.applied,
          degradedOutputRetry,
          compaction: {
            approachResult: false,
            peerDraft: false,
            revisionPeerDraft: revisionInputShaping.applied
          }
        }
      };
    },

    async runSpecRevision(
      sessionId: string,
      revisionInput: {
        originalProblem: string;
        interviewResults: Array<{ question: string; answer: string }>;
        finalApproachHandoff: string;
        currentSpec: string;
        currentImplementationPlan: string;
        feedbackRaw: string;
        rawFeedbackBudgetChars?: number;
        excerptBudgetChars?: number;
        digestPromptBudgetChars?: number;
      },
      runId?: string
    ): Promise<SpecRevisionResult> {
      emitProgress({
        sessionId,
        runId,
        type: "phase_start",
        phase: "spec_generation",
        message: "Spec Revision (feedback digest -> exact excerpts -> Claude revision)"
      });

      const rawFeedbackBudgetChars = revisionInput.rawFeedbackBudgetChars ?? 12_000;
      const excerptBudgetChars = revisionInput.excerptBudgetChars ?? 30_000;
      const digestPromptBudgetChars = revisionInput.digestPromptBudgetChars ?? REVISION_INPUT_BUDGET_CHARS;
      const feedbackChunks = chunkFeedback(revisionInput.feedbackRaw);
      const feedbackChunkMetadata = feedbackChunks.map(toFeedbackChunkMetadata);

      let feedbackDigestText = revisionInput.feedbackRaw;
      let feedbackDigestRecord: Record<string, unknown> | null = {
        rawText: revisionInput.feedbackRaw,
        summary: "Raw feedback used directly because it fit within budget.",
        proposedSpecDelta: revisionInput.feedbackRaw,
        skipped: true
      };
      let feedbackDigestTrace: TurnTrace | undefined;
      let requestedChunkIds = feedbackChunks.map((chunk) => chunk.id);

      if (revisionInput.feedbackRaw.length > rawFeedbackBudgetChars) {
        const digestPrompt = buildFeedbackDigestPrompt({
          originalProblem: revisionInput.originalProblem,
          feedbackChunks
        });

        if (digestPrompt.length > digestPromptBudgetChars) {
          const budgetLedger = buildRevisionLedgerRecord({
            feedbackRaw: revisionInput.feedbackRaw,
            feedbackDigest: "",
            feedbackExcerpts: "",
            currentSpec: revisionInput.currentSpec,
            currentPlan: revisionInput.currentImplementationPlan
          });
          emitFeedbackRevisionBlocked({
            sessionId,
            runId,
            reason: "feedback digest prompt exceeded budget",
            metadata: {
              feedbackRawChars: revisionInput.feedbackRaw.length,
              digestPromptChars: digestPrompt.length,
              digestPromptBudgetChars
            }
          });

          return {
            spec: revisionInput.currentSpec,
            implementationPlan: revisionInput.currentImplementationPlan,
            summary: "Feedback is too large to digest safely.",
            blockedReason: "feedback_input_too_large",
            revisionRequest: {
              feedbackChunks: feedbackChunkMetadata,
              feedbackDigest: null,
              budgetLedger
            },
            trace: {}
          };
        }

        const digestResult = await collectTurnOutput(input.gpt, {
          sessionId,
          runId,
          prompt: digestPrompt,
          phase: "feedback_digest",
          promptLedger: [
            makePromptLedgerEntry("originalProblem", revisionInput.originalProblem),
            makePromptLedgerEntry("feedbackRaw", revisionInput.feedbackRaw)
          ]
        });

        feedbackDigestTrace = digestResult.trace;
        feedbackDigestRecord = digestResult.parsed;
        feedbackDigestText =
          (digestResult.parsed?.proposedSpecDelta as string) ||
          (digestResult.parsed?.rawText as string) ||
          digestResult.rawText;
        requestedChunkIds = extractFeedbackChunkIds(feedbackDigestText);

        if (requestedChunkIds.length === 0) {
          const budgetLedger = buildRevisionLedgerRecord({
            feedbackRaw: revisionInput.feedbackRaw,
            feedbackDigest: feedbackDigestText,
            feedbackExcerpts: "",
            currentSpec: revisionInput.currentSpec,
            currentPlan: revisionInput.currentImplementationPlan
          });
          emitFeedbackRevisionBlocked({
            sessionId,
            runId,
            reason: "feedback digest omitted source chunk references",
            metadata: {
              feedbackRawChars: revisionInput.feedbackRaw.length,
              feedbackDigestChars: feedbackDigestText.length
            }
          });

          return {
            spec: revisionInput.currentSpec,
            implementationPlan: revisionInput.currentImplementationPlan,
            summary: "Feedback digest did not preserve source chunk traceability.",
            blockedReason: "feedback_input_too_large",
            revisionRequest: {
              feedbackChunks: feedbackChunkMetadata,
              feedbackDigest: feedbackDigestRecord,
              budgetLedger
            },
            trace: {
              feedbackDigest: feedbackDigestTrace
            }
          };
        }
      }

      const excerptSelection = selectFeedbackExcerpts({
        chunks: feedbackChunks,
        requestedChanges: [{
          summary: "Requested changes extracted from feedback",
          sourceChunkIds: requestedChunkIds
        }],
        budgetChars: excerptBudgetChars
      });
      const feedbackExcerpts = excerptSelection.text;
      const budgetLedger = buildRevisionLedgerRecord({
        feedbackRaw: revisionInput.feedbackRaw,
        feedbackDigest: feedbackDigestText,
        feedbackExcerpts,
        currentSpec: revisionInput.currentSpec,
        currentPlan: revisionInput.currentImplementationPlan
      });

      if (excerptSelection.blocked) {
        emitFeedbackRevisionBlocked({
          sessionId,
          runId,
          reason: "feedback exact excerpts exceeded budget or referenced missing chunks",
          metadata: {
            feedbackRawChars: revisionInput.feedbackRaw.length,
            feedbackDigestChars: feedbackDigestText.length,
            feedbackExcerptsChars: feedbackExcerpts.length,
            excerptBudgetChars,
            missingChunkIds: excerptSelection.missingChunkIds
          }
        });

        return {
          spec: revisionInput.currentSpec,
          implementationPlan: revisionInput.currentImplementationPlan,
          summary: "Feedback is too large to revise safely with exact excerpts.",
          blockedReason: "feedback_input_too_large",
          revisionRequest: {
            feedbackChunks: feedbackChunkMetadata,
            feedbackDigest: feedbackDigestRecord,
            budgetLedger
          },
          trace: {
            feedbackDigest: feedbackDigestTrace
          }
        };
      }

      const revisionResult = await collectTurnOutput(input.claude, {
        sessionId,
        runId,
        prompt: buildSpecRevisionPrompt({
          originalProblem: revisionInput.originalProblem,
          interviewResults: revisionInput.interviewResults,
          approachResult: revisionInput.finalApproachHandoff,
          currentSpec: revisionInput.currentSpec,
          currentImplementationPlan: revisionInput.currentImplementationPlan,
          feedbackDigest: feedbackDigestText,
          feedbackExcerpts
        }),
        phase: "spec_generation",
        promptLedger: [
          makePromptLedgerEntry("originalProblem", revisionInput.originalProblem),
          makePromptLedgerEntry("interviewResults", revisionInput.interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")),
          makePromptLedgerEntry("finalApproachHandoff", revisionInput.finalApproachHandoff),
          makePromptLedgerEntry("currentSpec", revisionInput.currentSpec),
          makePromptLedgerEntry("currentImplementationPlan", revisionInput.currentImplementationPlan),
          makePromptLedgerEntry("feedbackDigest", feedbackDigestText),
          makePromptLedgerEntry("feedbackExcerpts", feedbackExcerpts)
        ]
      });

      return {
        spec:
          (revisionResult.parsed?.proposedSpecDelta as string) ||
          (revisionResult.parsed?.rawText as string) ||
          revisionResult.rawText ||
          revisionInput.currentSpec,
        implementationPlan:
          (revisionResult.parsed?.implementationPlan as string) ||
          revisionInput.currentImplementationPlan,
        summary:
          (revisionResult.parsed?.summary as string) ||
          "Spec and implementation plan revised from feedback",
        revisionRequest: {
          feedbackChunks: feedbackChunkMetadata,
          feedbackDigest: feedbackDigestRecord,
          budgetLedger
        },
        trace: {
          feedbackDigest: feedbackDigestTrace,
          revision: revisionResult.trace
        }
      };
    }
  };
}

export function isSpecGenerationDiagnosticsError(error: unknown): error is SpecGenerationDiagnosticsError {
  return error instanceof SpecGenerationDiagnosticsError;
}

function toFeedbackChunkMetadata(chunk: FeedbackChunk): Record<string, unknown> {
  return {
    id: chunk.id,
    index: chunk.index,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    textChars: chunk.text.length
  };
}

function extractFeedbackChunkIds(digestText: string): string[] {
  return Array.from(new Set(digestText.match(/feedback-chunk-\d+/g) ?? []));
}

function buildRevisionLedgerRecord(input: {
  feedbackRaw: string;
  feedbackDigest: string;
  feedbackExcerpts: string;
  currentSpec: string;
  currentPlan: string;
}): Record<string, unknown> {
  return { ...buildRevisionBudgetLedger(input) };
}

function emitFeedbackRevisionBlocked(input: {
  sessionId: string;
  runId?: string;
  reason: string;
  metadata?: Record<string, unknown>;
}): void {
  emitProgress({
    sessionId: input.sessionId,
    runId: input.runId,
    type: "info",
    phase: "spec_generation",
    metadata: {
      blockedReason: "feedback_input_too_large",
      ...input.metadata
    },
    message: `feedback input too large: ${input.reason}`
  });
}

function makePromptLedgerEntry(
  name: string,
  originalText: string,
  options: { finalText?: string; compacted?: boolean; omitted?: boolean; viaConversationReuse?: boolean } = {}
): PromptLedgerEntry {
  const finalText = options.finalText ?? originalText;
  return {
    name,
    originalChars: originalText.length,
    finalChars: finalText.length,
    compacted: options.compacted ?? false,
    omitted: options.omitted ?? false,
    viaConversationReuse: options.viaConversationReuse ?? false
  };
}

function createRevisionInputShapingTrace(originalChars = 0): RevisionInputShapingTrace {
  return {
    applied: false,
    trigger: "none",
    budgetChars: null,
    originalChars,
    finalChars: originalChars,
    gapReportSynthesized: false,
    specCompacted: false,
    planCompacted: false,
    specSectionsCompacted: [],
    planSectionsCompacted: []
  };
}

function emitCompactionProgress(input: {
  sessionId: string;
  runId?: string;
  phase: PhaseValidationPhase;
  component: string;
  promptLedgerEntry: PromptLedgerEntry;
  compaction: CompactionMetadata;
  message: string;
}) {
  emitProgress({
    sessionId: input.sessionId,
    runId: input.runId,
    type: "info",
    phase: input.phase,
    metadata: {
      compacted: true,
      component: input.component,
      promptLedger: [input.promptLedgerEntry],
      compaction: input.compaction
    },
    message: input.message
  });
}

function compactMarkdown(text: string, budgetChars: number): {
  text: string;
  compacted: boolean;
  sectionsCompacted: string[];
} {
  if (text.length <= budgetChars) {
    return { text, compacted: false, sectionsCompacted: [] };
  }

  const keySectionPattern = /\b(tasks?|acceptance criteria|risks?|open questions?|dependencies)\b/i;
  const sections = text.split(/(?=^#{1,2}\s)/m);
  const sectionsCompacted: string[] = [];
  const compactedSections = sections.map((section) => {
    const lines = section.split("\n");
    const header = lines[0] ?? "";
    const bodyLines = lines.slice(1);
    const isKeySection = keySectionPattern.test(header);

    if (isKeySection) {
      sectionsCompacted.push(header || "unlabeled section");
      const kept = bodyLines
        .filter((line) => /^(\s*[-*]|\s*\d+\.)/.test(line) || line.trim() === "")
        .map((line) => line.length > 160 ? `${line.slice(0, 157)}...` : line);
      return [header, ...kept].join("\n").trim();
    }

    const paragraphLines: string[] = [];
    let inCodeBlock = false;
    let codeBlock: string[] = [];

    for (const line of bodyLines) {
      if (line.trim().startsWith("```")) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlock = [line];
          continue;
        }
        codeBlock.push(line);
        if (codeBlock.length <= 22) {
          paragraphLines.push(...codeBlock);
        } else {
          paragraphLines.push("[long code block omitted during compaction]");
        }
        break;
      }

      if (inCodeBlock) {
        codeBlock.push(line);
        continue;
      }

      if (paragraphLines.length > 0 && line.trim() === "") {
        break;
      }

      if (paragraphLines.length > 0 || line.trim() !== "") {
        paragraphLines.push(line);
      }
    }

    return [header, ...paragraphLines].join("\n").trim();
  });

  let compactedText = compactedSections.filter(Boolean).join("\n\n");
  const footer = `\n\n[Compacted from ${text.length} chars to ${Math.min(compactedText.length, budgetChars)} chars. Lower-priority details omitted.]`;

  if (compactedText.length + footer.length > budgetChars) {
    compactedText = compactedText.slice(0, Math.max(0, budgetChars - footer.length - 3)).trimEnd() + "...";
  }

  return {
    text: `${compactedText}${footer}`,
    compacted: true,
    sectionsCompacted
  };
}

function compactClaudeRevisionAuthorityDraft(input: {
  reviewedSpec: string;
  reviewedPlan: string;
  gapReport: string;
  synthesized: boolean;
  budgetChars: number;
}): {
  revisionPeerDraft: string;
  applied: boolean;
  specCompacted: boolean;
  planCompacted: boolean;
  specSectionsCompacted: string[];
  planSectionsCompacted: string[];
} {
  const originalRevisionPeerDraft = buildRevisionPeerDraft({
    reviewedSpec: input.reviewedSpec,
    reviewedPlan: input.reviewedPlan,
    gapReport: input.gapReport,
    synthesized: input.synthesized
  });

  if (originalRevisionPeerDraft.length <= input.budgetChars) {
    return {
      revisionPeerDraft: originalRevisionPeerDraft,
      applied: false,
      specCompacted: false,
      planCompacted: false,
      specSectionsCompacted: [],
      planSectionsCompacted: []
    };
  }

  const shellChars = buildRevisionPeerDraft({
    reviewedSpec: "",
    reviewedPlan: "",
    gapReport: input.gapReport,
    synthesized: input.synthesized
  }).length;
  const totalContentChars = Math.max(1, input.reviewedSpec.length + input.reviewedPlan.length);
  const contentBudget = Math.max(4_000, input.budgetChars - shellChars);

  let specBudget = Math.max(
    2_000,
    Math.floor(contentBudget * (input.reviewedSpec.length / totalContentChars))
  );
  let planBudget = Math.max(1_500, contentBudget - specBudget);

  if (specBudget + planBudget > contentBudget) {
    const overflow = specBudget + planBudget - contentBudget;
    if (specBudget >= planBudget) {
      specBudget = Math.max(2_000, specBudget - overflow);
    } else {
      planBudget = Math.max(1_500, planBudget - overflow);
    }
  }

  const buildCandidate = (nextSpecBudget: number, nextPlanBudget: number) => {
    const compactedSpec = compactMarkdown(input.reviewedSpec, nextSpecBudget);
    const compactedPlan = compactMarkdown(input.reviewedPlan, nextPlanBudget);

    return {
      revisionPeerDraft: buildRevisionPeerDraft({
        reviewedSpec: compactedSpec.text,
        reviewedPlan: compactedPlan.text,
        gapReport: input.gapReport,
        synthesized: input.synthesized
      }),
      specCompacted: compactedSpec.compacted,
      planCompacted: compactedPlan.compacted,
      specSectionsCompacted: compactedSpec.sectionsCompacted,
      planSectionsCompacted: compactedPlan.sectionsCompacted
    };
  };

  let bestCandidate = buildCandidate(specBudget, planBudget);
  for (let attempt = 0; attempt < 5 && bestCandidate.revisionPeerDraft.length > input.budgetChars; attempt += 1) {
    specBudget = Math.max(1_500, Math.floor(specBudget * 0.85));
    planBudget = Math.max(1_000, Math.floor(planBudget * 0.85));
    const candidate = buildCandidate(specBudget, planBudget);
    if (candidate.revisionPeerDraft.length < bestCandidate.revisionPeerDraft.length) {
      bestCandidate = candidate;
    }
  }

  return {
    ...bestCandidate,
    applied: bestCandidate.specCompacted || bestCandidate.planCompacted
  };
}

function extractProposedQuestions<T extends "gpt" | "claude">(
  parsed: Record<string, unknown> | null,
  proposedBy: T
): Array<ProposedQuestion & { proposedBy: T }> {
  if (!parsed) return [];

  // Check questionsForHuman as fallback
  const proposedQuestions = parsed.proposedQuestions as
    | Array<{
        text: string;
        priority: number;
        rationale: string;
        context?: string | null;
        recommendation?: string | null;
        recommendationReasoning?: string | null;
      }>
    | undefined;

  if (Array.isArray(proposedQuestions)) {
    return proposedQuestions.map((q, i) => ({
      text: q.text || `Question ${i + 1}`,
      priority: q.priority ?? i + 1,
      rationale: q.rationale || "No rationale provided",
      context: typeof q.context === "string" ? q.context : null,
      recommendation: typeof q.recommendation === "string" ? q.recommendation : null,
      recommendationReasoning: typeof q.recommendationReasoning === "string" ? q.recommendationReasoning : null,
      proposedBy
    }));
  }

  // Fallback: use questionsForHuman
  const humanQuestions = parsed.questionsForHuman as string[] | undefined;
  if (Array.isArray(humanQuestions)) {
    return humanQuestions.map((q, i) => ({
      text: q,
      priority: i + 1,
      rationale: "Extracted from questionsForHuman",
      context: null,
      recommendation: null,
      recommendationReasoning: null,
      proposedBy
    }));
  }

  return [];
}

function extractSynthesizedQuestions(
  parsed: Record<string, unknown> | null
): Array<ProposedQuestion & { proposedBy: "gpt" | "claude" }> {
  if (!parsed) return [];

  const synthesized = parsed.synthesizedQuestions as
    | Array<{
        text: string;
        priority: number;
        rationale: string;
        context?: string | null;
        recommendation?: string | null;
        recommendationReasoning?: string | null;
      }>
    | undefined;

  if (Array.isArray(synthesized)) {
    return synthesized.map((q, i) => ({
      text: q.text || `Question ${i + 1}`,
      priority: q.priority ?? i + 1,
      rationale: q.rationale || "No rationale provided",
      context: typeof q.context === "string" ? q.context : null,
      recommendation: typeof q.recommendation === "string" ? q.recommendation : null,
      recommendationReasoning: typeof q.recommendationReasoning === "string" ? q.recommendationReasoning : null,
      proposedBy: (parsed.actor as "gpt" | "claude") || "gpt"
    }));
  }

  return extractProposedQuestions(parsed, (parsed.actor as "gpt" | "claude") || "gpt");
}

function formatWalkthroughGapReport(gaps: WalkthroughGap[]): string {
  return gaps
    .map((gap, index) => `${index + 1}. **${gap.location}**: ${gap.issue}\n   Fix: ${gap.fix}`)
    .join("\n\n");
}

function buildInvalidTurnOutputMessage(details: InvalidTurnOutputDetails): string {
  return `${details.model.toUpperCase()} ${details.phase} failed: ${
    details.outputStatus === "degraded"
      ? "degraded structured output"
      : `missing required fields: ${details.missingFields.join(", ")}`
  }`;
}

function buildSpecGenerationFailureDiagnostics(input: {
  outputStatus: SpecGenerationFailureDiagnostics["outputStatus"];
  promptLedger: PromptLedgerEntry[];
  rawResponse: string;
  missingFields: string[];
  revisionPeerDraftChars: number;
  degradedOutputRetry?: {
    attempted: boolean;
    reason: "degraded_structured_output" | null;
    succeeded: boolean;
  };
}): SpecGenerationFailureDiagnostics {
  const promptLedgerSizes = summarizePromptLedgerSizes(input.promptLedger);

  return {
    phase: "spec_generation",
    provider: "claude",
    substep: "revision",
    outputStatus: input.outputStatus,
    missingFields: input.missingFields,
    ...(input.degradedOutputRetry?.attempted
      ? {
          degradedOutputRetry: {
            attempted: input.degradedOutputRetry.attempted,
            reason: "degraded_structured_output" as const,
            succeeded: input.degradedOutputRetry.succeeded
          }
        }
      : {}),
    rawResponsePreview: capPreview(input.rawResponse, RAW_RESPONSE_PREVIEW_MAX_CHARS),
    promptLedgerSizes: {
      originalProblem: promptLedgerSizes.originalProblem,
      interviewResults: promptLedgerSizes.interviewResults,
      finalApproachHandoff: promptLedgerSizes.finalApproachHandoff,
      revisionPeerDraft: promptLedgerSizes.revisionPeerDraft
    },
    revisionPeerDraftChars: input.revisionPeerDraftChars
  };
}

function summarizePromptLedgerSizes(promptLedger: PromptLedgerEntry[]): Record<string, number> {
  return promptLedger.reduce<Record<string, number>>((sizes, entry) => {
    sizes[entry.name] = entry.finalChars;
    return sizes;
  }, {});
}

function capPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - 1)}…`;
}

function buildSpecGenerationRecoveryPrompt(prompt: string): string {
  return `${SPEC_GENERATION_RECOVERY_INSTRUCTION}\n\n${prompt}`;
}

function buildRevisionPeerDraft(input: {
  reviewedSpec: string;
  reviewedPlan: string;
  gapReport: string;
  synthesized: boolean;
}): string {
  const heading = input.synthesized
    ? "SYNTHESIZED WALKTHROUGH REPAIR BRIEF"
    : "ADVERSARIAL WALKTHROUGH FINDINGS";
  const provenance = input.synthesized
    ? "The raw walkthrough findings were too large for the revision prompt, so Claude first clustered them into the repair brief below. The brief must preserve coverage of the original gap numbers."
    : "Both models independently simulated executing this spec and found the following operational gaps.";

  return [
    input.reviewedSpec,
    "",
    "---",
    "",
    "IMPLEMENTATION PLAN:",
    input.reviewedPlan,
    "",
    "---",
    "",
    `${heading}:`,
    provenance,
    "Incorporate the fixes below into the spec and plan. Do NOT simply acknowledge them — actually modify the relevant sections.",
    "",
    input.gapReport
  ].join("\n");
}

function buildGapSynthesisPrompt(input: {
  originalProblem: string;
  gaps: WalkthroughGap[];
}): string {
  const gapReport = formatWalkthroughGapReport(input.gaps);

  return [
    "PHASE: WALKTHROUGH GAP SYNTHESIS",
    "",
    "The raw adversarial walkthrough gap report is too large to include verbatim in the final revision prompt.",
    "Synthesize the findings into a compact root-cause repair brief for the revision model.",
    "",
    "Rules:",
    "- Preserve every original gap by number. Each original gap number must appear in exactly one repair item.",
    "- Merge duplicates and symptoms that share the same root cause.",
    "- Keep concrete fixes, affected sections, acceptance criteria, ordering constraints, and failure/rollback behavior.",
    "- Do not include broad commentary, debate history, or generic advice.",
    "- Target 12,000 characters or less unless preserving coverage requires slightly more.",
    "",
    "Respond ONLY with a JSON object matching the normal Crossfire model-turn shape.",
    "Put the markdown repair brief in both rawText and proposedSpecDelta. Use neutral values for unrelated fields:",
    "{",
    "  \"rawText\": \"markdown repair brief with repair items and covered gap numbers\",",
    "  \"summary\": \"one sentence summary\",",
    "  \"newInsights\": [],",
    "  \"assumptions\": [],",
    "  \"disagreements\": [],",
    "  \"questionsForPeer\": [],",
    "  \"questionsForHuman\": [],",
    "  \"proposedSpecDelta\": \"same markdown repair brief\",",
    "  \"milestoneReached\": \"implementation_plan_ready\",",
    "  \"implementationPlan\": null,",
    "  \"proposedQuestions\": null,",
    "  \"synthesizedQuestions\": null,",
    "  \"followUpQuestions\": null,",
    "  \"sufficientContext\": null,",
    "  \"walkthroughGaps\": null",
    "}",
    "",
    "---",
    "",
    "ORIGINAL PROBLEM:",
    input.originalProblem,
    "",
    "---",
    "",
    "RAW WALKTHROUGH GAPS:",
    gapReport
  ].join("\n");
}

function extractGapSynthesisBrief(
  result: { rawText: string; parsed: Record<string, unknown> | null },
  fallback: string
): string {
  const proposedSpecDelta = result.parsed?.proposedSpecDelta;
  if (typeof proposedSpecDelta === "string" && proposedSpecDelta.trim()) {
    return proposedSpecDelta.trim();
  }

  const rawText = result.parsed?.rawText;
  if (typeof rawText === "string" && rawText.trim()) {
    return rawText.trim();
  }

  if (result.rawText.trim()) {
    return result.rawText.trim();
  }

  return fallback;
}

function extractWalkthroughGaps(
  parsed: Record<string, unknown> | null
): WalkthroughGap[] {
  if (!parsed) return [];

  const gaps = parsed.walkthroughGaps as
    | Array<{ location: string; issue: string; fix: string }>
    | undefined;

  if (Array.isArray(gaps)) {
    return gaps
      .filter((g) => g.location && g.issue && g.fix)
      .map((g) => ({
        location: String(g.location),
        issue: String(g.issue),
        fix: String(g.fix)
      }));
  }

  return [];
}

function deduplicateGaps(gaps: WalkthroughGap[]): WalkthroughGap[] {
  const seen = new Set<string>();
  const result: WalkthroughGap[] = [];

  for (const gap of gaps) {
    // Deduplicate by normalizing the issue text
    const key = gap.issue.toLowerCase().trim().slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(gap);
    }
  }

  return result;
}

function deduplicateQuestions<T extends ProposedQuestion>(
  questions: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const q of questions) {
    const normalized = q.text.toLowerCase().trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(q);
    }
  }

  return result.sort((a, b) => a.priority - b.priority);
}

const QUESTION_STOPWORDS = new Set([
  "a", "an", "and", "are", "be", "for", "from", "how", "if", "in", "is", "it", "of", "on",
  "or", "the", "to", "what", "when", "which", "who", "why", "will", "with", "would", "should"
]);

function normalizeQuestionToken(token: string): string {
  const stripped = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!stripped) return "";

  return stripped.endsWith("ies") && stripped.length > 3 ? `${stripped.slice(0, -3)}y`
    : stripped.endsWith("s") && !stripped.endsWith("ss") && stripped.length > 3 ? stripped.slice(0, -1)
    : stripped;
}

function extractStringList(parsed: Record<string, unknown> | null, field: string): string[] {
  const value = parsed?.[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function buildQuestionDebatePeerResponse(turn: QuestionDebateTurn): string {
  const sections = [
    `SUMMARY: ${turn.summary}`,
    "",
    "CURRENT CANDIDATE QUESTIONS:",
    ...turn.synthesizedQuestions.map((question) => [
      `${question.priority}. ${question.text}`,
      `Rationale: ${question.rationale}`,
      question.context ? `Context: ${question.context}` : null,
      question.recommendation ? `Recommendation: ${question.recommendation}` : null,
      question.recommendationReasoning ? `Recommendation reasoning: ${question.recommendationReasoning}` : null
    ].filter(Boolean).join("\n"))
  ];

  if (turn.disagreements.length > 0) {
    sections.push("", "REMAINING DISAGREEMENTS:", ...turn.disagreements.map((item) => `- ${item}`));
  }

  if (turn.questionsForHuman.length > 0) {
    sections.push("", "QUESTIONS FOR HUMAN:", ...turn.questionsForHuman.map((item) => `- ${item}`));
  }

  return sections.join("\n");
}

function hasReachedQuestionConsensus(turns: QuestionDebateTurn[]): boolean {
  if (turns.length < 2) return false;

  const latest = turns.at(-1);
  const previous = turns.at(-2);
  if (!latest || !previous) return false;

  return latest.disagreements.length === 0
    && previous.disagreements.length === 0;
}

function buildQuestionDebateNarrative(
  turns: QuestionDebateTurn[],
  stopReason: DebateTrace["stopReason"],
  finalDisagreements: string[],
  finalQuestions: Array<ProposedQuestion & { id: string; proposedBy: "synthesized" }>
): string {
  const header =
    stopReason === "consensus"
      ? "Question debate reached full agreement."
      : stopReason === "questions_for_human"
        ? "Question debate paused because the models need clarification from the human."
        : "Question debate stopped at the turn cap before full agreement.";

  const sections = [header, ""];

  for (const turn of turns) {
    sections.push(`## ${turn.actor === "gpt" ? "Dr. Chen (GPT)" : "Dr. Rivera (Claude)"}`);
    sections.push(turn.rawText || turn.summary);
    if (turn.disagreements.length > 0) {
      sections.push("", "Remaining disagreements:");
      sections.push(...turn.disagreements.map((item) => `- ${item}`));
    }
    if (turn.questionsForHuman.length > 0) {
      sections.push("", "Clarification needed:");
      sections.push(...turn.questionsForHuman.map((item) => `- ${item}`));
    }
    sections.push("");
  }

  sections.push("## Current question list");
  sections.push(...finalQuestions.map((question) => [
    `${question.priority}. ${question.text}`,
    `   Why it matters: ${question.rationale}`,
    question.context ? `   Plain-English context: ${question.context}` : null,
    question.recommendation ? `   Crossfire recommendation: ${question.recommendation}` : null,
    question.recommendationReasoning ? `   Why Crossfire recommends this: ${question.recommendationReasoning}` : null
  ].filter(Boolean).join("\n")));

  if (finalDisagreements.length > 0) {
    sections.push("", "## Unresolved disagreements");
    sections.push(...finalDisagreements.map((item, index) => `${index + 1}. ${item}`));
  }

  return sections.join("\n").trim();
}

function ensureAuthorityInputFits(input: {
  sessionId: string;
  runId?: string;
  phase: PhaseValidationPhase;
  component: string;
  text: string;
  budgetChars: number;
  errorCode: AuthorityInputTooLargeError["code"];
}) {
  if (input.text.length <= input.budgetChars) {
    return;
  }

  emitProgress({
    sessionId: input.sessionId,
    runId: input.runId,
    type: "info",
    phase: input.phase,
    metadata: {
      blockedReason: input.errorCode,
      authorityInput: {
        component: input.component,
        actualChars: input.text.length,
        budgetChars: input.budgetChars
      }
    },
    message: `${input.errorCode.replaceAll("_", " ")}: ${input.component} exceeded the prompt budget`
  });

  throw new AuthorityInputTooLargeError(
    input.errorCode,
    input.component,
    input.text.length,
    input.budgetChars
  );
}

function collectFinalDisagreements(turns: Array<{
  disagreements: string[];
}>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const turn of turns) {
    for (const disagreement of turn.disagreements) {
      const normalized = disagreement.toLowerCase().trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(disagreement);
    }
  }

  return result;
}

function buildBalancedApproachNarrative(
  finalTurns: Array<{
    actor: "gpt" | "claude";
    rawText: string;
    proposedSpecDelta: string;
  }>,
  stopReason: string,
  finalDisagreements: string[]
): string {
  if (finalTurns.length === 0) {
    return "No approach debate output.";
  }

  const sections: string[] = [];
  if (stopReason === "consensus" && finalDisagreements.length === 0) {
    sections.push("Both models reached full mutual agreement. Final endorsed positions:");
  } else if (stopReason === "max_turns" && finalDisagreements.length > 0) {
    sections.push("The debate hit the maximum turn cap before full agreement. Final positions from both models are preserved below.");
  } else if (stopReason === "questions_for_human") {
    sections.push("The debate paused because the models need clarification from the human.");
  }

  for (const turn of finalTurns) {
    const actorLabel = turn.actor === "gpt" ? "Dr. Chen (GPT)" : "Dr. Rivera (Claude)";
    sections.push(`## ${actorLabel}\n${turn.rawText}`);
    if (turn.proposedSpecDelta) {
      sections.push(`### Proposed spec delta\n${turn.proposedSpecDelta}`);
    }
  }

  if (finalDisagreements.length > 0) {
    sections.push([
      "## Remaining disagreements",
      ...finalDisagreements.map((disagreement, index) => `${index + 1}. ${disagreement}`)
    ].join("\n"));
  }

  return sections.join("\n\n");
}

function buildCanonicalApproachHandoff(
  finalTurns: Array<{
    actor: "gpt" | "claude";
    summary: string;
    proposedSpecDelta: string;
  }>,
  stopReason: DebateTrace["stopReason"],
  finalDisagreements: string[]
): string {
  const sections = [
    "# Final Approach Handoff",
    "",
    `Status: ${stopReason.replaceAll("_", " ")}`,
    ""
  ];

  for (const turn of finalTurns) {
    sections.push(`## ${turn.actor === "gpt" ? "GPT final position" : "Claude final position"}`);
    sections.push(turn.proposedSpecDelta || turn.summary);
    sections.push("");
  }

  if (finalDisagreements.length > 0) {
    sections.push("## Remaining disagreements");
    sections.push(...finalDisagreements.map((item, index) => `${index + 1}. ${item}`));
    sections.push("");
  }

  return sections.join("\n").trim();
}
