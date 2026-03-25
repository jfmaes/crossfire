import "./styles/app.css";
import { CheckpointCard } from "./components/checkpoint-card";
import { RuntimeStatusCard } from "./components/runtime-status-card";
import { SessionForm } from "./components/session-form";
import { PhaseIndicator } from "./components/phase-indicator";
import { AnalysisCard } from "./components/analysis-card";
import { DebateCard } from "./components/debate-card";
import { InterviewCard } from "./components/interview-card";
import { SpecCard } from "./components/spec-card";
import { ProgressFeed } from "./components/progress-feed";
import { SessionList } from "./components/session-list";
import { RunHistory } from "./components/run-history";
import { RunDetail } from "./components/run-detail";
import {
  createSession,
  continueSession,
  restartSession,
  deleteSession,
  exportSession,
  getHealth,
  getSession,
  listSessions,
  type RuntimeStatus,
  type SessionPayload,
  type SessionListItem
} from "./lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

function parseHashRoute(): { sessionId: string | null; runId: string | null } {
  const runMatch = location.hash.match(/^#\/session\/([^/]+)\/run\/([^/]+)$/);
  if (runMatch) {
    return { sessionId: runMatch[1], runId: runMatch[2] };
  }

  const sessionMatch = location.hash.match(/^#\/session\/([^/]+)$/);
  if (sessionMatch) {
    return { sessionId: sessionMatch[1], runId: null };
  }

  return { sessionId: null, runId: null };
}

export function App() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [previousSessions, setPreviousSessions] = useState<SessionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [debateFeedbackLoading, setDebateFeedbackLoading] = useState(false);
  const [restartingSessionId, setRestartingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [progressResetToken, setProgressResetToken] = useState(0);
  const [restartStartedAt, setRestartStartedAt] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const actionRef = useRef<HTMLDivElement>(null);

  const token = localStorage.getItem("council-token") ?? "local-dev-token";

  const navigateTo = useCallback((sessionId: string | null, runId?: string | null) => {
    if (sessionId) {
      location.hash = runId
        ? `#/session/${sessionId}/run/${runId}`
        : `#/session/${sessionId}`;
    } else {
      location.hash = "";
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setError(null);
    try {
      const payload = await getSession({ sessionId: id, token });
      setSession(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session");
      setSession(null);
    }
  }, [token]);

  // Bootstrap: load health, session list, and handle initial hash route
  useEffect(() => {
    let active = true;

    void getHealth()
      .then((status) => { if (active) setRuntimeStatus(status); })
      .catch(() => { if (active) setRuntimeStatus(null); });

    void listSessions()
      .then((sessions) => { if (active) setPreviousSessions(sessions); })
      .catch(() => {});

    // Load session from URL hash on mount
    const route = parseHashRoute();
    if (route.sessionId) {
      if (route.runId) {
        setSelectedRunId(route.runId);
      }
      void loadSession(route.sessionId);
    }

    return () => { active = false; };
  }, [loadSession]);

  // Listen for hash changes (back/forward navigation)
  useEffect(() => {
    function onHashChange() {
      const route = parseHashRoute();
      if (route.sessionId) {
        setSelectedRunId(route.runId);
        void loadSession(route.sessionId);
      } else {
        setSelectedRunId(null);
        setSession(null);
      }
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadSession]);

  useEffect(() => {
    if (!session?.activeRun || !session.session.id) return;

    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = async () => {
      try {
        const payload = await getSession({ sessionId: session.session.id, token });
        if (cancelled) return;

        setPreviousSessions((prev) => prev.map((s) =>
          s.id === session.session.id
            ? { ...s, status: payload.session.status, phase: payload.session.phase }
            : s
        ));

        setSession(payload);
      } catch {
        // Ignore transient polling failures while a run is active
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(poll, 2000);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [session?.activeRun?.id, session?.session.id, token]);

  useEffect(() => {
    if (!restartingSessionId || !session || session.session.id !== restartingSessionId) {
      return;
    }

    if (!session.activeRun) {
      setRestartingSessionId(null);
      setRestartStartedAt(null);
    }
  }, [restartingSessionId, session]);

  useEffect(() => {
    if (!session) {
      setSelectedRunId(null);
      return;
    }

    const preferredRunId = session.activeRun?.id ?? session.recentRuns?.[0]?.id ?? null;
    const route = parseHashRoute();

    if (route.runId && session.recentRuns?.some((run) => run.id === route.runId)) {
      if (selectedRunId !== route.runId) {
        setSelectedRunId(route.runId);
      }
      return;
    }

    if (preferredRunId && !selectedRunId) {
      setSelectedRunId(preferredRunId);
      return;
    }

    if (selectedRunId && session.recentRuns?.some((run) => run.id === selectedRunId)) {
      return;
    }

    setSelectedRunId(preferredRunId);
  }, [session?.session.id, session?.activeRun?.id, session?.recentRuns, selectedRunId]);

  // Sync URL when session changes
  function setSessionAndNavigate(payload: SessionPayload | null) {
    setSession(payload);
    navigateTo(payload?.session.id ?? null, selectedRunId);
  }

  function handleSelectRun(runId: string) {
    if (!session) return;
    setSelectedRunId(runId);
    navigateTo(session.session.id, runId);
  }

  const phase = session?.session.phase;

  const canContinue =
    !session?.activeRun &&
    (
      session?.session.status === "checkpoint" ||
      session?.session.status === "waiting_for_human" ||
      session?.session.status === "interviewing" ||
      session?.session.status === "errored"
    );

  const isFinalized = session?.session.status === "finalized";
  const showCheckpointCard =
    !!session &&
    !session.activeRun &&
    (session.session.status === "checkpoint" || session.session.status === "waiting_for_human") &&
    session.summary.decisionsNeeded.length > 0;

  // Scroll to action area when checkpoint appears
  useEffect(() => {
    if (showCheckpointCard && actionRef.current) {
      actionRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [showCheckpointCard]);

  async function handleLoadSession(id: string) {
    navigateTo(id, null);
    await loadSession(id);
  }

  async function handleRestartSession(id: string) {
    if (restartingSessionId === id) {
      return;
    }

    setError(null);
    setRestartingSessionId(id);
    setRestartStartedAt(Date.now());
    setProgressResetToken((prev) => prev + 1);
    setPreviousSessions((prev) => prev.map((s) =>
      s.id === id ? { ...s, status: "debating", phase: "analysis" } : s
    ));

    if (session?.session.id === id) {
      setSession((prev) => prev ? {
        ...prev,
        session: {
          ...prev.session,
          status: "debating",
          phase: "analysis"
        },
        summary: {
          currentUnderstanding: "Restarting this session from scratch.",
          recommendation: "Phase 1 is running again. Watch the live progress feed while Crossfire reruns the workflow.",
          changedSinceLastCheckpoint: ["Session restart requested"],
          openRisks: [],
          decisionsNeeded: []
        },
        phaseResult: undefined,
        analysisResult: undefined,
        interviewState: undefined
      } : prev);
    }

    try {
      const payload = await restartSession({ sessionId: id, token });
      setRestartingSessionId(payload.session.id);
      setPreviousSessions((prev) => {
        const next = prev.map((s) =>
          s.id === id ? { ...s, status: payload.session.status, phase: payload.session.phase } : s
        );
        if (!next.some((s) => s.id === payload.session.id)) {
          next.unshift({
            id: payload.session.id,
            title: payload.session.title,
            status: payload.session.status,
            phase: payload.session.phase
          });
        }
        return next;
      });
      setSessionAndNavigate(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restart session";
      if (message.includes("already processing")) {
        setError("This session is already restarting. Watch the live progress feed; the page will update when the new checkpoint arrives.");
      } else {
        setError(message);
      }

      if (session?.session.id === id) {
        await loadSession(id).catch(() => {});
      }
    }
  }

  async function handleDeleteSession(id: string) {
    if (deletingSessionId === id || restartingSessionId === id) {
      return;
    }

    setError(null);
    setDeletingSessionId(id);
    try {
      await deleteSession({ sessionId: id, token });
      setPreviousSessions((prev) => prev.filter((s) => s.id !== id));
      if (session?.session.id === id) {
        setSessionAndNavigate(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    } finally {
      setDeletingSessionId(null);
    }
  }

  async function handleCreate(prompt: string) {
    setError(null);
    try {
      const payload = await createSession({
        title: prompt.slice(0, 80),
        prompt,
        token
      });
      setPreviousSessions((prev) => [
        { id: payload.session.id, title: payload.session.title, status: payload.session.status, phase: payload.session.phase },
        ...prev
      ]);
      setSessionAndNavigate(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function handleContinue(humanResponse: string) {
    if (!session) return;
    setError(null);
    try {
      const payload = await continueSession({
        sessionId: session.session.id,
        humanResponse,
        token
      });
      if (payload.activeRun) {
        setProgressResetToken((prev) => prev + 1);
      }
      setSession(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function getContinueLabel(): { label: string; placeholder: string; submitLabel: string; loadingLabel: string } {
    if (session?.session.status === "errored") {
      return {
        label: "Retry",
        placeholder: "Something went wrong. Type anything to retry the current phase, or provide additional context.",
        submitLabel: "Retry phase",
        loadingLabel: "Retrying..."
      };
    }
    if (phase === "interview") {
      return {
        label: "Your answer",
        placeholder: 'Answer the question above, or type "enough" to skip remaining questions.',
        submitLabel: "Submit answer",
        loadingLabel: "Models evaluating your answer..."
      };
    }
    if (phase === "spec_generation") {
      return {
        label: "Review",
        placeholder: 'Type "approve" to finalize the spec, or describe what needs to change for a revision.',
        submitLabel: "Submit",
        loadingLabel: "Generating revised spec..."
      };
    }

    return {
      label: "Your response",
      placeholder: "Respond to the checkpoint, provide clarifications, or guide the next round.",
      submitLabel: "Continue session",
      loadingLabel: phase === "approach_debate"
        ? "Generating specification (GPT drafts, Claude reviews)..."
        : "Models reasoning..."
    };
  }

  function getPhaseExplanation(): string {
    if (isFinalized) return "Session complete. The spec has been approved and finalized.";
    if (session && restartingSessionId === session.session.id && phase === "analysis") {
      return "Crossfire is rerunning this session from Phase 1. The previous checkpoint has been cleared from the viewer.";
    }
    if (session?.activeRun) {
      switch (phase) {
        case "analysis":
          return "Both models are in Phase 1, analyzing the problem independently before they synthesize interview questions.";
        case "approach_debate":
          return "The models are actively debating the best technical approach based on the interview answers.";
        case "spec_generation":
          return "GPT and Claude are actively generating and reviewing the specification and implementation plan.";
        default:
          return "Crossfire is actively processing this session.";
      }
    }

    switch (phase) {
      case "analysis":
        return "Both models are back in Phase 1, analyzing the problem independently before they synthesize interview questions.";
      case "interview":
        return "Both models analyzed your problem independently. Now they're interviewing you to understand your constraints. Answer each question — your answers directly shape the architecture.";
      case "approach_debate":
        return "Using your interview answers, the models debated the best technical approach until they reached consensus.";
      case "spec_generation":
        return "GPT drafted a specification, Claude reviewed and refined it. Review the spec below.";
      default:
        return "";
    }
  }

  function getNextAction(): string {
    if (isFinalized) return "Restart to re-run with updated logic, or start a new session.";
    if (session && restartingSessionId === session.session.id && phase === "analysis") {
      return "Wait for Phase 1 to finish, or follow the live progress below.";
    }
    if (session?.activeRun) {
      return "Watch the live progress feed. Human input is disabled until the current run reaches the next checkpoint.";
    }
    if (session?.session.status === "errored") return "Something went wrong. You can retry the current phase below.";

    switch (phase) {
      case "analysis":
        return "Crossfire is rebuilding the session from the start. You do not need to provide input yet.";
      case "interview":
        return 'Answer the question above, or type "enough" to skip to the approach debate.';
      case "approach_debate":
        return 'Review the converged approach, then click "Continue session" to generate the spec.';
      case "spec_generation":
        return 'Type "approve" to finalize, or describe what needs to change for a revision.';
      default:
        return "";
    }
  }

  function renderAnalysisCard() {
    const analysis = session?.analysisResult;
    if (!analysis) return null;
    return <AnalysisCard result={analysis} />;
  }

  function renderPhaseContent() {
    if (!session || !phase) return null;

    const phaseResult = session.phaseResult as Record<string, unknown> | undefined;

    switch (phase) {
      case "interview":
        return (
          <>
            {renderAnalysisCard()}
            {session.interviewState && (
              <InterviewCard state={session.interviewState} />
            )}
          </>
        );

      case "approach_debate":
        if (phaseResult && "convergedApproach" in phaseResult) {
          const isCheckpoint = session.session.status === "checkpoint" || session.session.status === "waiting_for_human";
          return (
            <DebateCard
              title="Approach Debate"
              badge="Phase 3"
              summary={session.summary.currentUnderstanding}
              turns={(phaseResult.turns as Array<{ actor: string; summary: string; disagreements?: string[]; rawText?: string }>) || []}
              convergedApproach={phaseResult.convergedApproach as string}
              canSubmitFeedback={isCheckpoint}
              feedbackLoading={debateFeedbackLoading}
              onSubmitFeedback={isCheckpoint ? async (feedback: string) => {
                setDebateFeedbackLoading(true);
                try {
                  await handleContinue(feedback);
                } finally {
                  setDebateFeedbackLoading(false);
                }
              } : undefined}
            />
          );
        }
        return null;

      case "spec_generation":
        if (phaseResult && "spec" in phaseResult) {
          return (
            <SpecCard
              result={phaseResult as { spec: string; implementationPlan?: string; summary: string }}
              isFinalized={session.session.status === "finalized"}
              sessionId={session.session.id}
            />
          );
        }
        return null;

      default:
        return null;
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <a href="#" className="hero__home" onClick={(e) => { e.preventDefault(); setSessionAndNavigate(null); }}>
          <p className="eyebrow">Local dual-LLM workshop</p>
          <h1>Crossfire</h1>
        </a>
        <p className="lede">
          Two local AI collaborators, one bounded reasoning loop, and checkpoints that keep the human
          in control.
        </p>
      </header>

      {!session && (
        <>
          <SessionForm onCreate={handleCreate} showGrounding loadingLabel="Analyzing problem & debating questions (GPT + Claude)..." />
          <SessionList
            sessions={previousSessions}
            onSelect={handleLoadSession}
            onRestart={handleRestartSession}
            onDelete={handleDeleteSession}
            restartingSessionId={restartingSessionId}
            deletingSessionId={deletingSessionId}
          />
        </>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner__icon">!</span>
          <p>{error}</p>
          <button className="error-banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss error">&times;</button>
        </div>
      )}

      {session && (
        <details className="session-prompt-bar">
          <summary className="session-prompt-bar__summary">
            <span className="session-prompt-bar__label">Prompt</span>
            <span className="session-prompt-bar__preview">
              {session.session.prompt ?? session.session.title}
            </span>
          </summary>
          <p className="session-prompt-bar__full">
            {session.session.prompt ?? session.session.title}
          </p>
        </details>
      )}

      {session && phase && <PhaseIndicator currentPhase={phase} />}

      <ProgressFeed
        sessionId={session?.session.id ?? null}
        runId={session?.activeRun?.id ?? null}
        resetToken={progressResetToken}
        pendingState={
          session?.activeRun
            ? {
                title: session.activeRun.kind === "restart"
                  ? "Restarting session"
                  : session.activeRun.kind === "create"
                    ? "Starting session"
                    : session.activeRun.kind === "revise"
                      ? "Revising specification"
                      : "Processing session",
                detail: "Waiting for fresh progress from the daemon…",
                startedAt: Date.parse(session.activeRun.startedAt)
              }
            : session && restartingSessionId === session.session.id
            ? {
                title: "Restarting session",
                detail: "Reset complete. Waiting for fresh Phase 1 progress from the daemon…",
                startedAt: restartStartedAt ?? Date.now()
              }
            : null
        }
      />

      {session && phase && (
        <div className="phase-guidance">
          <span className="phase-guidance__what">{getPhaseExplanation()}</span>
          <span className="phase-guidance__next">{getNextAction()}</span>
        </div>
      )}

      {renderPhaseContent()}

      {!session && (
        <section className="card-grid">
          <RuntimeStatusCard status={runtimeStatus} />
        </section>
      )}

      {showCheckpointCard && (
        <div ref={actionRef}>
          <CheckpointCard summary={session.summary} />
        </div>
      )}

      {session?.recentRuns && session.recentRuns.length > 0 && (
        <RunHistory
          runs={session.recentRuns}
          activeRunId={session.activeRun?.id ?? null}
          selectedRunId={selectedRunId}
          onSelect={handleSelectRun}
        />
      )}

      {session?.recentRuns && session.recentRuns.length > 0 && (
        <RunDetail
          run={session.recentRuns.find((run) => run.id === selectedRunId) ?? null}
        />
      )}

      {canContinue && phase !== "approach_debate" && (() => {
        const labels = getContinueLabel();
        return (
          <section className="continue-section">
            <SessionForm
              key={session!.session.id + session!.session.status + (phase ?? "") + (session!.interviewState?.answeredCount ?? 0)}
              label={labels.label}
              placeholder={labels.placeholder}
              submitLabel={labels.submitLabel}
              loadingLabel={labels.loadingLabel}
              onCreate={handleContinue}
            />
          </section>
        );
      })()}

      {isFinalized && (
        <div className="finalized-banner">
          This session is finalized. You can restart it to re-run with updated logic, or start a new one.
        </div>
      )}

      {session && (
        <div className="session-actions">
          <button
            className="session-actions__btn session-actions__btn--export"
            onClick={() => {
              exportSession({ sessionId: session.session.id, token }).catch((err) => {
                setError(err instanceof Error ? err.message : "Failed to export session");
              });
            }}
          >
            Export session data
          </button>
          <button
            className="session-actions__btn session-actions__btn--restart"
            onClick={() => handleRestartSession(session.session.id)}
            disabled={restartingSessionId === session.session.id}
          >
            {restartingSessionId === session.session.id ? "Restarting session…" : "Restart session"}
          </button>
          <button
            className="session-actions__btn session-actions__btn--new"
            onClick={() => setSessionAndNavigate(null)}
            disabled={restartingSessionId === session.session.id}
          >
            New session
          </button>
        </div>
      )}

      <footer className="app-footer">
        <p>Crossfire &middot; adversarial dual-LLM spec workshop</p>
      </footer>
    </main>
  );
}
