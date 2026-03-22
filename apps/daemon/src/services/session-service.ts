import { randomUUID } from "node:crypto";
import type { ProviderAdapter } from "@council/adapters";
import type { SessionRepository, InterviewQuestionRow } from "@council/storage";
import { collectGroundingContext } from "./grounding";
import { writeSpecArtifact } from "./artifacts";
import { createPhaseOrchestrator } from "./phase-orchestrator";

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

      // Step 1: Dual independent analysis
      let analysisResult;
      try {
        analysisResult = await phaseOrchestrator.runDualAnalysis(id, prompt);
      } catch (error) {
        input.repository.updateStatus({ id, status: "errored" });
        throw error;
      }

      input.repository.savePhaseResult({
        sessionId: id,
        phase: "analysis",
        resultJson: JSON.stringify(analysisResult)
      });

      // Step 2: Immediately debate the proposed questions — no checkpoint between
      let debateResult;
      try {
        debateResult = await phaseOrchestrator.runQuestionDebate(
          id,
          prompt,
          analysisResult.gptAnalysis,
          analysisResult.claudeAnalysis,
          analysisResult.proposedQuestions
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

      // Save the debated/synthesized questions (not the raw unvetted ones)
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
        return advanceToApproachDebate(id, prompt);
      }

      // Auto-advance to interview — no checkpoint between analysis and interview.
      input.repository.updatePhase({ id, phase: "interview" });
      input.repository.updateStatus({ id, status: "interviewing" });

      const summary = {
        currentUnderstanding: "Analysis complete. Answer the interview questions below.",
        recommendation: interviewState.currentQuestion.text,
        changedSinceLastCheckpoint: ["Analysis complete"],
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
    },

    async continueSession(payload: { id: string; humanResponse: string }) {
      const session = input.repository.findById(payload.id);
      if (!session) {
        return null;
      }

      const lock = acquireSessionLock(payload.id);
      if (!lock.acquired) {
        throw new SessionConflictError(payload.id);
      }

      try {
        console.log(`\n━━━ Continue session: ${session.id.slice(0, 8)} ━━━`);
        console.log(`  Phase: ${session.phase}  Status: ${session.status}`);
        console.log(`  Human: "${payload.humanResponse.slice(0, 100)}${payload.humanResponse.length > 100 ? "..." : ""}"`);

        if (session.status === "errored") {
          console.log("  Retrying errored phase...");
          return retryPhase(session, payload.humanResponse);
        }

        return continuePhase(session, payload.humanResponse);
      } finally {
        lock.release();
      }
    },

    listSessions() {
      return input.repository.findAll();
    },

    async getSession(id: string) {
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
        summary,
        interviewState: buildInterviewState(id),
        phaseResult: session.phase ? getPhaseResult(id, session.phase) : null,
        analysisResult: getPhaseResult(id, "analysis") ?? undefined
      };
    },

    exportSession(id: string) {
      const session = input.repository.findById(id);
      if (!session) return null;

      const summary = input.repository.findSummaryBySessionId(id);
      const interviewQuestions = input.repository.findInterviewQuestions(id);
      const phaseResults = input.repository.findAllPhaseResults(id);

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
        summary: summary ?? null,
        interviewQuestions: interviewQuestions.map((q) => ({
          id: q.id,
          text: q.text,
          priority: q.priority,
          rationale: q.rationale,
          proposedBy: q.proposedBy,
          answer: q.answer
        })),
        phaseResults: phases
      };
    },

    async restartSession(id: string) {
      const session = input.repository.findById(id);
      if (!session) return null;

      const lock = acquireSessionLock(id);
      if (!lock.acquired) {
        throw new SessionConflictError(id);
      }

      try {
        // Clear cached CLI sessions so the restart starts fresh conversations.
        input.gpt.clearSession?.(id);
        input.claude.clearSession?.(id);

        const prompt = getOriginalPrompt(session);

        console.log(`\n━━━ Restart session: ${id.slice(0, 8)} ━━━`);
        console.log(`  Title: ${session.title}`);
        console.log(`  Original prompt: ${prompt.length} chars`);

        // Clear all phase data and re-run from scratch
        input.repository.deleteInterviewQuestions(id);
        input.repository.deletePhaseResults(id);
        input.repository.updatePhase({ id, phase: "analysis" });
        input.repository.updateStatus({ id, status: "debating" });

        // Re-run the full analysis + question debate
        let analysisResult;
        try {
          analysisResult = await phaseOrchestrator.runDualAnalysis(id, prompt);
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
            id, prompt,
            analysisResult.gptAnalysis, analysisResult.claudeAnalysis,
            analysisResult.proposedQuestions
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

        // If no questions, skip straight to approach debate.
        if (!interviewState.currentQuestion) {
          return advanceToApproachDebate(id, prompt);
        }

        input.repository.updatePhase({ id, phase: "interview" });
        input.repository.updateStatus({ id, status: "interviewing" });

        const summary = {
          currentUnderstanding: "Analysis complete. Answer the interview questions below.",
          recommendation: interviewState.currentQuestion.text,
          changedSinceLastCheckpoint: ["Session restarted", "Analysis complete"],
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
      } finally {
        lock.release();
      }
    },

    deleteSession(id: string) {
      input.repository.deleteSession(id);
    }
  };

  async function retryPhase(
    session: { id: string; title: string; status: string; phase?: string | null; prompt?: string | null },
    humanResponse: string
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
          analysisResult = await phaseOrchestrator.runDualAnalysis(id, originalPrompt);
        } catch (error) {
          input.repository.updateStatus({ id, status: "errored" });
          throw error;
        }

        let debateResult;
        try {
          debateResult = await phaseOrchestrator.runQuestionDebate(
            id, originalPrompt,
            analysisResult.gptAnalysis, analysisResult.claudeAnalysis,
            analysisResult.proposedQuestions
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
          return advanceToApproachDebate(id, originalPrompt);
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
        return advanceToApproachDebate(id, originalPrompt);
      }

      case "spec_generation": {
        // Re-run spec generation from the existing approach.
        input.repository.updateStatus({ id, status: "debating" });
        return advanceToSpecGeneration(id, originalPrompt);
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
          return advanceToApproachDebate(id, originalPrompt);
        }

        if (humanResponse.toLowerCase().trim() === "enough") {
          return advanceToApproachDebate(id, originalPrompt);
        }

        // Record the answer immediately — no per-question LLM evaluation.
        // The models will see all answers together during the approach debate,
        // which is both faster and gives them better context.
        input.repository.updateInterviewAnswer({ id: currentQuestion.id, answer: humanResponse });

        const updatedState = buildInterviewState(id);

        if (!updatedState.currentQuestion) {
          return advanceToApproachDebate(id, originalPrompt);
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
        return advanceToSpecGeneration(id, originalPrompt, humanResponse);
      }

      case "spec_generation": {
        if (humanResponse.toLowerCase().trim() === "approve") {
          return finalizeSpec(id);
        }
        return reviseSpec(id, originalPrompt, humanResponse);
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

  async function reviseSpec(id: string, originalPrompt: string, feedback: string) {
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
        id, originalPrompt, interviewResults, approachWithFeedback
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

  async function advanceToApproachDebate(id: string, originalPrompt: string) {
    input.repository.updatePhase({ id, phase: "approach_debate" });
    input.repository.updateStatus({ id, status: "debating" });

    const questions = input.repository.findInterviewQuestions(id);
    const interviewResults = questions
      .filter((q) => q.answer !== null)
      .map((q) => ({ question: q.text, answer: q.answer! }));

    let approachResult;
    try {
      approachResult = await phaseOrchestrator.runApproachDebate(id, originalPrompt, interviewResults);
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

  async function advanceToSpecGeneration(id: string, originalPrompt: string, humanFeedback?: string) {
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
        id, originalPrompt, interviewResults, approachResult
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
