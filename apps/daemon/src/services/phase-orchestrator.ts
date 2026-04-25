import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "@council/adapters";
import {
  buildAnalysisPrompt,
  buildQuestionDebatePrompt,
  buildSpecPrompt,
  buildWalkthroughPrompt
} from "@council/adapters";
import { emitProgress, summarizeProgressText } from "./progress";
import { createOrchestrator } from "./orchestrator";
import { debugLogPrompt, debugLogResponse } from "./debug-log";
import { validatePhaseTurn, type PhaseValidationPhase } from "./phase-validation";

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
    revision?: TurnTrace;
    revisedAfterWalkthrough: boolean;
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
    compaction: {
      approachResult: boolean;
      peerDraft: boolean;
      revisionPeerDraft: boolean;
    };
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
    throw new Error(`${model.toUpperCase()} ${input.phase} failed: ${outputStatus === "degraded" ? "degraded structured output" : `missing required fields: ${missingFields.join(", ")}`}`);
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
    async runDualAnalysis(sessionId: string, prompt: string, runId?: string): Promise<AnalysisResult> {
      emitProgress({ sessionId, runId, type: "phase_start", phase: "analysis", message: "Phase 1: Dual Analysis (GPT + Claude in parallel)" });
      const gptPrompt = buildAnalysisPrompt({ role: "gpt", originalProblem: prompt });
      const claudePrompt = buildAnalysisPrompt({ role: "claude", originalProblem: prompt });
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
      runId?: string
    ): Promise<SpecGenerationResult> {
      // Step 1: GPT drafts, Claude reviews — sequential so Claude can critique GPT's work.
      emitProgress({ sessionId, runId, type: "phase_start", phase: "spec_generation", message: "Spec Generation (GPT drafts → Claude reviews → both walkthrough → Claude revises)" });
      ensureAuthorityInputFits({
        sessionId,
        runId,
        phase: "spec_generation",
        component: "finalApproachHandoff",
        text: finalApproachHandoff,
        budgetChars: 20_000,
        errorCode: "spec_generation_input_too_large"
      });
      const approachLedgerEntry = makePromptLedgerEntry("finalApproachHandoff", finalApproachHandoff);

      const draftPrompt = buildSpecPrompt({
        role: "gpt",
        originalProblem: prompt,
        interviewResults,
        approachResult: finalApproachHandoff
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
        budgetChars: 30_000,
        errorCode: "spec_generation_input_too_large"
      });
      const peerDraftLedgerEntry = makePromptLedgerEntry("peerDraft", peerDraft);

      const reviewPrompt = buildSpecPrompt({
        role: "claude",
        originalProblem: prompt,
        interviewResults,
        approachResult: finalApproachHandoff,
        peerDraft
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

      if (allGaps.length > 0) {
        emitProgress({ sessionId, runId, type: "info", phase: "spec_generation", message: `${allGaps.length} operational gap(s) found — Claude revising spec` });

        const gapReport = allGaps
          .map((g, i) => `${i + 1}. **${g.location}**: ${g.issue}\n   Fix: ${g.fix}`)
          .join("\n\n");

        const revisionPeerDraft = [
          reviewedSpec,
          "",
          "---",
          "",
          `IMPLEMENTATION PLAN:`,
          reviewedPlan,
          "",
          "---",
          "",
          `ADVERSARIAL WALKTHROUGH FINDINGS:`,
          `Both models independently simulated executing this spec and found the following operational gaps.`,
          `Incorporate the fixes below into the spec and plan. Do NOT simply acknowledge them — actually modify the relevant sections.`,
          "",
          gapReport
        ].join("\n");
        ensureAuthorityInputFits({
          sessionId,
          runId,
          phase: "spec_generation",
          component: "revisionPeerDraft",
          text: revisionPeerDraft,
          budgetChars: 30_000,
          errorCode: "revision_input_too_large"
        });
        const revisionPeerDraftLedgerEntry = makePromptLedgerEntry("revisionPeerDraft", revisionPeerDraft);

        const revisionPrompt = buildSpecPrompt({
          role: "claude",
          originalProblem: prompt,
          interviewResults,
          approachResult: finalApproachHandoff,
          peerDraft: revisionPeerDraft
        });

        const revisionResult = await collectTurnOutput(input.claude, {
          sessionId,
          runId,
          prompt: revisionPrompt,
          phase: "spec_generation",
          promptLedger: [
            makePromptLedgerEntry("originalProblem", prompt),
            makePromptLedgerEntry("interviewResults", interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n")),
            approachLedgerEntry,
            revisionPeerDraftLedgerEntry
          ]
        });
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
          revision: revisionTrace,
          revisedAfterWalkthrough: allGaps.length > 0,
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
          authorityPathUncompacted: true,
          compaction: {
            approachResult: false,
            peerDraft: false,
            revisionPeerDraft: false
          }
        }
      };
    }
  };
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
