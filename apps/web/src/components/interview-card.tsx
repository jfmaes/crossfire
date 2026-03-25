import { MarkdownContent } from "./markdown-content";
import type { InterviewState } from "../lib/api";

interface InterviewCardProps {
  state: InterviewState;
  evaluation?: string | null;
}

export function InterviewCard({ state, evaluation }: InterviewCardProps) {
  const { questions, currentQuestion, totalQuestions, answeredCount } = state;
  const answered = questions.filter((q) => q.answer !== null);
  const progressPct = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;

  return (
    <article className="card card--interview">
      <div className="card__header">
        <h2>Interview</h2>
        <span className="card__badge">
          {answeredCount} of {totalQuestions}
        </span>
      </div>

      <div className="interview-progress">
        <div className="interview-progress__bar">
          <div
            className="interview-progress__fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="interview-progress__segments">
          {Array.from({ length: totalQuestions }, (_, i) => (
            <span
              key={i}
              className={`interview-progress__dot ${i < answeredCount ? "interview-progress__dot--done" : i === answeredCount ? "interview-progress__dot--current" : ""}`}
            />
          ))}
        </div>
      </div>

      {currentQuestion && (
        <div className="interview-current">
          <h3>Question {answeredCount + 1} of {totalQuestions}</h3>
          <p className="interview-question-text">{currentQuestion.text}</p>
          <p className="interview-question-rationale">{currentQuestion.rationale}</p>
        </div>
      )}

      {!currentQuestion && (
        <div className="interview-complete">
          <p>All questions have been answered.</p>
        </div>
      )}

      {evaluation && (
        <details className="interview-evaluation" open>
          <summary>Model evaluation of last answer</summary>
          <MarkdownContent text={evaluation} className="interview-evaluation-text" />
        </details>
      )}

      {answered.length > 0 && (
        <details className="interview-history">
          <summary>Answered questions ({answered.length})</summary>
          <dl className="interview-answers">
            {answered.map((q) => (
              <div key={q.id} className="interview-answer-item">
                <dt>{q.text}</dt>
                <dd>{q.answer}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}
