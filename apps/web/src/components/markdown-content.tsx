import { renderMarkdown } from "../lib/render-markdown";

export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={`md-content ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
    />
  );
}
