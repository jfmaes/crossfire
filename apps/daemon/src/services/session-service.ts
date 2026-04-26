import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { ProviderAdapter } from "@council/adapters";
import type {
  SessionRepository,
  InterviewQuestionRow,
  ExecutionPolicy,
  SessionRow,
  SessionRunRow
} from "@council/storage";
import { collectGroundingContext } from "./grounding";
import { writeSpecArtifact } from "./artifacts";
import { createPhaseOrchestrator } from "./phase-orchestrator";
import { onProgress } from "./progress";

interface CreateSessionInput {
  title: string;
  prompt: string;
  executionPolicy?: ExecutionPolicy;
}

interface SessionServiceInput {
  repository: SessionRepository;
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
  artifactsDirectory?: string;
  grounding?: {
    rootDir: string;
    maxFiles: number;
    includeExtensions: string[];
  };
}

interface SessionServicePayload {
  [key: string]: unknown;
  session: SessionRow;
  summary: {
    currentUnderstanding: string;
    recommendation: string;
    changedSinceLastCheckpoint: string[];
    openRisks: string[];
    decisionsNeeded: string[];
    artifactPath?: string | null;
  };
  activeRun?: SessionRunRow;
  recentRuns?: SessionRunRow[];
  artifactPath?: string | null;
  phaseResult?: unknown;
  analysisResult?: unknown;
  interviewState?: {
    questions: Array<{
      id: string;
      text: string;
      priority: number;
      rationale: string;
      context?: string | null;
      recommendation?: string | null;
      recommendationReasoning?: string | null;
      proposedBy: string;
      answer: string | null;
    }>;
    currentQuestion: {
      id: string;
      text: string;
      rationale: string;
      context?: string | null;
      recommendation?: string | null;
      recommendationReasoning?: string | null;
    } | null;
    totalQuestions: number;
    answeredCount: number;
  };
  artifacts?: {
    spec: string | null;
    plan: string | null;
  };
}

