const PHASES = [
  { key: "analysis", label: "Analysis", desc: "Problem understanding" },
  { key: "interview", label: "Interview", desc: "Clarifying questions" },
  { key: "approach_debate", label: "Approach Debate", desc: "Technical discussion" },
  { key: "spec_generation", label: "Spec Generation", desc: "Final specification" }
];

export function PhaseIndicator({ currentPhase }: { currentPhase: string }) {
  const currentIndex = PHASES.findIndex((p) => p.key === currentPhase);

  return (
    <nav className="phase-indicator" aria-label="Session phases">
      <ol className="phase-indicator__list">
        {PHASES.map((phase, i) => {
          let state: "completed" | "current" | "upcoming";
          if (i < currentIndex) state = "completed";
          else if (i === currentIndex) state = "current";
          else state = "upcoming";

          return (
            <li
              key={phase.key}
              className={`phase-indicator__step phase-indicator__step--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="phase-indicator__number">
                {state === "completed" ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className="phase-indicator__text">
                <span className="phase-indicator__label">{phase.label}</span>
                <span className="phase-indicator__desc">{phase.desc}</span>
              </span>
              {i < PHASES.length - 1 && (
                <span className={`phase-indicator__connector phase-indicator__connector--${i < currentIndex ? "done" : "pending"}`} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
