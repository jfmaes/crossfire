/**
 * Lightweight markdown-to-HTML converter for model output.
 * Handles the most common patterns LLMs produce without a full parser dependency.
 * Content comes from our own LLM providers, not user input.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Detect whether text contains markdown formatting features (headings, bold,
 * lists, code blocks, etc.).  When these are present the text is almost
 * certainly prose written by an LLM, not structured YAML/JSON data, even if
 * it happens to contain "key: value" lines.
 */
function hasMarkdownFeatures(text: string): boolean {
  return /(?:^|\n)\s*#{1,4}\s/.test(text)       // headings
    || /\*\*[^*]+\*\*/.test(text)                // bold
    || /(?:^|\n)[-*]\s+\S/.test(text)            // top-level unordered list (not indented YAML)
    || /(?:^|\n)\d+\.\s+\S/.test(text)           // top-level ordered list
    || /```/.test(text);                          // fenced code block
}

function extractFencedBlock(text: string): { lang: string; body: string } | null {
  const match = text.trim().match(/^```(\w+)?\n([\s\S]*?)```$/);
  if (!match) return null;
  return {
    lang: (match[1] || "").toLowerCase(),
    body: match[2].trim()
  };
}

function tryParseStructuredJson(text: string): unknown | null {
  const candidates = [text.trim()];
  const fenced = extractFencedBlock(text);
  if (fenced && (fenced.lang === "json" || !fenced.lang)) {
    candidates.unshift(fenced.body);
  }

  for (const candidate of candidates) {
    if (!candidate || !/^[\[{]/.test(candidate.trim())) continue;

    const attempts = [
      candidate,
      candidate.replace(/,\s*([}\]])/g, "$1")
    ];

    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && (Array.isArray(parsed) || typeof parsed === "object")) {
          return parsed;
        }
      } catch {
        // Keep trying fallbacks
      }
    }
  }

  return null;
}

function looksLikeYaml(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Explicitly fenced YAML is always YAML
  const fenced = extractFencedBlock(text);
  if (fenced && (fenced.lang === "yaml" || fenced.lang === "yml")) {
    return true;
  }

  // If the text contains markdown features, it's prose not structured data
  if (hasMarkdownFeatures(trimmed)) return false;

  const lines = trimmed.split("\n").filter((line) => line.trim());
  if (lines.length < 3) return false;

  const structuredLines = lines.filter((line) =>
    /^\s*[^#\s][^:]*:\s*(.*)?$/.test(line) ||  // key: value
    /^\s+-\s/.test(line)                         // indented list item (YAML array)
  ).length;
  // Require at least 60% of lines to be structured (key-value or YAML list items)
  return structuredLines / lines.length >= 0.6;
}

function renderStructuredScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return '<span class="md-structured__scalar md-structured__scalar--null">null</span>';
  }
  if (typeof value === "boolean") {
    return `<span class="md-structured__scalar md-structured__scalar--boolean">${String(value)}</span>`;
  }
  if (typeof value === "number") {
    return `<span class="md-structured__scalar md-structured__scalar--number">${String(value)}</span>`;
  }
  return `<span class="md-structured__scalar md-structured__scalar--string">${escapeHtml(value)}</span>`;
}

function renderStructuredValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return renderStructuredScalar(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '<span class="md-structured__scalar md-structured__scalar--empty">[]</span>';
    }

    const items = value
      .map((item) => `<li class="md-structured__array-item">${renderStructuredValue(item)}</li>`)
      .join("");

    return `<ul class="md-structured__array">${items}</ul>`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return '<span class="md-structured__scalar md-structured__scalar--empty">{}</span>';
    }

    return [
      '<div class="md-structured__object">',
      ...entries.map(([key, entryValue]) => `
        <div class="md-structured__row">
          <div class="md-structured__key">${escapeHtml(key)}</div>
          <div class="md-structured__value">${renderStructuredValue(entryValue)}</div>
        </div>
      `),
      "</div>"
    ].join("");
  }

  return renderStructuredScalar(String(value));
}

function renderStructuredJson(text: string): string | null {
  const parsed = tryParseStructuredJson(text);
  if (!parsed) return null;

  return `
    <div class="md-structured md-structured--json">
      <div class="md-structured__label">Structured JSON</div>
      ${renderStructuredValue(parsed)}
    </div>
  `;
}

function renderYamlLike(text: string): string | null {
  if (!looksLikeYaml(text)) return null;

  const fenced = extractFencedBlock(text);
  const source = fenced?.body ?? text.trim();
  const lines = source.split("\n").filter((line) => line.trim());

  const rows = lines.map((line) => {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const depth = Math.floor(indent / 2);
    const trimmed = line.trim();

    const listMatch = trimmed.match(/^-\s+(.*)$/);
    if (listMatch) {
      return `
        <div class="md-structured__yaml-line md-structured__yaml-line--list" style="--yaml-depth:${depth}">
          <span class="md-structured__yaml-bullet">•</span>
          <span class="md-structured__yaml-value">${escapeHtml(listMatch[1])}</span>
        </div>
      `;
    }

    const keyValueMatch = trimmed.match(/^([^:#][^:]*):\s*(.*)?$/);
    if (keyValueMatch) {
      const [, key, value = ""] = keyValueMatch;
      return `
        <div class="md-structured__yaml-line" style="--yaml-depth:${depth}">
          <span class="md-structured__yaml-key">${escapeHtml(key.trim())}</span>
          <span class="md-structured__yaml-sep">:</span>
          <span class="md-structured__yaml-value">${value ? escapeHtml(value) : '<span class="md-structured__scalar md-structured__scalar--empty">∅</span>'}</span>
        </div>
      `;
    }

    return `
      <div class="md-structured__yaml-line md-structured__yaml-line--raw" style="--yaml-depth:${depth}">
        <span class="md-structured__yaml-value">${escapeHtml(trimmed)}</span>
      </div>
    `;
  }).join("");

  return `
    <div class="md-structured md-structured--yaml">
      <div class="md-structured__label">Structured YAML</div>
      <div class="md-structured__yaml">${rows}</div>
    </div>
  `;
}

export function renderMarkdown(text: string): string {
  if (!text) return "";

  // Only attempt structured rendering for text that doesn't look like prose
  if (!hasMarkdownFeatures(text)) {
    const structuredJson = renderStructuredJson(text);
    if (structuredJson) return structuredJson;

    const yamlLike = renderYamlLike(text);
    if (yamlLike) return yamlLike;
  }

  // Normalize line endings
  let html = text.replace(/\r\n/g, "\n");

  // Escape HTML entities
  html = escapeHtml(html);

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
