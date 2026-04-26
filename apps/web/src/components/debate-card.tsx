import { useState, type Ref } from "react";
import type { DebateTrace } from "../lib/api";
import { MarkdownContent } from "./markdown-content";

interface DebateTurn {
  actor: string;
  summary: string;
  disagreements?: string[];
  rawText?: string;
}

interface Challenge {
  number: number;
  title: string;
  body: string;
}

interface DebateCardProps {
  title: string;
  badge: string;
  summary: string;
  turns?: DebateTurn[];
  convergedApproach?: string;
  questionsForHuman?: string[];
  canSubmitFeedback?: boolean;
  onSubmitFeedback?: (feedback: string) => void;
  feedbackLoading?: boolean;
  trace?: DebateTrace;
  submitRef?: Ref<HTMLDivElement>;
}

function formatStopReason(reason?: string | null): string | null {
  switch (reason) {
    case "consensus":
      return "Consensus reached";
    case "questions_for_human":
      return "Clarification needed";
    case "max_turns":
      return "Turn cap reached";
    case "phase_invalid_turn":
      return "Invalid turn output";
    default:
      return reason ? reason.replaceAll("_", " ") : null;
  }
}

/**
 * Parse the converged approach text into individual challenges.
 * Models typically format them as "**Challenge N: title**\nbody..."
 * or "### Challenge N: title\nbody..."
 */
function parseChallenges(text: string): Challenge[] {
  const regex = /(?:^|\n)\s*(?:\*\*|#{1,4}\s*)?Challenge\s+(\d+)\s*[:.]?\s*(.*?)(?:\*\*)?(?:\n|$)/gi;
  const matches = [...text.matchAll(regex)];

  if (matches.length === 0) return [];

  const challenges: Challenge[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = match.index! + match[0].length;
    const end = i < matches.length - 1 ? matches[i + 1].index! : text.length;
    const body = text.slice(start, end).trim();

    challenges.push({
      number: parseInt(match[1]),
      title: match[2].trim().replace(/\*+$/, ""),
      body
    });
  }

  return challenges;
}

/**
 * Extract the consensus fix from a challenge body.
 * Looks for patterns like "Proposed fix:", "Resolution:", "Recommendation:", "Consensus fix:"
 */
function splitConsensusFix(body: string): { analysis: string; fix: string | null } {
  const fixPatterns = [
    /(?:^|\n)\s*(?:\*\*)?(?:Proposed fix|Resolution|Recommendation|Consensus fix|Consensus|Fix|Recommended approach|Proposed resolution)[:\s]*(?:\*\*)?/i
  ];

  for (const pattern of fixPatterns) {
    const match = body.match(pattern);
    if (match && match.index !== undefined) {
      const analysis = body.slice(0, match.index).trim();
      const fix = body.slice(match.index + match[0].length).trim();
      if (fix.length > 0) {
        return { analysis, fix };
      }
    }
  }

  return { analysis: body, fix: null };
}

/**
 * Collect unique disagreements across all turns to show the challenge lifecycle.
 */
function collectDisagreementTimeline(turns: DebateTurn[]): Array<{
  text: string;
  raisedBy: string;
  raisedInTurn: number;
  resolvedInTurn: number | null;
}> {
  const seen = new Map<string, { text: string; raisedBy: string; raisedInTurn: number; lastSeenTurn: number }>();

  turns.forEach((turn, i) => {
    const turnNum = i + 1;
    if (turn.disagreements) {
      for (const disagreement of turn.disagreements) {
        const key = disagreement.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.set(key, {
            text: disagreement,
            raisedBy: turn.actor,
            raisedInTurn: turnNum,
            lastSeenTurn: turnNum
          });
        } else {
          seen.get(key)!.lastSeenTurn = turnNum;
        }
      }
    }
  });

  const totalTurns = turns.length;
  return [...seen.values()].map((item) => ({
    text: item.text,
    raisedBy: item.raisedBy,
    raisedInTurn: item.raisedInTurn,
    resolvedInTurn: item.lastSeenTurn < totalTurns ? item.lastSeenTurn + 1 : null
  }));
}

