import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "@council/adapters";
import {
  buildAnalysisPrompt,
  buildQuestionDebatePrompt,
  buildInterviewFollowUpPrompt,
  buildSpecPrompt
} from "@council/adapters";
import { emitProgress } from "./progress";
import { createOrchestrator } from "./orchestrator";
import { debugLogPrompt, debugLogResponse } from "./debug-log";

interface PhaseOrchestratorInput {
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
}

interface ProposedQuestion {
  text: string;
  priority: number;
  rationale: string;
}

interface AnalysisResult {
  gptAnalysis: string;
  claudeAnalysis: string;
  proposedQuestions: Array<ProposedQuestion & { proposedBy: "gpt" | "claude" }>;
}

interface QuestionDebateResult {
  synthesizedQuestions: Array<ProposedQuestion & { id: string; proposedBy: "synthesized" }>;
  debateSummary: string;
}

interface InterviewStepResult {
  evaluation: string;
  followUpQuestions: Array<ProposedQuestion & { id: string; proposedBy: "gpt" | "claude" }>;
  sufficientContext: boolean;
}

interface ApproachDebateResult {
  convergedApproach: string;
  turns: Array<{ actor: string; summary: string }>;
  questionsForHuman: string[];
}

interface SpecGenerationResult {
  spec: string;
  implementationPlan: string;
  summary: string;
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

async function collectTurnOutput(
  provider: ProviderAdapter,
  input: { sessionId: string; prompt: string; phase: string }
): Promise<{ rawText: string; parsed: Record<string, unknown> | null }> {
  const model = provider.name as "gpt" | "claude";
  const startTime = Date.now();
  emitProgress({
    sessionId: input.sessionId, type: "model_start", model,
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

  for await (const event of provider.sendTurn({
    sessionId: input.sessionId,
    prompt: input.prompt,
    phase: input.phase
  })) {
    if (event.type === "error") {
      providerError = event.message;
      continue;
    }

    if (event.type === "structured_turn") {
      rawText = event.turn.rawText || event.turn.summary;
      parsed = {
        actor: event.turn.actor,
        rawText: event.turn.rawText,
        summary: event.turn.summary,
        newInsights: event.turn.newInsights,
        assumptions: event.turn.assumptions,
        disagreements: event.turn.disagreements,
        questionsForPeer: event.turn.questionsForPeer,
        questionsForHuman: event.turn.questionsForHuman,
        proposedSpecDelta: event.turn.proposedSpecDelta,
        milestoneReached: event.turn.milestoneReached,
        degraded: event.turn.degraded
      };

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
      type: "info",
      model,
      phase: input.phase,
      elapsedMs,
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

  const degraded = parsed?.degraded ? " (degraded)" : "";
  emitProgress({
    sessionId: input.sessionId, type: "model_done", model,
    phase: input.phase, elapsedMs,
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

  return { rawText, parsed };
}

export function createPhaseOrchestrator(input: PhaseOrchestratorInput) {
  const classicOrchestrator = createOrchestrator({
    gpt: input.gpt,
    claude: input.claude
  });

  return {
    async runDualAnalysis(sessionId: string, prompt: string): Promise<AnalysisResult> {
      emitProgress({ sessionId, type: "phase_start", phase: "analysis", message: "Phase 1: Dual Analysis (GPT + Claude in parallel)" });
      const gptPrompt = buildAnalysisPrompt({ role: "gpt", originalProblem: prompt });
      const claudePrompt = buildAnalysisPrompt({ role: "claude", originalProblem: prompt });

      const [gptResult, claudeResult] = await Promise.all([
        collectTurnOutput(input.gpt, { sessionId, prompt: gptPrompt, phase: "analysis" }),
        collectTurnOutput(input.claude, { sessionId, prompt: claudePrompt, phase: "analysis" })
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
        proposedQuestions: deduplicated
      };
    },

    async runQuestionDebate(
      sessionId: string,
      prompt: string,
      gptAnalysis: string,
      claudeAnalysis: string,
      questions: Array<ProposedQuestion & { proposedBy: string }>
    ): Promise<QuestionDebateResult> {
      // Single parallel synthesis instead of multi-turn debate.
      // Both models independently review the proposed questions and produce
      // their preferred list. We merge the results. This replaces the old
      // 4-6 turn sequential debate (~350s) with a single parallel call (~60-170s).
      emitProgress({ sessionId, type: "phase_start", phase: "analysis_debate", message: `Question Synthesis (${questions.length} proposed — both models filter in parallel)` });

      const synthesisPrompt = (role: "gpt" | "claude") => buildQuestionDebatePrompt({
        role,
        originalProblem: prompt,
        gptAnalysis,
        claudeAnalysis,
        allQuestions: questions,
        turnNumber: 1,
        totalTurns: 1
      });

      const [gptResult, claudeResult] = await Promise.all([
        collectTurnOutput(input.gpt, { sessionId, prompt: synthesisPrompt("gpt"), phase: "analysis_debate" }),
        collectTurnOutput(input.claude, { sessionId, prompt: synthesisPrompt("claude"), phase: "analysis_debate" })
      ]);

      // Extract synthesized questions from both, prefer Claude's if both produced them
      let synthesized: Array<ProposedQuestion & { id: string; proposedBy: "synthesized" }> = [];

      for (const result of [claudeResult, gptResult]) {
        if (synthesized.length > 0) break;
        const qs = extractSynthesizedQuestions(result.parsed);
        if (qs.length > 0) {
          synthesized = qs
            .sort((a, b) => a.priority - b.priority)
            .map((q) => ({ ...q, id: randomUUID(), proposedBy: "synthesized" as const }));
        }
      }

      // Fall back to original proposed questions (deduplicated)
      if (synthesized.length === 0) {
        synthesized = questions.map((q) => ({
          ...q,
          id: randomUUID(),
          proposedBy: "synthesized" as const
        }));
      }

      const gptSummary = (gptResult.parsed?.summary as string) || gptResult.rawText.slice(0, 200);
      const claudeSummary = (claudeResult.parsed?.summary as string) || claudeResult.rawText.slice(0, 200);
      const debateSummary = [
        "Question synthesis (parallel):",
        "",
        `GPT: ${gptSummary}`,
        `Claude: ${claudeSummary}`
      ].join("\n");

      emitProgress({ sessionId, type: "consensus", message: `Question synthesis complete — ${synthesized.length} questions selected` });

      return { synthesizedQuestions: synthesized, debateSummary };
    },

    async runInterviewStep(
      sessionId: string,
      prompt: string,
      question: { text: string; rationale: string },
      answer: string,
      previousAnswers: Array<{ question: string; answer: string }>
    ): Promise<InterviewStepResult> {
      emitProgress({ sessionId, type: "phase_start", phase: "interview", message: "Evaluating answer (GPT + Claude in parallel)" });
      const gptPromptText = buildInterviewFollowUpPrompt({
        role: "gpt",
        originalProblem: prompt,
        questionText: question.text,
        questionRationale: question.rationale,
        answer,
        previousAnswers
      });

      const claudePromptText = buildInterviewFollowUpPrompt({
        role: "claude",
        originalProblem: prompt,
        questionText: question.text,
        questionRationale: question.rationale,
        answer,
        previousAnswers
      });

      const [gptResult, claudeResult] = await Promise.all([
        collectTurnOutput(input.gpt, { sessionId, prompt: gptPromptText, phase: "interview" }),
        collectTurnOutput(input.claude, { sessionId, prompt: claudePromptText, phase: "interview" })
      ]);

      const gptFollowUps = extractFollowUpQuestions(gptResult.parsed, "gpt");
      const claudeFollowUps = extractFollowUpQuestions(claudeResult.parsed, "claude");

      const allFollowUps = deduplicateQuestions([...gptFollowUps, ...claudeFollowUps])
        .map((q) => ({ ...q, id: randomUUID() }));

      const gptSufficient = (gptResult.parsed?.sufficientContext as boolean) ?? true;
      const claudeSufficient = (claudeResult.parsed?.sufficientContext as boolean) ?? true;

      const evaluation = [
        "GPT evaluation:",
        (gptResult.parsed?.summary as string) || gptResult.rawText,
        "",
        "Claude evaluation:",
        (claudeResult.parsed?.summary as string) || claudeResult.rawText
      ].join("\n");

      return {
        evaluation,
        followUpQuestions: allFollowUps,
        sufficientContext: gptSufficient && claudeSufficient && allFollowUps.length === 0
      };
    },

    async runApproachDebate(
      sessionId: string,
      prompt: string,
      interviewResults: Array<{ question: string; answer: string }>
    ): Promise<ApproachDebateResult> {
      emitProgress({ sessionId, type: "phase_start", phase: "approach_debate", message: `Approach Debate (consensus-driven, ${interviewResults.length} interview answers as context)` });
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
        prompt: enrichedPrompt
      });

      const turns = round.state.turns.map((t) => ({
        actor: t.actor,
        summary: t.summary,
        disagreements: t.disagreements,
        rawText: t.rawText
      }));

      const lastTurn = round.state.turns.at(-1);
      const convergedApproach = lastTurn
        ? `${lastTurn.rawText}\n\nProposed spec delta:\n${lastTurn.proposedSpecDelta}`
        : "No converged approach";

      // Surface any questions the models have for the human (debate paused for clarification)
      const questionsForHuman = lastTurn?.questionsForHuman ?? [];

      return { convergedApproach, turns, questionsForHuman };
    },

    async runSpecGeneration(
      sessionId: string,
      prompt: string,
      interviewResults: Array<{ question: string; answer: string }>,
      approachResult: string
    ): Promise<SpecGenerationResult> {
      // GPT drafts, Claude reviews — sequential so Claude can critique GPT's work.
      // This is the core adversarial value: the reviewer catches what the drafter missed.
      emitProgress({ sessionId, type: "phase_start", phase: "spec_generation", message: "Spec Generation (GPT drafts → Claude reviews)" });

      const draftPrompt = buildSpecPrompt({
        role: "gpt",
        originalProblem: prompt,
        interviewResults,
        approachResult
      });

      const draftResult = await collectTurnOutput(input.gpt, {
        sessionId,
        prompt: draftPrompt,
        phase: "spec_generation"
      });

      const draftSpec =
        (draftResult.parsed?.proposedSpecDelta as string) ||
        (draftResult.parsed?.rawText as string) ||
        draftResult.rawText ||
        "Spec draft unavailable";

      const draftPlan = (draftResult.parsed?.implementationPlan as string) || "";

      // Claude reviews GPT's draft — the adversarial step
      const peerDraft = draftPlan
        ? `${draftSpec}\n\n---\n\nIMPLEMENTATION PLAN:\n${draftPlan}`
        : draftSpec;

      const reviewPrompt = buildSpecPrompt({
        role: "claude",
        originalProblem: prompt,
        interviewResults,
        approachResult,
        peerDraft
      });

      const reviewResult = await collectTurnOutput(input.claude, {
        sessionId,
        prompt: reviewPrompt,
        phase: "spec_generation"
      });

      const finalSpec =
        (reviewResult.parsed?.proposedSpecDelta as string) ||
        (reviewResult.parsed?.rawText as string) ||
        reviewResult.rawText ||
        draftSpec;

      const implementationPlan =
        (reviewResult.parsed?.implementationPlan as string) ||
        (draftResult.parsed?.implementationPlan as string) ||
        "";

      const summary =
        (reviewResult.parsed?.summary as string) ||
        "Spec and implementation plan generated";

      return { spec: finalSpec, implementationPlan, summary };
    }
  };
}

function extractProposedQuestions<T extends "gpt" | "claude">(
  parsed: Record<string, unknown> | null,
  proposedBy: T
): Array<ProposedQuestion & { proposedBy: T }> {
  if (!parsed) return [];

  // Check questionsForHuman as fallback
  const proposedQuestions = parsed.proposedQuestions as
    | Array<{ text: string; priority: number; rationale: string }>
    | undefined;

  if (Array.isArray(proposedQuestions)) {
    return proposedQuestions.map((q, i) => ({
      text: q.text || `Question ${i + 1}`,
      priority: q.priority ?? i + 1,
      rationale: q.rationale || "No rationale provided",
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
    | Array<{ text: string; priority: number; rationale: string }>
    | undefined;

  if (Array.isArray(synthesized)) {
    return synthesized.map((q, i) => ({
      text: q.text || `Question ${i + 1}`,
      priority: q.priority ?? i + 1,
      rationale: q.rationale || "No rationale provided",
      proposedBy: (parsed.actor as "gpt" | "claude") || "gpt"
    }));
  }

  return extractProposedQuestions(parsed, (parsed.actor as "gpt" | "claude") || "gpt");
}

function extractFollowUpQuestions<T extends "gpt" | "claude">(
  parsed: Record<string, unknown> | null,
  proposedBy: T
): Array<ProposedQuestion & { proposedBy: T }> {
  if (!parsed) return [];

  const followUps = parsed.followUpQuestions as
    | Array<{ text: string; priority: number; rationale: string }>
    | undefined;

  if (Array.isArray(followUps)) {
    return followUps.map((q, i) => ({
      text: q.text || `Follow-up ${i + 1}`,
      priority: q.priority ?? i + 1,
      rationale: q.rationale || "No rationale provided",
      proposedBy
    }));
  }

  return [];
}

function deduplicateQuestions<T extends ProposedQuestion & { proposedBy: string }>(
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