export class SessionConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is already processing`);
    this.name = "SessionConflictError";
  }
}

export function createSessionService(input: SessionServiceInput) {
  const phaseOrchestrator = createPhaseOrchestrator({
    gpt: input.gpt,
    claude: input.claude
  });
  type AnalysisPhaseResult = Awaited<ReturnType<typeof phaseOrchestrator.runDualAnalysis>>;
  type QuestionDebatePhaseResult = Awaited<ReturnType<typeof phaseOrchestrator.runQuestionDebate>>;

  // Per-session lock to prevent concurrent mutations (e.g. double-click on continue).
  const sessionLocks = new Map<string, Promise<unknown>>();

  function acquireSessionLock(sessionId: string): { acquired: boolean; release: () => void } {
    if (sessionLocks.has(sessionId)) {
      return { acquired: false, release: () => {} };
    }

    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = () => {
        sessionLocks.delete(sessionId);
        resolve();
      };
    });
    sessionLocks.set(sessionId, lock);
    return { acquired: true, release };
  }

  function startBackgroundTask(sessionId: string, runId: string, task: () => Promise<void>): boolean {
    const lock = acquireSessionLock(sessionId);
    if (!lock.acquired) {
      return false;
    }

    const unsubscribe = onProgress((event) => {
      if (event.runId !== runId) return;

      input.repository.saveRunEvent({
        id: randomUUID(),
        runId,
        sessionId,
        type: event.type,
        message: event.message,
        model: event.model ?? null,
        phase: event.phase ?? null,
        turnNumber: event.turnNumber ?? null,
        elapsedMs: event.elapsedMs ?? null,
        disagreements: event.disagreements ?? null,
        metadata: event.metadata ?? null,
        createdAt: new Date().toISOString()
      });
    });

    void (async () => {
      try {
        await task();
        const session = input.repository.findById(sessionId);
        input.repository.updateRun({
          id: runId,
          status: session?.status === "finalized" ? "completed" : session?.status ?? "completed",
          phase: session?.phase ?? null,
          finishedAt: new Date().toISOString(),
          errorMessage: null
        });
      } catch (error) {
        console.error(`Background task failed for session ${sessionId}:`, error);
        input.repository.updateStatus({ id: sessionId, status: "errored" });
        const session = input.repository.findById(sessionId);
        input.repository.updateRun({
          id: runId,
          status: session?.status === "errored" ? "failed" : "failed",
          phase: session?.phase ?? null,
          finishedAt: new Date().toISOString(),
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      } finally {
        unsubscribe();
        lock.release();
      }
    })();

    return true;
  }

  async function buildPrompt(prompt: string) {
    const grounding = input.grounding;

    if (!grounding) {
      return prompt;
    }

    const context = await collectGroundingContext(grounding);

    if (context.files.length === 0) {
      return prompt;
    }

    const groundingBlock = context.files
      .map((file) => `FILE: ${file.absolutePath}\n${file.content}`)
      .join("\n\n");

    return `${prompt}\n\nGrounding context:\n${groundingBlock}`;
  }

  function getOriginalPrompt(session: { prompt?: string | null; title: string }): string {
    return session.prompt ?? session.title;
  }

  function buildInterviewState(sessionId: string) {
    const questions = input.repository.findInterviewQuestions(sessionId);
    const answered = questions.filter((q) => q.answer !== null);
    const current = questions.find((q) => q.answer === null);

    return {
      questions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        priority: q.priority,
        rationale: q.rationale,
        context: q.context ?? null,
        recommendation: q.recommendation ?? null,
        recommendationReasoning: q.recommendationReasoning ?? null,
        proposedBy: q.proposedBy,
        answer: q.answer
      })),
      currentQuestion: current
        ? {
            id: current.id,
            text: current.text,
            rationale: current.rationale,
            context: current.context ?? null,
            recommendation: current.recommendation ?? null,
            recommendationReasoning: current.recommendationReasoning ?? null
          }
        : null,
      totalQuestions: questions.length,
      answeredCount: answered.length
    };
  }

  function getPhaseResult(sessionId: string, phase: string): unknown | null {
    const row = input.repository.findPhaseResult(sessionId, phase);
    if (!row) return null;
    try {
      return JSON.parse(row.resultJson);
    } catch {
      return null;
    }
  }

  async function buildSessionPayload(id: string): Promise<SessionServicePayload | null> {
    const session = input.repository.findById(id);
    const summary = input.repository.findSummaryBySessionId(id);

    if (!session || !summary) {
      return null;
    }

    const analysisDebatePhase = getPhaseResult(id, "analysis_debate") as Record<string, unknown> | null;
    const analysisDebateStopReason =
      typeof analysisDebatePhase?.trace === "object" && analysisDebatePhase.trace
      && typeof (analysisDebatePhase.trace as { stopReason?: unknown }).stopReason === "string"
        ? (analysisDebatePhase.trace as { stopReason: string }).stopReason
        : null;

    // Legacy: auto-advance only if analysis checkpoint predates question-debate stop reasons.
    if (
      session.phase === "analysis"
      && session.status === "checkpoint"
      && (analysisDebateStopReason === null || analysisDebateStopReason === "consensus")
    ) {
      input.repository.updatePhase({ id, phase: "interview" });
      input.repository.updateStatus({ id, status: "interviewing" });
      session.phase = "interview";
      session.status = "interviewing";
      const interviewState = buildInterviewState(id);
      summary.currentUnderstanding = "Analysis complete. Answer the interview questions below.";
      summary.recommendation = interviewState.currentQuestion?.text || "No questions remaining";
      summary.decisionsNeeded = [];
      input.repository.saveSummary({
        sessionId: id,
        currentUnderstanding: summary.currentUnderstanding,
        recommendation: summary.recommendation,
        changedSinceLastCheckpoint: summary.changedSinceLastCheckpoint,
        openRisks: summary.openRisks,
        decisionsNeeded: summary.decisionsNeeded,
        artifactPath: summary.artifactPath ?? null
      });
    }

    const analysisPhase = getPhaseResult(id, "analysis") as Record<string, unknown> | null;
    const mergedAnalysisResult = analysisPhase
      ? {
          ...analysisPhase,
          debateSummary: analysisDebatePhase?.debateSummary,
          questionDebateTrace: analysisDebatePhase?.trace,
          questionDebateTurns: analysisDebatePhase?.turns
        }
      : undefined;

    return {
      session,
      activeRun: input.repository.findActiveRun(id) ?? undefined,
      recentRuns: input.repository.findRunsBySession(id),
      summary,
      interviewState: buildInterviewState(id),
      phaseResult: session.phase ? getPhaseResult(id, session.phase) : null,
      analysisResult: mergedAnalysisResult
    };
  }

  async function resetSessionForRestart(id: string) {
    const previousSummary = input.repository.findSummaryBySessionId(id);
    if (previousSummary?.artifactPath) {
      await unlink(previousSummary.artifactPath).catch(() => {});
    }

    input.repository.deleteInterviewQuestions(id);
    input.repository.deletePhaseResults(id);
    input.repository.updatePhase({ id, phase: "analysis" });
    input.repository.updateStatus({ id, status: "debating" });
    input.repository.saveSummary({
      sessionId: id,
      currentUnderstanding: "Restarting session from scratch.",
      recommendation: "Phase 1 is running again. Watch live progress while Crossfire rebuilds the session.",
      changedSinceLastCheckpoint: ["Session restarted"],
      openRisks: [],
      decisionsNeeded: [],
      artifactPath: null
    });
  }

  async function clearCurrentArtifact(id: string) {
    const previousSummary = input.repository.findSummaryBySessionId(id);
    if (previousSummary?.artifactPath) {
      await unlink(previousSummary.artifactPath).catch(() => {});
    }
  }

  function buildAnalysisPayload(
    analysisResult: AnalysisPhaseResult,
    debateResult?: QuestionDebatePhaseResult
  ) {
    if (!debateResult) {
      return analysisResult;
    }

    return {
      ...analysisResult,
      debateSummary: debateResult.debateSummary,
      questionDebateTrace: debateResult.trace,
      questionDebateTurns: debateResult.turns
    };
  }

  function saveQuestionCandidates(
    sessionId: string,
    analysisResult: AnalysisPhaseResult,
    debateResult: QuestionDebatePhaseResult
  ) {
    input.repository.deleteInterviewQuestions(sessionId);

    const questionRows: InterviewQuestionRow[] = debateResult.synthesizedQuestions.length > 0
      ? debateResult.synthesizedQuestions.map((q, i) => ({
          id: q.id,
          sessionId,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          context: q.context ?? null,
          recommendation: q.recommendation ?? null,
          recommendationReasoning: q.recommendationReasoning ?? null,
          proposedBy: q.proposedBy,
          answer: null,
          sortOrder: i
        }))
      : analysisResult.proposedQuestions.map((q, i) => ({
          id: randomUUID(),
          sessionId,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          context: q.context ?? null,
          recommendation: q.recommendation ?? null,
          recommendationReasoning: q.recommendationReasoning ?? null,
          proposedBy: q.proposedBy,
          answer: null,
          sortOrder: i
        }));

    if (questionRows.length > 0) {
      input.repository.saveInterviewQuestions(questionRows);
    }
  }

  function shouldProceedWithQuestionDebateOverride(humanResponse: string) {
    const normalized = humanResponse.trim().toLowerCase();
    return normalized === "proceed"
      || normalized === "approve"
      || normalized === "continue"
      || normalized === "use current";
  }

  async function settleQuestionDebate(
    id: string,
    prompt: string,
    analysisResult: AnalysisPhaseResult,
    debateResult: QuestionDebatePhaseResult,
    options?: { restarted?: boolean; runId?: string }
  ) {
    input.repository.savePhaseResult({
      sessionId: id,
      phase: "analysis_debate",
      resultJson: JSON.stringify(debateResult)
    });

    saveQuestionCandidates(id, analysisResult, debateResult);

    const interviewState = buildInterviewState(id);
    const analysisPayload = buildAnalysisPayload(analysisResult, debateResult);

    if (debateResult.trace.stopReason === "consensus") {
      if (!interviewState.currentQuestion) {
        return advanceToApproachDebate(id, prompt, options?.runId);
      }

      input.repository.updatePhase({ id, phase: "interview" });
      input.repository.updateStatus({ id, status: "interviewing" });

      const summary = {
        currentUnderstanding: "Question debate reached consensus. Answer the interview questions below.",
        recommendation: interviewState.currentQuestion.text,
        changedSinceLastCheckpoint: options?.restarted
          ? ["Session restarted", "Analysis complete", "Question debate reached consensus"]
          : ["Analysis complete", "Question debate reached consensus"],
        openRisks: [],
        decisionsNeeded: []
      };
      input.repository.saveSummary({
        sessionId: id,
        ...summary,
        artifactPath: null
      });

      return {
        session: input.repository.findById(id)!,
        summary,
        analysisResult: analysisPayload,
        interviewState
      };
    }

    const needsClarification = debateResult.trace.stopReason === "questions_for_human";
    input.repository.updatePhase({ id, phase: "analysis" });
    input.repository.updateStatus({ id, status: needsClarification ? "waiting_for_human" : "checkpoint" });

    const summary = {
      currentUnderstanding: debateResult.debateSummary,
      recommendation: needsClarification
        ? "The models need clarification before they can finalize the interview questions."
        : "The models did not fully agree on the interview questions. Review the disagreements or reply with `proceed` to continue with the current candidate list.",
      changedSinceLastCheckpoint: debateResult.turns.map((turn) => `${turn.actor}: ${turn.summary}`),
      openRisks: needsClarification
        ? []
        : [`Question debate stopped at the turn cap with ${debateResult.trace.finalDisagreements.length} unresolved disagreement(s)`],
      decisionsNeeded: needsClarification
        ? debateResult.turns.flatMap((turn) => turn.questionsForHuman)
        : [
            ...debateResult.trace.finalDisagreements,
            "Reply with guidance to rerun the question debate, or type `proceed` to use the current candidate list."
          ]
    };
    input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

    return {
      session: input.repository.findById(id)!,
      summary,
      analysisResult: analysisPayload,
      interviewState
    };
  }

  async function rerunQuestionDebateWithHumanInput(
    id: string,
    originalPrompt: string,
    humanResponse: string,
    runId?: string
  ) {
    const analysisResult = getPhaseResult(id, "analysis") as AnalysisPhaseResult | null;
    const priorDebate = getPhaseResult(id, "analysis_debate") as QuestionDebatePhaseResult | null;

    if (!analysisResult) {
      throw new Error("Cannot continue question debate without a saved analysis result");
    }

    const candidateQuestions = priorDebate?.synthesizedQuestions?.length
      ? priorDebate.synthesizedQuestions
      : analysisResult.proposedQuestions;
    const clarifiedPrompt = [
      originalPrompt,
      "",
      "---",
      "",
      "HUMAN CLARIFICATION FOR QUESTION DEBATE:",
      humanResponse
    ].join("\n");

    const debateResult = await phaseOrchestrator.runQuestionDebate(
      id,
      clarifiedPrompt,
      analysisResult.gptAnalysis,
      analysisResult.claudeAnalysis,
      candidateQuestions,
      runId
    );

    return settleQuestionDebate(id, originalPrompt, analysisResult, debateResult, { runId });
  }

  async function runSessionFromScratch(id: string, prompt: string, options?: { restarted?: boolean; runId?: string }) {
    let analysisResult;
    try {
      analysisResult = await phaseOrchestrator.runDualAnalysis(id, prompt, options?.runId);
    } catch (error) {
      input.repository.updateStatus({ id, status: "errored" });
      throw error;
    }

    input.repository.savePhaseResult({
      sessionId: id,
      phase: "analysis",
      resultJson: JSON.stringify(analysisResult)
    });

    let debateResult;
    try {
      debateResult = await phaseOrchestrator.runQuestionDebate(
        id,
        prompt,
        analysisResult.gptAnalysis,
        analysisResult.claudeAnalysis,
        analysisResult.proposedQuestions,
        options?.runId
      );
    } catch (error) {
      input.repository.updateStatus({ id, status: "errored" });
      throw error;
    }

    return settleQuestionDebate(id, prompt, analysisResult, debateResult, {
      restarted: options?.restarted,
      runId: options?.runId
    });
  }

  async function enqueueRun(inputRun: {
    sessionId: string;
    kind: string;
    phase: string;
    summary: {
      currentUnderstanding: string;
      recommendation: string;
      changedSinceLastCheckpoint: string[];
      openRisks: string[];
      decisionsNeeded: string[];
    };
    task: (runId: string) => Promise<void>;
  }): Promise<SessionServicePayload> {
    if (sessionLocks.has(inputRun.sessionId)) {
      const payload = await buildSessionPayload(inputRun.sessionId);
      if (!payload) {
        throw new Error(`Session ${inputRun.sessionId} not found after enqueue request`);
      }
      return payload;
    }

    input.repository.updatePhase({ id: inputRun.sessionId, phase: inputRun.phase });
    input.repository.updateStatus({ id: inputRun.sessionId, status: "debating" });
    input.repository.saveSummary({
      sessionId: inputRun.sessionId,
      ...inputRun.summary,
      artifactPath: null
    });

    const runId = randomUUID();
    input.repository.createRun({
      id: runId,
      sessionId: inputRun.sessionId,
      kind: inputRun.kind,
      status: "running",
      phase: inputRun.phase,
      startedAt: new Date().toISOString()
    });

    startBackgroundTask(inputRun.sessionId, runId, async () => {
      await inputRun.task(runId);
    });
    const payload = await buildSessionPayload(inputRun.sessionId);
    if (!payload) {
      throw new Error(`Session ${inputRun.sessionId} not found after run enqueue`);
    }
    return payload;
  }

  return {
    async createSession(payload: CreateSessionInput): Promise<SessionServicePayload> {
      const id = randomUUID();
      const prompt = await buildPrompt(payload.prompt);
      const hasGrounding = prompt.length > payload.prompt.length;
      console.log(`\n━━━ New session: ${id.slice(0, 8)} ━━━`);
      console.log(`  Title: ${payload.title}`);
      console.log(`  Prompt: ${payload.prompt.length} chars${hasGrounding ? ` (+${prompt.length - payload.prompt.length} chars grounding)` : ""}`);

      input.repository.create({
        id,
        title: payload.title,
        status: "debating",
        phase: "analysis",
        prompt,
        executionPolicy: payload.executionPolicy ?? null
      });
      return enqueueRun({
        sessionId: id,
        kind: "create",
        phase: "analysis",
        summary: {
          currentUnderstanding: "Session created. Phase 1 is starting.",
          recommendation: "Watch live progress while Crossfire runs the initial analysis and interview-question debate.",
          changedSinceLastCheckpoint: ["Session created"],
          openRisks: [],
          decisionsNeeded: []
        },
        task: async (runId) => {
          await runSessionFromScratch(id, prompt, { runId });
        }
      });
    },

    async continueSession(payload: { id: string; humanResponse: string }): Promise<SessionServicePayload | null> {
      const session = input.repository.findById(payload.id);
      if (!session) {
        return null;
      }

      if (sessionLocks.has(payload.id)) {
        return buildSessionPayload(payload.id);
      }

      console.log(`\n━━━ Continue session: ${session.id.slice(0, 8)} ━━━`);
      console.log(`  Phase: ${session.phase}  Status: ${session.status}`);
      console.log(`  Human: "${payload.humanResponse.slice(0, 100)}${payload.humanResponse.length > 100 ? "..." : ""}"`);

      if (session.status === "errored") {
        console.log("  Retrying errored phase...");
        return enqueueRun({
          sessionId: payload.id,
          kind: "retry",
          phase: session.phase ?? "analysis",
        summary: {
          currentUnderstanding: "Retrying the errored phase.",
          recommendation: "Watch live progress while Crossfire reruns the failed step.",
          changedSinceLastCheckpoint: ["Retry requested"],
          openRisks: [],
          decisionsNeeded: []
        },
        task: async (runId) => {
          await retryPhase(session, payload.humanResponse, runId);
        }
      });
      }

      return continuePhase(session, payload.humanResponse);
    },

    listSessions() {
      return input.repository.findAll();
    },

    async getSession(id: string): Promise<SessionServicePayload | null> {
      return buildSessionPayload(id);
    },

    exportSession(id: string) {
      const session = input.repository.findById(id);
      if (!session) return null;

      const summary = input.repository.findSummaryBySessionId(id);
      const interviewQuestions = input.repository.findInterviewQuestions(id);
      const phaseResults = input.repository.findAllPhaseResults(id);
      const runs = input.repository.findRunsBySession(id, 50);

      const phases: Record<string, unknown> = {};
      for (const row of phaseResults) {
        try {
          phases[row.phase] = JSON.parse(row.resultJson);
        } catch {
          phases[row.phase] = row.resultJson;
        }
      }

      return {
        exportedAt: new Date().toISOString(),
        session,
        activeRun: input.repository.findActiveRun(id) ?? null,
        recentRuns: runs,
        summary: summary ?? null,
        interviewQuestions: interviewQuestions.map((q) => ({
          id: q.id,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          context: q.context ?? null,
          recommendation: q.recommendation ?? null,
          recommendationReasoning: q.recommendationReasoning ?? null,
          proposedBy: q.proposedBy,
          answer: q.answer
        })),
        phaseResults: phases,
        runEventsByRun: runs.map((run) => ({
          run,
          events: input.repository.findRunEvents(run.id, 500)
        }))
      };
    },

    getRun(id: string) {
      return input.repository.findRunById(id) ?? null;
    },

    listRunEvents(runId: string) {
      return input.repository.findRunEvents(runId, 500);
    },

    async restartSession(id: string): Promise<SessionServicePayload | null> {
      const session = input.repository.findById(id);
      if (!session) return null;

      const prompt = getOriginalPrompt(session);

      // Finalized sessions keep their completed artifacts and history.
      // A "restart" becomes a brand-new session seeded with the same prompt.
      if (session.status === "finalized") {
        const newId = randomUUID();
        const runId = randomUUID();
        input.repository.create({
          id: newId,
          title: session.title,
          status: "debating",
          phase: "analysis",
          prompt,
          executionPolicy: session.executionPolicy ?? null
        });
        input.repository.saveSummary({
          sessionId: newId,
          currentUnderstanding: "Starting a new session from the finalized run's prompt.",
          recommendation: "Phase 1 is running. Watch live progress while Crossfire rebuilds the session.",
          changedSinceLastCheckpoint: ["New session created from finalized run"],
          openRisks: [],
          decisionsNeeded: [],
          artifactPath: null
        });
        input.repository.createRun({
          id: runId,
          sessionId: newId,
          kind: "restart",
          status: "running",
          phase: "analysis",
          startedAt: new Date().toISOString()
        });

        startBackgroundTask(newId, runId, async () => {
          input.gpt.clearSession?.(newId);
          input.claude.clearSession?.(newId);
          console.log(`\n━━━ Restart finalized session as new run: ${newId.slice(0, 8)} ━━━`);
          console.log(`  Source session: ${id.slice(0, 8)}`);
          console.log(`  Title: ${session.title}`);
          console.log(`  Prompt: ${prompt.length} chars`);
          await runSessionFromScratch(newId, prompt, { restarted: true, runId });
        });

        return buildSessionPayload(newId);
      }

      // Non-finalized sessions restart in place from phase 0 semantics.
      // If a restart is already running, return the live payload instead of throwing.
      if (sessionLocks.has(id)) {
        return buildSessionPayload(id);
      }

      await resetSessionForRestart(id);
      const runId = randomUUID();
      input.repository.createRun({
        id: runId,
        sessionId: id,
        kind: "restart",
        status: "running",
        phase: "analysis",
        startedAt: new Date().toISOString()
      });

      startBackgroundTask(id, runId, async () => {
        input.gpt.clearSession?.(id);
        input.claude.clearSession?.(id);
        console.log(`\n━━━ Restart session: ${id.slice(0, 8)} ━━━`);
        console.log(`  Title: ${session.title}`);
        console.log(`  Original prompt: ${prompt.length} chars`);
        await runSessionFromScratch(id, prompt, { restarted: true, runId });
      });

      return buildSessionPayload(id);
    },

    async rewindSession(id: string): Promise<SessionServicePayload | null> {
      const session = input.repository.findById(id);
      if (!session) return null;

      if (sessionLocks.has(id)) {
        throw new SessionConflictError(id);
      }

      if (session.status === "finalized") {
        return buildSessionPayload(id);
      }

      input.gpt.clearSession?.(id);
      input.claude.clearSession?.(id);

      switch (session.phase) {
        case "approach_debate": {
          input.repository.deletePhaseResult(id, "approach_debate");
          await clearCurrentArtifact(id);
          input.repository.updatePhase({ id, phase: "interview" });
          input.repository.updateStatus({ id, status: "interviewing" });

          const interviewState = buildInterviewState(id);
          const summary = {
            currentUnderstanding: interviewState.currentQuestion
              ? "Returned to the interview phase. You can revise the context before rerunning the approach debate."
              : "Returned to the interview phase. All current questions are already answered; submit more context or type \"enough\" to rerun the approach debate.",
            recommendation: interviewState.currentQuestion?.text
              ?? "Type \"enough\" to rerun the approach debate, or add more context below.",
            changedSinceLastCheckpoint: ["Returned from approach debate to interview"],
            openRisks: [],
            decisionsNeeded: []
          };
          input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });
          return buildSessionPayload(id);
        }

        case "spec_generation": {
          input.repository.deletePhaseResult(id, "spec_generation");
          await clearCurrentArtifact(id);

          const approachResult = getPhaseResult(id, "approach_debate") as {
            convergedApproach?: string;
            questionsForHuman?: string[];
          } | null;
          const questionsForHuman = approachResult?.questionsForHuman ?? [];
          const hasHumanQuestions = questionsForHuman.length > 0;

          input.repository.updatePhase({ id, phase: "approach_debate" });
          input.repository.updateStatus({ id, status: hasHumanQuestions ? "waiting_for_human" : "checkpoint" });

          const summary = {
            currentUnderstanding: approachResult?.convergedApproach || "Returned to the approach debate checkpoint.",
            recommendation: hasHumanQuestions
              ? "The models need clarification before they can converge."
              : "Review the converged approach before spec generation",
            changedSinceLastCheckpoint: ["Returned from spec generation to approach debate"],
            openRisks: [],
            decisionsNeeded: hasHumanQuestions
              ? questionsForHuman
              : ["Approve approach to proceed to spec generation"]
          };
          input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });
          return buildSessionPayload(id);
        }

        default:
          return buildSessionPayload(id);
      }
    },

    deleteSession(id: string) {
      input.repository.deleteSession(id);
    }
  };

  async function retryPhase(
    session: { id: string; title: string; status: string; phase?: string | null; prompt?: string | null },
    humanResponse: string,
    runId?: string
  ) {
    const id = session.id;
    const phase = session.phase;
    const originalPrompt = getOriginalPrompt(session);

    input.repository.updateStatus({ id, status: "debating" });

    switch (phase) {
      case "analysis": {
        // Re-run the full analysis + question debate
        let analysisResult;
        try {
          analysisResult = await phaseOrchestrator.runDualAnalysis(id, originalPrompt, runId);
        } catch (error) {
          input.repository.updateStatus({ id, status: "errored" });
          throw error;
        }

        let debateResult;
        try {
          debateResult = await phaseOrchestrator.runQuestionDebate(
            id, originalPrompt,
            analysisResult.gptAnalysis, analysisResult.claudeAnalysis,
            analysisResult.proposedQuestions,
            runId
          );
        } catch (error) {
          input.repository.updateStatus({ id, status: "errored" });
          throw error;
        }

        input.repository.savePhaseResult({
          sessionId: id, phase: "analysis",
          resultJson: JSON.stringify(analysisResult)
        });

        return settleQuestionDebate(id, originalPrompt, analysisResult, debateResult, { runId });
      }

      case "approach_debate": {
        // Re-run the approach debate from the current interview answers.
        // Don't rewind to interview — that would save the retry text as an answer.
        input.repository.updateStatus({ id, status: "debating" });
        return advanceToApproachDebate(id, originalPrompt, runId);
      }

      case "spec_generation": {
        // Re-run spec generation from the existing approach.
        input.repository.updateStatus({ id, status: "debating" });
        return advanceToSpecGeneration(id, originalPrompt, undefined, runId);
      }

      case "interview":
        return continuePhase(
          { ...session, status: "debating", phase: getPreviousPhase(phase) },
          humanResponse
        );

      default:
        return null;
    }
  }

  function getPreviousPhase(phase: string): string {
    const order: Record<string, string> = {
      interview: "analysis",
      approach_debate: "interview",
      spec_generation: "approach_debate"
    };
    return order[phase] ?? "analysis";
  }

  async function continuePhase(
    session: { id: string; title: string; status: string; phase?: string | null; prompt?: string | null },
    humanResponse: string
  ) {
    const id = session.id;
    const phase = session.phase;
    const originalPrompt = getOriginalPrompt(session);

    switch (phase) {
      case "analysis": {
        const analysisDebate = getPhaseResult(id, "analysis_debate") as {
          trace?: { stopReason?: string };
        } | null;
        const stopReason = analysisDebate?.trace?.stopReason;

        if (stopReason === "questions_for_human") {
          return enqueueRun({
            sessionId: id,
            kind: "continue",
            phase: "analysis",
            summary: {
              currentUnderstanding: "Using your clarification to revisit the interview-question debate.",
              recommendation: "Watch live progress while Crossfire reruns the question debate.",
              changedSinceLastCheckpoint: ["Question debate clarification received"],
              openRisks: [],
              decisionsNeeded: []
            },
            task: async (runId) => {
              await rerunQuestionDebateWithHumanInput(id, originalPrompt, humanResponse, runId);
            }
          });
        }

        if (stopReason === "max_turns") {
          if (shouldProceedWithQuestionDebateOverride(humanResponse)) {
            input.repository.updatePhase({ id, phase: "interview" });
            input.repository.updateStatus({ id, status: "interviewing" });

            const interviewState = buildInterviewState(id);
            const summary = {
              currentUnderstanding: "Proceeding with the current interview-question list based on explicit human judgment.",
              recommendation: interviewState.currentQuestion?.text || "No questions remaining",
              changedSinceLastCheckpoint: ["Human override accepted for unresolved question debate"],
              openRisks: ["Interview questions were not fully agreed by both models."],
              decisionsNeeded: []
            };
            input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

            return {
              session: input.repository.findById(id)!,
              summary,
              interviewState,
              analysisResult: buildAnalysisPayload(
                getPhaseResult(id, "analysis") as AnalysisPhaseResult,
                getPhaseResult(id, "analysis_debate") as QuestionDebatePhaseResult
              )
            };
          }

          return enqueueRun({
            sessionId: id,
            kind: "continue",
            phase: "analysis",
            summary: {
              currentUnderstanding: "Using your guidance to revisit the unresolved question debate.",
              recommendation: "Watch live progress while Crossfire reruns the question debate.",
              changedSinceLastCheckpoint: ["Question debate guidance received"],
              openRisks: [],
              decisionsNeeded: []
            },
            task: async (runId) => {
              await rerunQuestionDebateWithHumanInput(id, originalPrompt, humanResponse, runId);
            }
          });
        }

        // Analysis is done (includes debate). Move to interview.
        input.repository.updatePhase({ id, phase: "interview" });
        input.repository.updateStatus({ id, status: "interviewing" });

        const interviewState = buildInterviewState(id);
        const summary = {
          currentUnderstanding: "Analysis complete. Answer the interview questions below.",
          recommendation: interviewState.currentQuestion?.text || "No questions remaining",
          changedSinceLastCheckpoint: ["Entering interview phase"],
          openRisks: [],
          decisionsNeeded: []
        };
        input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

        return {
          session: input.repository.findById(id)!,
          summary,
          interviewState,
          analysisResult: buildAnalysisPayload(
            getPhaseResult(id, "analysis") as AnalysisPhaseResult,
            getPhaseResult(id, "analysis_debate") as QuestionDebatePhaseResult | undefined
          )
        };
      }

      case "interview": {
        const questions = input.repository.findInterviewQuestions(id);
        const currentQuestion = questions.find((q) => q.answer === null);
        const normalizedResponse = humanResponse.trim().toLowerCase();

        if (!currentQuestion) {
          return enqueueRun({
            sessionId: id,
            kind: "continue",
            phase: "approach_debate",
            summary: {
              currentUnderstanding: "Interview complete. The models are now debating the best approach.",
              recommendation: "Watch live progress while Crossfire runs the approach debate.",
              changedSinceLastCheckpoint: ["Interview complete"],
              openRisks: [],
              decisionsNeeded: []
            },
            task: async (runId) => {
              await advanceToApproachDebate(id, originalPrompt, runId);
            }
          });
        }

        if (normalizedResponse === "enough") {
          return enqueueRun({
            sessionId: id,
            kind: "continue",
            phase: "approach_debate",
            summary: {
              currentUnderstanding: "Interview stopped early. The models are now debating the best approach.",
              recommendation: "Watch live progress while Crossfire runs the approach debate.",
              changedSinceLastCheckpoint: ["Interview skipped with enough"],
              openRisks: [],
              decisionsNeeded: []
            },
            task: async (runId) => {
              await advanceToApproachDebate(id, originalPrompt, runId);
            }
          });
        }

        const shouldUseRecommendation = currentQuestion.recommendation && (
          normalizedResponse === "use recommendation"
          || normalizedResponse === "use crossfire recommendation"
          || normalizedResponse === "crossfire decide"
          || normalizedResponse === "let crossfire decide"
          || normalizedResponse === "you decide"
          || normalizedResponse === "llm decide"
        );

        const recordedAnswer = shouldUseRecommendation
          ? currentQuestion.recommendation!
          : humanResponse;

        // Record the answer immediately — no per-question LLM evaluation.
        // The models will see all answers together during the approach debate,
        // which is both faster and gives them better context.
        input.repository.updateInterviewAnswer({ id: currentQuestion.id, answer: recordedAnswer });

        const updatedState = buildInterviewState(id);

        if (!updatedState.currentQuestion) {
          return enqueueRun({
            sessionId: id,
            kind: "continue",
            phase: "approach_debate",
            summary: {
              currentUnderstanding: "Interview complete. The models are now debating the best approach.",
              recommendation: "Watch live progress while Crossfire runs the approach debate.",
              changedSinceLastCheckpoint: [`Answered: ${currentQuestion.text}`],
              openRisks: [],
              decisionsNeeded: []
            },
            task: async (runId) => {
              await advanceToApproachDebate(id, originalPrompt, runId);
            }
          });
        }

        const summary = {
          currentUnderstanding: `Answered ${updatedState.answeredCount} of ${updatedState.totalQuestions} questions.`,
          recommendation: updatedState.currentQuestion.text,
          changedSinceLastCheckpoint: [`Answered: ${currentQuestion.text}`],
          openRisks: [],
          decisionsNeeded: []
        };
        input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

        return {
          session: input.repository.findById(id)!,
          summary,
          interviewState: updatedState,
          analysisResult: getPhaseResult(id, "analysis") ?? undefined
        };
      }

      case "approach_debate": {
        return enqueueRun({
          sessionId: id,
          kind: "continue",
          phase: "spec_generation",
          summary: {
            currentUnderstanding: "The models are generating the specification and implementation plan.",
            recommendation: "Watch live progress while GPT drafts and Claude reviews the spec.",
            changedSinceLastCheckpoint: ["Approach approved"],
            openRisks: [],
            decisionsNeeded: []
          },
          task: async (runId) => {
            await advanceToSpecGeneration(id, originalPrompt, humanResponse, runId);
          }
        });
      }

      case "spec_generation": {
        if (humanResponse.toLowerCase().trim() === "approve") {
          return finalizeSpec(id);
        }
        return enqueueRun({
          sessionId: id,
          kind: "revise",
          phase: "spec_generation",
          summary: {
            currentUnderstanding: "Revising the specification based on your feedback.",
            recommendation: "Watch live progress while Crossfire regenerates the spec and plan.",
            changedSinceLastCheckpoint: ["Revision requested"],
            openRisks: [],
            decisionsNeeded: []
          },
          task: async (runId) => {
            await reviseSpec(id, originalPrompt, humanResponse, runId);
          }
        });
      }

      default:
        return null;
    }
  }

  async function finalizeSpec(id: string) {
    input.repository.updateStatus({ id, status: "finalized" });

    const specRow = input.repository.findPhaseResult(id, "spec_generation");
    let specData: Record<string, unknown> | null = null;
    try {
      specData = specRow ? JSON.parse(specRow.resultJson) : null;
    } catch {
      specData = null;
    }

    let artifactPath: string | null = null;
    let planPath: string | null = null;
    if (input.artifactsDirectory) {
      if (typeof specData?.spec === "string") {
        artifactPath = await writeSpecArtifact({
          directory: input.artifactsDirectory,
          fileName: `${id}-spec.md`,
          markdown: specData.spec
        });
      }
      if (typeof specData?.implementationPlan === "string") {
        planPath = await writeSpecArtifact({
          directory: input.artifactsDirectory,
          fileName: `${id}-plan.md`,
          markdown: specData.implementationPlan
        });
      }
    }

    const summary = {
      currentUnderstanding: (typeof specData?.summary === "string" ? specData.summary : null) || "Spec and implementation plan finalized",
      recommendation: "Approved and finalized",
      changedSinceLastCheckpoint: ["Approved by human"],
      openRisks: [],
      decisionsNeeded: []
    };
    input.repository.saveSummary({ sessionId: id, ...summary, artifactPath });

    return {
      session: input.repository.findById(id)!,
      summary,
      phaseResult: specData,
      artifacts: {
        spec: artifactPath,
        plan: planPath
      },
      interviewState: buildInterviewState(id)
    };
  }

  async function reviseSpec(id: string, originalPrompt: string, feedback: string, runId?: string) {
    input.repository.updateStatus({ id, status: "debating" });

    if (!runId) {
      throw new Error("revision run id required");
    }

    const questions = input.repository.findInterviewQuestions(id);
    const interviewResults = questions
      .filter((q) => q.answer !== null)
      .map((q) => ({ question: q.text, answer: q.answer! }));

    const approachRow = input.repository.findPhaseResult(id, "approach_debate");
    const approachData = approachRow ? JSON.parse(approachRow.resultJson) : null;
    const finalApproachHandoff =
      approachData?.finalApproachHandoff
      ?? approachData?.convergedApproach
      ?? "";

    const currentSpecRow = input.repository.findPhaseResult(id, "spec_generation");
    const currentSpecData = currentSpecRow ? JSON.parse(currentSpecRow.resultJson) : null;
    const currentSpec =
      typeof currentSpecData?.spec === "string"
        ? currentSpecData.spec
        : typeof currentSpecData?.proposedSpecDelta === "string"
          ? currentSpecData.proposedSpecDelta
          : "";
    const currentImplementationPlan =
      typeof currentSpecData?.implementationPlan === "string"
        ? currentSpecData.implementationPlan
        : "";
    if (!currentSpec || !currentImplementationPlan) {
      throw new Error("Cannot revise spec without an existing spec and implementation plan");
    }

    const revisionRequestId = randomUUID();
    input.repository.createRevisionRequest({
      id: revisionRequestId,
      sessionId: id,
      runId,
      feedbackRaw: feedback,
      feedbackChunks: [],
      feedbackDigest: null,
      budgetLedger: null,
      status: "stored",
      createdAt: new Date().toISOString()
    });

    let specResult;
    try {
      specResult = await phaseOrchestrator.runSpecRevision(
        id,
        {
          originalProblem: originalPrompt,
          interviewResults,
          finalApproachHandoff,
          currentSpec,
          currentImplementationPlan,
          feedbackRaw: feedback
        },
        runId
      );
      input.repository.updateRevisionRequest({
        id: revisionRequestId,
        feedbackChunks: specResult.revisionRequest.feedbackChunks,
        feedbackDigest: specResult.revisionRequest.feedbackDigest,
        budgetLedger: specResult.revisionRequest.budgetLedger,
        status: specResult.blockedReason ? "blocked" : "applied",
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      input.repository.updateStatus({ id, status: "errored" });
      input.repository.updateRevisionRequest({
        id: revisionRequestId,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      throw error;
    }

    if (specResult.blockedReason) {
      input.repository.updateStatus({ id, status: "checkpoint" });
      const previousSummary = input.repository.findSummaryBySessionId(id);
      const summary = {
        currentUnderstanding: specResult.summary,
        recommendation: "Your feedback is too large to apply safely in one revision. Prioritize the most important changes and submit a smaller revision request.",
        changedSinceLastCheckpoint: ["Revision blocked because feedback exceeded safe prompt budgets"],
        openRisks: [specResult.blockedReason],
        decisionsNeeded: ["Prioritize the feedback into a smaller revision request"]
      };
      input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: previousSummary?.artifactPath ?? null });

      return {
        session: input.repository.findById(id)!,
        summary,
        phaseResult: currentSpecData,
        interviewState: buildInterviewState(id)
      };
    }

    input.repository.savePhaseResult({
      sessionId: id, phase: "spec_generation",
      resultJson: JSON.stringify(specResult)
    });

    let artifactPath: string | null = null;
    if (input.artifactsDirectory) {
      artifactPath = await writeSpecArtifact({
        directory: input.artifactsDirectory,
        fileName: `${id}.md`,
        markdown: specResult.spec
      });
    }

    input.repository.updateStatus({ id, status: "checkpoint" });
    const summary = {
      currentUnderstanding: specResult.summary,
      recommendation: "Review the revised specification",
      changedSinceLastCheckpoint: ["Spec revised based on feedback"],
      openRisks: [],
      decisionsNeeded: ["Approve or revise the specification"]
    };
    input.repository.saveSummary({ sessionId: id, ...summary, artifactPath });

    return {
      session: input.repository.findById(id)!,
      summary,
      phaseResult: specResult,
      interviewState: buildInterviewState(id)
    };
  }

  async function advanceToApproachDebate(id: string, originalPrompt: string, runId?: string) {
    input.repository.updatePhase({ id, phase: "approach_debate" });
    input.repository.updateStatus({ id, status: "debating" });

    const questions = input.repository.findInterviewQuestions(id);
    const interviewResults = questions
      .filter((q) => q.answer !== null)
      .map((q) => ({ question: q.text, answer: q.answer! }));

    let approachResult;
    try {
      const session = input.repository.findById(id);
      approachResult = await phaseOrchestrator.runApproachDebate(
        id,
        originalPrompt,
        interviewResults,
        session?.executionPolicy?.approachDebateMaxTurns,
        runId
      );
    } catch (error) {
      input.repository.updateStatus({ id, status: "errored" });
      throw error;
    }

    input.repository.savePhaseResult({
      sessionId: id, phase: "approach_debate",
      resultJson: JSON.stringify(approachResult)
    });

    // If the models paused with questions for the human, surface them
    // instead of pretending the approach converged.
    const hasHumanQuestions = approachResult.questionsForHuman.length > 0;
    const unresolvedAtTurnCap =
      approachResult.trace.stopReason === "max_turns" &&
      approachResult.trace.finalDisagreements.length > 0;

    input.repository.updateStatus({ id, status: hasHumanQuestions ? "waiting_for_human" : "checkpoint" });
    const summary = {
      currentUnderstanding: approachResult.convergedApproach,
      recommendation: hasHumanQuestions
        ? "The models need clarification before they can converge."
        : unresolvedAtTurnCap
          ? "The debate hit the turn cap before full agreement. Review the remaining disagreements before deciding whether to continue."
        : "Review the converged approach before spec generation",
      changedSinceLastCheckpoint: approachResult.turns.map((t) => `${t.actor}: ${t.summary}`),
      openRisks: unresolvedAtTurnCap
        ? [`Debate stopped at max turns with ${approachResult.trace.finalDisagreements.length} unresolved disagreement(s)`]
        : [],
      decisionsNeeded: hasHumanQuestions
        ? approachResult.questionsForHuman
        : unresolvedAtTurnCap
          ? [
              ...approachResult.trace.finalDisagreements,
              "Decide whether to continue to spec generation, rewind, or restart from scratch"
            ]
        : ["Approve approach to proceed to spec generation"]
    };
    input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

    return {
      session: input.repository.findById(id)!,
      summary,
      phaseResult: approachResult,
      interviewState: buildInterviewState(id)
    };
  }

  async function advanceToSpecGeneration(id: string, originalPrompt: string, humanFeedback?: string, runId?: string) {
    input.repository.updatePhase({ id, phase: "spec_generation" });
    input.repository.updateStatus({ id, status: "debating" });

    const questions = input.repository.findInterviewQuestions(id);
    const interviewResults = questions
      .filter((q) => q.answer !== null)
      .map((q) => ({ question: q.text, answer: q.answer! }));

    const approachRow = input.repository.findPhaseResult(id, "approach_debate");
    const approachData = approachRow ? JSON.parse(approachRow.resultJson) : null;
    let finalApproachHandoff =
      approachData?.finalApproachHandoff
      ?? approachData?.convergedApproach
      ?? "";

    if (humanFeedback && humanFeedback.trim()) {
      finalApproachHandoff += `\n\n---\n\nHUMAN FEEDBACK ON APPROACH:\n${humanFeedback}`;
    }

    let specResult;
    try {
      specResult = await phaseOrchestrator.runSpecGeneration(
        id, originalPrompt, interviewResults, finalApproachHandoff, runId
      );
    } catch (error) {
      input.repository.updateStatus({ id, status: "errored" });
      throw error;
    }

    input.repository.savePhaseResult({
      sessionId: id, phase: "spec_generation",
      resultJson: JSON.stringify(specResult)
    });

    let artifactPath: string | null = null;
    if (input.artifactsDirectory) {
      artifactPath = await writeSpecArtifact({
        directory: input.artifactsDirectory,
        fileName: `${id}.md`,
        markdown: specResult.spec
      });
    }

    input.repository.updateStatus({ id, status: "checkpoint" });
    const summary = {
      currentUnderstanding: specResult.summary,
      recommendation: "Review and approve the specification",
      changedSinceLastCheckpoint: ["Spec generated"],
      openRisks: [],
      decisionsNeeded: ["Approve or revise the specification"]
    };
    input.repository.saveSummary({ sessionId: id, ...summary, artifactPath });

    return {
      session: input.repository.findById(id)!,
      summary,
      phaseResult: specResult,
      interviewState: buildInterviewState(id)
    };
  }
}
