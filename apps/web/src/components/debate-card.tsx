import { useState } from "react";
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
  canSubmitFeedback?: boolean;
  onSubmitFeedback?: (feedback: string) => void;
  feedbackLoading?: boolean;
}

/**
 * Parse the converged approach text into individual challenges.
 * Models typically format them as "**Challenge N: title**\nbody..."
 * or "### Challenge N: title\nbody..."
 */
function parseChallenges(text: string): Challenge[] {
  // Match lines that start a challenge section
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
  const seen = new Map<string, { raisedBy: string; raisedInTurn: number; lastSeenTurn: number }>();

  turns.forEach((turn, i) => {
    const turnNum = i + 1;
    if (turn.disagreements) {
      for (const d of turn.disagreements) {
        const key = d.toLowerCase().trim();
        if (!seen.has(key)) {
          seen.set(key, { raisedBy: turn.actor, raisedInTurn: turnNum, lastSeenTurn: turnNum });
        } else {
          seen.get(key)!.lastSeenTurn = turnNum;
        }
      }
    }
  });

  const totalTurns = turns.length;
  return [...seen.entries()].map(([, info]) => ({
    text: [...seen.entries()].find(([, v]) => v === info)![0],
    raisedBy: info.raisedBy,
    raisedInTurn: info.raisedInTurn,
    resolvedInTurn: info.lastSeenTurn < totalTurns ? info.lastSeenTurn + 1 : null
  }));
}

export function DebateCard({
  title,
  badge,
  summary,
  turns,
  convergedApproach,
  canSubmitFeedback,
  onSubmitFeedback,
  feedbackLoading
}: DebateCardProps) {
  const challenges = convergedApproach ? parseChallenges(convergedApproach) : [];
  const [challengeFeedback, setChallengeFeedback] = useState<Record<number, string>>({});
  const [generalFeedback, setGeneralFeedback] = useState("");
  const timeline = turns ? collectDisagreementTimeline(turns) : [];

  function handleFeedbackChange(challengeNum: number, value: string) {
    setChallengeFeedback((prev) => ({ ...prev, [challengeNum]: value }));
  }

  function handleSubmit() {
    if (!onSubmitFeedback) return;

    const parts: string[] = [];

    // Collect per-challenge feedback
    for (const challenge of challenges) {
      const fb = challengeFeedback[challenge.number]?.trim();
      if (fb) {
        parts.push(`[Challenge ${challenge.number}: ${challenge.title}]\n${fb}`);
      }
    }

    // Add general feedback
    if (generalFeedback.trim()) {
      parts.push(`[General feedback]\n${generalFeedback.trim()}`);
    }

    // If no per-challenge feedback but general feedback, just send that
    const combined = parts.length > 0 ? parts.join("\n\n") : generalFeedback.trim() || "Approved — proceed to spec generation";
    onSubmitFeedback(combined);
  }

  // Pre-text before challenges (if convergedApproach has text before first challenge)
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

      {/* Debate turns with disagreement counts */}
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
                      {turn.disagreements.map((d, j) => (
                        <li key={j}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Disagreement timeline */}
      {timeline.length > 0 && (
        <div className="checkpoint-section">
          <h3>Disagreement resolution</h3>
          <div className="disagreement-timeline">
            {timeline.map((item, i) => (
              <div key={i} className={`disagreement-item ${item.resolvedInTurn ? "disagreement-item--resolved" : "disagreement-item--open"}`}>
                <span className="disagreement-item__status">
                  {item.resolvedInTurn ? "Resolved" : "Open"}
                </span>
                <span className="disagreement-item__text">{item.text}</span>
                <span className="disagreement-item__meta">
                  Raised by {item.raisedBy === "gpt" ? "Dr. Chen" : "Dr. Rivera"} (turn {item.raisedInTurn})
                  {item.resolvedInTurn ? ` — resolved by turn ${item.resolvedInTurn}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Challenges rendered individually */}
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
                        onChange={(e) => handleFeedbackChange(challenge.number, e.target.value)}
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

      {/* If no structured challenges found, show the full converged approach inline */}
      {convergedApproach && challenges.length === 0 && (
        <div className="checkpoint-section">
          <h3>Converged approach</h3>
          <div className="debate-converged-inline">
            <MarkdownContent text={convergedApproach} />
          </div>
        </div>
      )}

      {/* Summary (full, no truncation) */}
      {summary && summary !== convergedApproach && (
        <div className="debate-summary">
          <MarkdownContent text={summary} />
        </div>
      )}

      {/* Feedback submission */}
      {canSubmitFeedback && onSubmitFeedback && (
        <div className="challenge-feedback-submit">
          <textarea
            className="challenge-card__feedback-input challenge-card__feedback-input--general"
            placeholder="General feedback on the approach (optional)..."
            value={generalFeedback}
            onChange={(e) => setGeneralFeedback(e.target.value)}
            rows={3}
          />
          <button
            className="challenge-feedback-submit__btn"
            onClick={handleSubmit}
            disabled={feedbackLoading}
          >
            {feedbackLoading ? (
              <span className="btn-loading">
                <span className="spinner" />
                Generating spec from approach...
              </span>
            ) : (
              "Submit feedback & generate spec"
            )}
          </button>
        </div>
      )}
    </article>
  );
}
