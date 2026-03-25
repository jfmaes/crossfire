import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { ProviderAdapter } from "@council/adapters";
import type { SessionRepository, InterviewQuestionRow } from "@council/storage";
import { collectGroundingContext } from "./grounding";
import { writeSpecArtifact } from "./artifacts";
import { createPhaseOrchestrator } from "./phase-orchestrator";
import { onProgress } from "./progress";

interface CreateSessionInput {
  title: string;
  prompt: string;
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
        proposedBy: q.proposedBy,
        answer: q.answer
      })),
      currentQuestion: current
        ? { id: current.id, text: current.text, rationale: current.rationale }
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

  async function buildSessionPayload(id: string) {
    const session = input.repository.findById(id);
    const summary = input.repository.findSummaryBySessionId(id);

    if (!session || !summary) {
      return null;
    }

    // Legacy: auto-advance sessions stuck at analysis checkpoint.
    if (session.phase === "analysis" && session.status === "checkpoint") {
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

    return {
      session,
      activeRun: input.repository.findActiveRun(id) ?? undefined,
      recentRuns: input.repository.findRunsBySession(id),
      summary,
      interviewState: buildInterviewState(id),
      phaseResult: session.phase ? getPhaseResult(id, session.phase) : null,
      analysisResult: getPhaseResult(id, "analysis") ?? undefined
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

    input.repository.savePhaseResult({
      sessionId: id,
      phase: "analysis_debate",
      resultJson: JSON.stringify(debateResult)
    });

    const questionRows: InterviewQuestionRow[] = debateResult.synthesizedQuestions.length > 0
      ? debateResult.synthesizedQuestions.map((q, i) => ({
          id: q.id,
          sessionId: id,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          proposedBy: q.proposedBy,
          answer: null,
          sortOrder: i
        }))
      : analysisResult.proposedQuestions.map((q, i) => ({
          id: randomUUID(),
          sessionId: id,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          proposedBy: q.proposedBy,
          answer: null,
          sortOrder: i
        }));

    if (questionRows.length > 0) {
      input.repository.saveInterviewQuestions(questionRows);
    }

    const interviewState = buildInterviewState(id);

    // If no questions were produced, skip straight to approach debate.
    if (!interviewState.currentQuestion) {
      return advanceToApproachDebate(id, prompt, options?.runId);
    }

    input.repository.updatePhase({ id, phase: "interview" });
    input.repository.updateStatus({ id, status: "interviewing" });

    const summary = {
      currentUnderstanding: "Analysis complete. Answer the interview questions below.",
      recommendation: interviewState.currentQuestion.text,
      changedSinceLastCheckpoint: options?.restarted
        ? ["Session restarted", "Analysis complete"]
        : ["Analysis complete"],
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
      analysisResult: {
        ...analysisResult,
        debateSummary: debateResult.debateSummary
      },
      interviewState
    };
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
  }) {
    if (sessionLocks.has(inputRun.sessionId)) {
      return buildSessionPayload(inputRun.sessionId);
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
    return buildSessionPayload(inputRun.sessionId);
  }

  return {
    async createSession(payload: CreateSessionInput) {
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
        prompt
      });
      return enqueueRun({
        sessionId: id,
        kind: "create",
        phase: "analysis",
        summary: {
          currentUnderstanding: "Session created. Phase 1 is starting.",
          recommendation: "Watch live progress while Crossfire runs the initial analysis and question synthesis.",
          changedSinceLastCheckpoint: ["Session created"],
          openRisks: [],
          decisionsNeeded: []
        },
        task: async (runId) => {
          await runSessionFromScratch(id, prompt, { runId });
        }
      });
    },

    async continueSession(payload: { id: string; humanResponse: string }) {
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

    async getSession(id: string) {
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

    async restartSession(id: string) {
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
          prompt
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
        input.repository.savePhaseResult({
          sessionId: id, phase: "analysis_debate",
          resultJson: JSON.stringify(debateResult)
        });

        const questionRows: InterviewQuestionRow[] = (debateResult.synthesizedQuestions.length > 0
          ? debateResult.synthesizedQuestions
          : analysisResult.proposedQuestions.map((q) => ({ ...q, id: randomUUID() }))
        ).map((q, i) => ({
          id: q.id ?? randomUUID(),
          sessionId: id,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          proposedBy: q.proposedBy,
          answer: null,
          sortOrder: i
        }));
        if (questionRows.length > 0) {
          input.repository.saveInterviewQuestions(questionRows);
        }

        const interviewState = buildInterviewState(id);

        if (!interviewState.currentQuestion) {
          return advanceToApproachDebate(id, originalPrompt, runId);
        }

        input.repository.updatePhase({ id, phase: "interview" });
        input.repository.updateStatus({ id, status: "interviewing" });

        const summary = {
          currentUnderstanding: "Analysis complete. Answer the interview questions below.",
          recommendation: interviewState.currentQuestion.text,
          changedSinceLastCheckpoint: ["Analysis retried"],
          openRisks: [],
          decisionsNeeded: []
        };
        input.repository.saveSummary({ sessionId: id, ...summary, artifactPath: null });

        return {
          session: input.repository.findById(id)!,
          summary,
          analysisResult: { ...analysisResult, debateSummary: debateResult.debateSummary },
          interviewState
        };
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
          analysisResult: getPhaseResult(id, "analysis") ?? undefined
        };
      }

      case "interview": {
        const questions = input.repository.findInterviewQuestions(id);
        const currentQuestion = questions.find((q) => q.answer === null);

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

        if (humanResponse.toLowerCase().trim() === "enough") {
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

        // Record the answer immediately — no per-question LLM evaluation.
        // The models will see all answers together during the approach debate,
        // which is both faster and gives them better context.
        input.repository.updateInterviewAnswer({ id: currentQuestion.id, answer: humanResponse });

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

    const questions = input.repository.findInterviewQuestions(id);
    const interviewResults = questions
      .filter((q) => q.answer !== null)
      .map((q) => ({ question: q.text, answer: q.answer! }));

    const previousSpecRow = input.repository.findPhaseResult(id, "spec_generation");
    const previousSpec = previousSpecRow ? JSON.parse(previousSpecRow.resultJson) : null;

    const approachWithFeedback = [
      previousSpec?.spec || "",
      "",
      "---",
      "",
      "HUMAN REVISION FEEDBACK:",
      feedback
    ].join("\n");

    let specResult;
    try {
      specResult = await phaseOrchestrator.runSpecGeneration(
        id, originalPrompt, interviewResults, approachWithFeedback, runId
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
      approachResult = await phaseOrchestrator.runApproachDebate(id, originalPrompt, interviewResults, runId);
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

    input.repository.updateStatus({ id, status: hasHumanQuestions ? "waiting_for_human" : "checkpoint" });
    const summary = {
      currentUnderstanding: approachResult.convergedApproach,
      recommendation: hasHumanQuestions
        ? "The models need clarification before they can converge."
        : "Review the converged approach before spec generation",
      changedSinceLastCheckpoint: approachResult.turns.map((t) => `${t.actor}: ${t.summary}`),
      openRisks: [],
      decisionsNeeded: hasHumanQuestions
        ? approachResult.questionsForHuman
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
    let approachResult = approachData?.convergedApproach || "";

    if (humanFeedback && humanFeedback.trim()) {
      approachResult += `\n\n---\n\nHUMAN FEEDBACK ON APPROACH:\n${humanFeedback}`;
    }

    let specResult;
    try {
      specResult = await phaseOrchestrator.runSpecGeneration(
        id, originalPrompt, interviewResults, approachResult, runId
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
