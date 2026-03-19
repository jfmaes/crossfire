/**
 * Lightweight markdown-to-HTML converter for model output.
 * Handles the most common patterns LLMs produce without a full parser dependency.
 * Content comes from our own LLM providers, not user input.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  // Normalize line endings
  let html = text.replace(/\r\n/g, "\n");

  // Escape HTML entities
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Headings (### ... )
  html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // Bold + italic (***...***)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic (*...*)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

  // Horizontal rules (--- or ***)
  html = html.replace(/^[-*]{3,}$/gm, '<hr class="md-hr">');

  // Unordered lists (- item or * item)
  html = html.replace(
    /(?:^|\n)((?:[ ]*[-*] .+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split(/\n/)
        .map((line) => `<li>${line.replace(/^[ ]*[-*] /, "")}</li>`)
        .join("");
      return `\n<ul class="md-list">${items}</ul>\n`;
    }
  );

  // Ordered lists (1. item)
  html = html.replace(
    /(?:^|\n)((?:[ ]*\d+\. .+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split(/\n/)
        .map((line) => `<li>${line.replace(/^[ ]*\d+\. /, "")}</li>`)
        .join("");
      return `\n<ol class="md-list">${items}</ol>\n`;
    }
  );

  // Paragraphs: double newlines become paragraph breaks
  html = html
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // Don't wrap blocks that are already HTML elements
      if (/^<(h[1-4]|ul|ol|pre|hr|div|blockquote)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}
