import { MarkdownContent } from "./markdown-content";

interface AnalysisResult {
  gptAnalysis: string;
  claudeAnalysis: string;
  proposedQuestions: Array<{
    text: string;
    priority: number;
    rationale: string;
    proposedBy: string;
  }>;
}

export function AnalysisCard({ result }: { result: AnalysisResult }) {
  return (
    <article className="card card--analysis">
      <div className="card__header">
        <h2>Dual Analysis</h2>
        <span className="card__badge">Phase 1</span>
      </div>

      <div className="analysis-columns">
        <div className="analysis-column analysis-column--gpt">
          <h3>GPT (Dr. Chen)</h3>
          <MarkdownContent text={result.gptAnalysis} className="analysis-text" />
        </div>
        <div className="analysis-column analysis-column--claude">
          <h3>Claude (Dr. Rivera)</h3>
          <MarkdownContent text={result.claudeAnalysis} className="analysis-text" />
        </div>
      </div>

      {result.proposedQuestions.length > 0 && (
        <div className="checkpoint-section">
          <h3>Proposed Interview Questions</h3>
          <ol className="question-list">
            {result.proposedQuestions.map((q, i) => (
              <li key={i} className="question-item">
                <span className="question-priority">P{q.priority}</span>
                <div>
                  <p className="question-text">{q.text}</p>
                  <p className="question-rationale">{q.rationale}</p>
                  <span className="question-source">Proposed by: {q.proposedBy}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}
