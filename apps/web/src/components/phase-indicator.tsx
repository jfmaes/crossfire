const PHASES = [
  { key: "analysis", label: "Analysis & Questions" },
  { key: "interview", label: "Interview" },
  { key: "approach_debate", label: "Approach Debate" },
  { key: "spec_generation", label: "Spec Generation" }
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
              <span className="phase-indicator__number">{i + 1}</span>
              <span className="phase-indicator__label">{phase.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
