import { MarkdownContent } from "./markdown-content";

interface SpecResult {
  spec: string;
  implementationPlan?: string;
  summary: string;
}

export function SpecCard({
  result,
  isFinalized,
  sessionId
}: {
  result: SpecResult;
  isFinalized: boolean;
  sessionId?: string;
}) {
  return (
    <article className="card card--spec">
      <div className="card__header">
        <h2>Specification & Implementation Plan</h2>
        <span className={`card__badge ${isFinalized ? "card__badge--success" : ""}`}>
          {isFinalized ? "Finalized" : "Needs review"}
        </span>
      </div>

      <p className="spec-summary">{result.summary}</p>

      {isFinalized && sessionId && (
        <div className="spec-downloads">
          <a
            className="spec-download-btn"
            href={`/artifacts/${sessionId}/spec`}
            download={`${sessionId}-spec.md`}
          >
            Download Spec (.md)
          </a>
          {result.implementationPlan && (
            <a
              className="spec-download-btn"
              href={`/artifacts/${sessionId}/plan`}
              download={`${sessionId}-plan.md`}
            >
              Download Implementation Plan (.md)
            </a>
          )}
        </div>
      )}

      <details className="spec-section" open>
        <summary className="spec-section__title">Specification</summary>
        <div className="spec-content">
          <MarkdownContent text={result.spec} className="spec-document" />
        </div>
      </details>

      {result.implementationPlan && (
        <details className="spec-section" open>
          <summary className="spec-section__title">Implementation Plan</summary>
          <div className="spec-content">
            <MarkdownContent text={result.implementationPlan} className="spec-document" />
          </div>
        </details>
      )}
    </article>
  );
}
