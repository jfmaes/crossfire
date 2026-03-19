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
import {
  createSession,
  continueSession,
  restartSession,
  deleteSession,
  getHealth,
  getSession,
  listSessions,
  type RuntimeStatus,
  type SessionPayload,
  type SessionListItem
} from "./lib/api";
import { useCallback, useEffect, useState } from "react";

function getHashSessionId(): string | null {
  const match = location.hash.match(/^#\/session\/(.+)/);
  return match ? match[1] : null;
}

export function App() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [previousSessions, setPreviousSessions] = useState<SessionListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("council-token") ?? "local-dev-token";

  const navigateTo = useCallback((sessionId: string | null) => {
    if (sessionId) {
      location.hash = `#/session/${sessionId}`;
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
    const hashId = getHashSessionId();
    if (hashId) {
      void loadSession(hashId);
    }

    return () => { active = false; };
  }, [loadSession]);

  // Listen for hash changes (back/forward navigation)
  useEffect(() => {
    function onHashChange() {
      const hashId = getHashSessionId();
      if (hashId) {
        void loadSession(hashId);
      } else {
        setSession(null);
      }
    }

    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadSession]);

  // Sync URL when session changes
  function setSessionAndNavigate(payload: SessionPayload | null) {
    setSession(payload);
    navigateTo(payload?.session.id ?? null);
  }

  const phase = session?.session.phase;

  const canContinue =
    session?.session.status === "checkpoint" ||
    session?.session.status === "waiting_for_human" ||
    session?.session.status === "interviewing" ||
    session?.session.status === "errored";

  const isFinalized = session?.session.status === "finalized";

  async function handleLoadSession(id: string) {
    navigateTo(id);
    await loadSession(id);
  }

  async function handleRestartSession(id: string) {
    setError(null);
    try {
      const payload = await restartSession({ sessionId: id, token });
      setSessionAndNavigate(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restart session");
    }
  }

  async function handleDeleteSession(id: string) {
    setError(null);
    try {
      await deleteSession({ sessionId: id, token });
      setPreviousSessions((prev) => prev.filter((s) => s.id !== id));
      if (session?.session.id === id) {
        setSessionAndNavigate(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete session");
    }
  }

  async function handleCreate(prompt: string, groundingRoot?: string) {
    setError(null);
    try {
      const payload = await createSession({
        title: prompt.slice(0, 80),
        prompt,
        token,
        groundingRoot
      });
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

    const phaseLabels: Record<string, string> = {
      analysis: "Starting interview phase...",
      approach_debate: "Generating specification (GPT drafts, Claude reviews)..."
    };

    return {
      label: "Your response",
      placeholder: "Respond to the checkpoint, provide clarifications, or guide the next round.",
      submitLabel: "Continue session",
      loadingLabel: phaseLabels[phase ?? ""] ?? "Models reasoning..."
    };
  }

  function getPhaseExplanation(): string {
    if (isFinalized) return "Session complete. The spec has been approved and finalized.";

    switch (phase) {
      case "analysis":
        return "Both models independently analyzed your problem, then debated which questions to ask you. Below are their analyses and the agreed interview questions.";
      case "interview":
        return "The models are interviewing you to understand your constraints. Answer each question — your answers directly shape the architecture.";
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
    if (session?.session.status === "errored") return "Something went wrong. You can retry the current phase below.";

    switch (phase) {
      case "analysis":
        return "Review the analyses and questions, then click \"Continue session\" to start the interview.";
      case "interview":
        return "Answer the question above, or type \"enough\" to skip to the approach debate.";
      case "approach_debate":
        return "Review the converged approach, then click \"Continue session\" to generate the spec.";
      case "spec_generation":
        return "Type \"approve\" to finalize, or describe what needs to change for a revision.";
      default:
        return "";
    }
  }

  function renderPhaseContent() {
    if (!session || !phase) return null;

    const phaseResult = session.phaseResult as Record<string, unknown> | undefined;

    switch (phase) {
      case "analysis":
        if (phaseResult && "gptAnalysis" in phaseResult) {
          return (
            <>
              <AnalysisCard
                result={phaseResult as {
                  gptAnalysis: string;
                  claudeAnalysis: string;
                  proposedQuestions: Array<{
                    text: string;
                    priority: number;
                    rationale: string;
                    proposedBy: string;
                  }>;
                }}
              />
              {(phaseResult as Record<string, unknown>).debateSummary && (
                <DebateCard
                  title="Question Debate"
                  badge="Agreed questions"
                  summary={(phaseResult as Record<string, unknown>).debateSummary as string}
                />
              )}
            </>
          );
        }
        return null;

      case "interview":
        if (session.interviewState) {
          const evaluation = phaseResult && "evaluation" in phaseResult
            ? (phaseResult.evaluation as string)
            : null;
          return <InterviewCard state={session.interviewState} evaluation={evaluation} />;
        }
        return null;

      case "approach_debate":
        if (phaseResult && "convergedApproach" in phaseResult) {
          return (
            <DebateCard
              title="Approach Debate"
              badge="Phase 3"
              summary={session.summary.currentUnderstanding}
              turns={(phaseResult.turns as Array<{ actor: string; summary: string }>) || []}
              convergedApproach={phaseResult.convergedApproach as string}
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
        <div className="session-prompt-bar">
          <span className="session-prompt-bar__label">Prompt</span>
          <p className="session-prompt-bar__text">
            {session.session.prompt ?? session.session.title}
          </p>
        </div>
      )}

      {session && phase && <PhaseIndicator currentPhase={phase} />}

      <ProgressFeed sessionId={session?.session.id ?? null} />

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

      {session && session.summary.decisionsNeeded.length > 0 && (
        <CheckpointCard summary={session.summary} />
      )}

      {canContinue && (() => {
        const labels = getContinueLabel();
        return (
          <section className="continue-section">
            <SessionForm
              key={session!.session.id + session!.session.status + (phase ?? "")}
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
            className="session-actions__btn session-actions__btn--restart"
            onClick={() => handleRestartSession(session.session.id)}
          >
            Restart session
          </button>
          <button
            className="session-actions__btn session-actions__btn--new"
            onClick={() => setSessionAndNavigate(null)}
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