export function DebateCard({
  title,
  badge,
  summary,
  turns,
  convergedApproach,
  questionsForHuman,
  canSubmitFeedback,
  onSubmitFeedback,
  feedbackLoading,
  trace,
  submitRef
}: DebateCardProps) {
  const challenges = convergedApproach ? parseChallenges(convergedApproach) : [];
  const [challengeFeedback, setChallengeFeedback] = useState<Record<number, string>>({});
  const [generalFeedback, setGeneralFeedback] = useState("");
  const timeline = turns ? collectDisagreementTimeline(turns) : [];
  const clarificationQuestions = questionsForHuman ?? trace?.questionsForHuman ?? [];
  const finalDisagreements = trace?.finalDisagreements ?? [];
  const turnsUsed = trace?.turnsUsed ?? trace?.totalTurns;
  const clarificationNeeded = trace?.stopReason === "questions_for_human" || clarificationQuestions.length > 0;
  const unresolvedAtTurnCap = trace?.stopReason === "max_turns" && finalDisagreements.length > 0;
  const requiresExplicitDecision = clarificationNeeded || unresolvedAtTurnCap;

  function handleFeedbackChange(challengeNum: number, value: string) {
    setChallengeFeedback((prev) => ({ ...prev, [challengeNum]: value }));
  }

  const challengeFeedbackParts = challenges.flatMap((challenge) => {
    const feedback = challengeFeedback[challenge.number]?.trim();
    return feedback ? [`[Challenge ${challenge.number}: ${challenge.title}]\n${feedback}`] : [];
  });
  const generalFeedbackTrimmed = generalFeedback.trim();
  const hasAnyFeedback = challengeFeedbackParts.length > 0 || generalFeedbackTrimmed.length > 0;

  function handleSubmit() {
    if (!onSubmitFeedback) return;

    const parts = [...challengeFeedbackParts];

    if (generalFeedbackTrimmed) {
      parts.push(`[General feedback]\n${generalFeedbackTrimmed}`);
    }

    const fallback = requiresExplicitDecision
      ? ""
      : "Approved — proceed to spec generation";
    const combined = parts.length > 0 ? parts.join("\n\n") : fallback;

    if (!combined) return;
    onSubmitFeedback(combined);
  }

  function submitLabel(): string {
    if (clarificationNeeded) return "Submit clarification & continue debate";
    if (unresolvedAtTurnCap) return "Submit decision & continue";
    return "Submit feedback & generate spec";
  }

  function loadingLabel(): string {
    if (clarificationNeeded) return "Continuing debate with your clarification...";
    if (unresolvedAtTurnCap) return "Continuing with your decision...";
    return "Generating spec from approach...";
  }

  function feedbackPlaceholder(): string {
    if (clarificationNeeded) return "Provide the clarification the models asked for...";
    if (unresolvedAtTurnCap) return "State your judgment or direction for how Crossfire should proceed...";
    return "General feedback on the approach (optional)...";
  }

  function renderFeedbackSubmit() {
    if (!canSubmitFeedback || !onSubmitFeedback) {
      return null;
    }

    const requiredItems = clarificationNeeded ? clarificationQuestions
      : unresolvedAtTurnCap ? finalDisagreements
      : [];
    const requiredTitle = clarificationNeeded ? "Clarifications to answer" : "Open disagreements to resolve";

    return (
      <div className="challenge-feedback-submit" ref={submitRef}>
        {requiresExplicitDecision && requiredItems.length > 0 && (
          <div className="challenge-feedback-submit__context">
            <h3>{requiredTitle}</h3>
            <ol className="challenge-feedback-submit__list">
              {requiredItems.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ol>
          </div>
        )}
        <textarea
          className="challenge-card__feedback-input challenge-card__feedback-input--general"
          placeholder={feedbackPlaceholder()}
          value={generalFeedback}
          onChange={(event) => setGeneralFeedback(event.target.value)}
          rows={3}
        />
        {requiresExplicitDecision && !hasAnyFeedback && (
          <p className="question-source">Human input is required before Crossfire can continue from this checkpoint.</p>
        )}
        <button
          className="challenge-feedback-submit__btn"
          onClick={handleSubmit}
          disabled={feedbackLoading || (requiresExplicitDecision && !hasAnyFeedback)}
        >
          {feedbackLoading ? (
            <span className="btn-loading">
              <span className="spinner" />
              {loadingLabel()}
            </span>
          ) : (
            submitLabel()
          )}
        </button>
      </div>
    );
  }

  let preText = "";
  if (convergedApproach && challenges.length > 0) {
    const firstChallengeMatch = convergedApproach.match(/(?:\*\*|#{1,4}\s*)?Challenge\s+\d+/i);
    if (firstChallengeMatch && firstChallengeMatch.index && firstChallengeMatch.index > 0) {
      preText = convergedApproach.slice(0, firstChallengeMatch.index).trim();
    }
  }

  return (
    <article className="card card--debate">
      <div className="card__header">
        <h2>{title}</h2>
        <span className="card__badge">{badge}</span>
      </div>

      {trace && (
        <div className="trace-summary">
          <div className="trace-pill-row">
            {formatStopReason(trace.stopReason) && (
              <span className={`trace-pill ${unresolvedAtTurnCap || clarificationNeeded ? "trace-pill--warning" : ""}`}>
                Outcome: {formatStopReason(trace.stopReason)}
              </span>
            )}
            {typeof turnsUsed === "number" && typeof trace.maxTurns === "number" && (
              <span className="trace-pill">Turns: {turnsUsed}/{trace.maxTurns}</span>
            )}
            {typeof trace.finalDisagreementCount === "number" && (
              <span className={`trace-pill ${trace.finalDisagreementCount > 0 ? "trace-pill--warning" : ""}`}>
                Final disagreements: {trace.finalDisagreementCount}
              </span>
            )}
          </div>
        </div>
      )}

      {clarificationNeeded && (
        <section className="debate-unresolved">
          <div className="debate-unresolved__header">
            <div>
              <span className="debate-unresolved__badge">Clarification needed</span>
              <h3 className="debate-unresolved__title">The debate paused for your input</h3>
            </div>
            <span className="debate-unresolved__count">
              {clarificationQuestions.length} open
            </span>
          </div>

          <p className="debate-unresolved__summary">
            The models stopped because they need clarification before they can reach a stable approach. Answer the open questions below, then continue the debate.
          </p>

          {clarificationQuestions.length > 0 && (
            <ol className="debate-unresolved__list">
              {clarificationQuestions.map((question, index) => (
                <li key={question} className="debate-unresolved__item">
                  <span className="debate-unresolved__item-number">{index + 1}</span>
                  <span className="debate-unresolved__item-text">{question}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {unresolvedAtTurnCap && (
        <section className="debate-unresolved">
          <div className="debate-unresolved__header">
            <div>
              <span className="debate-unresolved__badge">Needs human judgment</span>
              <h3 className="debate-unresolved__title">Remaining disagreements</h3>
            </div>
            <span className="debate-unresolved__count">
              {finalDisagreements.length} open
            </span>
          </div>

          <p className="debate-unresolved__summary">
            The models reached the maximum debate length before they fully agreed. Review the unresolved points below before deciding whether to continue, rewind, or proceed anyway.
          </p>

          <ol className="debate-unresolved__list">
            {finalDisagreements.map((disagreement, index) => (
              <li key={disagreement} className="debate-unresolved__item">
                <span className="debate-unresolved__item-number">{index + 1}</span>
                <span className="debate-unresolved__item-text">{disagreement}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {turns && turns.length > 0 && (
        <div className="checkpoint-section">
          <h3>Debate turns</h3>
          <div className="debate-turns">
            {turns.map((turn, i) => {
              const disagreementCount = turn.disagreements?.length ?? 0;
              return (
                <div key={i} className={`debate-turn debate-turn--${turn.actor}`}>
                  <div className="debate-turn__header">
                    <span className="debate-turn__actor">
                      {turn.actor === "gpt" ? "Dr. Chen (GPT)" : "Dr. Rivera (Claude)"}
                    </span>
                    <span className={`debate-turn__disagreements ${disagreementCount === 0 ? "debate-turn__disagreements--zero" : ""}`}>
                      {disagreementCount} disagreement{disagreementCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <MarkdownContent text={turn.summary} />
                  {turn.disagreements && turn.disagreements.length > 0 && (
                    <ul className="debate-turn__disagreement-list">
                      {turn.disagreements.map((disagreement, index) => (
                        <li key={index}>{disagreement}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {timeline.length > 0 && (
        <div className="checkpoint-section">
          <h3>Disagreement resolution</h3>
          <div className="disagreement-timeline">
            {timeline.map((item, index) => (
              <div key={index} className={`disagreement-item ${item.resolvedInTurn ? "disagreement-item--resolved" : "disagreement-item--open"}`}>
                <span className="disagreement-item__status">
                  {item.resolvedInTurn ? "Resolved" : "Open"}
                </span>
                <span className="disagreement-item__text">{item.text}</span>
                <span className="disagreement-item__meta">
                  Raised by {item.raisedBy === "gpt" ? "Dr. Chen" : "Dr. Rivera"} (turn {item.raisedInTurn})
                  {item.resolvedInTurn ? ` - resolved by turn ${item.resolvedInTurn}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {challenges.length > 0 && (
        <div className="checkpoint-section">
          <h3>Challenges &amp; consensus</h3>

          {preText && (
            <div className="debate-pretext">
              <MarkdownContent text={preText} />
            </div>
          )}

          <div className="challenge-list">
            {challenges.map((challenge) => {
              const { analysis, fix } = splitConsensusFix(challenge.body);
              return (
                <div key={challenge.number} className="challenge-card">
                  <div className="challenge-card__header">
                    <span className="challenge-card__number">C{challenge.number}</span>
                    <h4 className="challenge-card__title">{challenge.title}</h4>
                  </div>

                  <div className="challenge-card__analysis">
                    <MarkdownContent text={analysis} />
                  </div>

                  {fix && (
                    <div className="challenge-card__fix">
                      <span className="challenge-card__fix-label">Consensus fix</span>
                      <MarkdownContent text={fix} />
                    </div>
                  )}

                  {canSubmitFeedback && (
                    <div className="challenge-card__feedback">
                      <textarea
                        className="challenge-card__feedback-input"
                        placeholder={`Feedback on challenge ${challenge.number} (optional)...`}
                        value={challengeFeedback[challenge.number] || ""}
                        onChange={(event) => handleFeedbackChange(challenge.number, event.target.value)}
                        rows={2}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {convergedApproach && challenges.length === 0 && (
        <div className="checkpoint-section">
          <h3>Converged approach</h3>
          <div className="debate-converged-inline">
            <MarkdownContent text={convergedApproach} />
          </div>
        </div>
      )}

      {summary && summary !== convergedApproach && (
        <div className="debate-summary">
          <MarkdownContent text={summary} />
        </div>
      )}

      {renderFeedbackSubmit()}
    </article>
  );
}
