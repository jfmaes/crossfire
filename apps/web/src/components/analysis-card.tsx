import type { DebateTrace } from "../lib/api";
import { MarkdownContent } from "./markdown-content";

interface AnalysisResult {
  gptAnalysis: string;
  claudeAnalysis: string;
  proposedQuestions: Array<{
    text: string;
    priority: number;
    rationale: string;
    context?: string | null;
    recommendation?: string | null;
    recommendationReasoning?: string | null;
    proposedBy: string;
  }>;
  debateSummary?: string;
  questionSynthesisTrace?: DebateTrace;
  questionDebateTrace?: DebateTrace;
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

function formatQuestionSource(proposedBy: string): string {
  switch (proposedBy) {
    case "gpt":
      return "Raised by GPT";
    case "claude":
      return "Raised by Claude";
    case "synthesized":
      return "Selected after question debate";
    default:
      return proposedBy ? `Source: ${proposedBy}` : "Selected for interview";
  }
}

export function AnalysisCard({ result }: { result: AnalysisResult }) {
  const questionTrace = result.questionDebateTrace ?? result.questionSynthesisTrace;
  const clarificationQuestions = questionTrace?.questionsForHuman ?? [];
  const finalDisagreements = questionTrace?.finalDisagreements ?? [];
  const turnsUsed = questionTrace?.turnsUsed ?? questionTrace?.totalTurns;
  const showClarification = questionTrace?.stopReason === "questions_for_human" || clarificationQuestions.length > 0;
  const showTurnCapState = questionTrace?.stopReason === "max_turns" && finalDisagreements.length > 0;

  return (
    <article className="card card--analysis">
      <div className="card__header">
        <h2>Dual Analysis</h2>
        <span className="card__badge">Phase 1</span>
      </div>

      <div className="analysis-panes">
        <details className="analysis-pane analysis-pane--gpt" open>
          <summary className="analysis-pane__summary">GPT (Dr. Chen)</summary>
          <div className="analysis-pane__body">
            <MarkdownContent text={result.gptAnalysis} className="analysis-text" />
          </div>
        </details>

        <details className="analysis-pane analysis-pane--claude" open>
          <summary className="analysis-pane__summary">Claude (Dr. Rivera)</summary>
          <div className="analysis-pane__body">
            <MarkdownContent text={result.claudeAnalysis} className="analysis-text" />
          </div>
        </details>
      </div>

      {(questionTrace || result.proposedQuestions.length > 0) && (
        <div className="checkpoint-section">
          <h3>Interview question set</h3>

          <div className="trace-pill-row">
            <span className="trace-pill">Questions ready: {result.proposedQuestions.length}</span>
            {formatStopReason(questionTrace?.stopReason) && (
              <span className="trace-pill">Outcome: {formatStopReason(questionTrace?.stopReason)}</span>
            )}
            {typeof turnsUsed === "number" && typeof questionTrace?.maxTurns === "number" && (
              <span className="trace-pill">Turns: {turnsUsed}/{questionTrace.maxTurns}</span>
            )}
            {typeof questionTrace?.finalDisagreementCount === "number" && questionTrace.finalDisagreementCount > 0 && (
              <span className="trace-pill">Open disagreements: {questionTrace.finalDisagreementCount}</span>
            )}
          </div>

          {showClarification && (
            <section className="debate-unresolved">
              <div className="debate-unresolved__header">
                <div>
                  <span className="debate-unresolved__badge">Clarification needed</span>
                  <h3 className="debate-unresolved__title">Question debate paused for your input</h3>
                </div>
                <span className="debate-unresolved__count">
                  {clarificationQuestions.length} open
                </span>
              </div>

              <p className="debate-unresolved__summary">
                The models stopped because they still need clarification before they can lock the interview plan.
              </p>

              <ol className="debate-unresolved__list">
                {clarificationQuestions.map((question, index) => (
                  <li key={question} className="debate-unresolved__item">
                    <span className="debate-unresolved__item-number">{index + 1}</span>
                    <span className="debate-unresolved__item-text">{question}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {showTurnCapState && (
            <section className="debate-unresolved">
              <div className="debate-unresolved__header">
                <div>
                  <span className="debate-unresolved__badge">Needs human judgment</span>
                  <h3 className="debate-unresolved__title">Question debate ended at the turn cap</h3>
                </div>
                <span className="debate-unresolved__count">
                  {finalDisagreements.length} open
                </span>
              </div>

              <p className="debate-unresolved__summary">
                The models did not fully agree on the interview plan before the safety cap. Review the remaining disagreements before proceeding.
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

          {result.proposedQuestions.length > 0 && (
            <ul className="question-list">
              {result.proposedQuestions.map((question) => (
                <li key={`${question.text}-${question.priority}`} className="question-item">
                  <span className="question-priority">{question.priority}</span>
                  <div>
                    <p className="question-text">{question.text}</p>
                    <p className="question-rationale">{question.rationale}</p>
                    {question.context && (
                      <p className="question-context">{question.context}</p>
                    )}
                    {question.recommendation && (
                      <p className="question-recommendation">
                        <strong>Crossfire recommendation:</strong> {question.recommendation}
                      </p>
                    )}
                    {question.recommendationReasoning && (
                      <p className="question-recommendation-reasoning">{question.recommendationReasoning}</p>
                    )}
                    <p className="question-source">{formatQuestionSource(question.proposedBy)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
