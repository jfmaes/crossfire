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
    </article>
  );
}
