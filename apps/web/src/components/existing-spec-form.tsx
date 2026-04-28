import { useState } from "react";
import type { ExistingSpecInput } from "../lib/api";

type SourceMode = "paste" | "path" | "upload";

interface ExistingSpecFormProps {
  onCreate(input: {
    title: string;
    prompt: string;
    existingSpec: ExistingSpecInput;
  }): Promise<void>;
}

const GENERIC_HEADINGS = new Set([
  "spec",
  "specification",
  "existing spec",
  "existing specification",
  "implementation plan",
  "plan",
  "existing plan"
]);

function getPathBaseName(value: string): string | null {
  const parts = value.trim().split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function getMeaningfulHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+?)\s*#*\s*$/m);
  const heading = match?.[1]?.trim();
  if (!heading) {
    return null;
  }

  return GENERIC_HEADINGS.has(heading.toLowerCase()) ? null : heading;
}

async function readFileText(file: File): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
      reader.readAsText(file);
    });
  }

  if (typeof file.text === "function") {
    return file.text();
  }

  return new Response(file).text();
}

export function ExistingSpecForm(input: ExistingSpecFormProps) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [specMode, setSpecMode] = useState<SourceMode>("paste");
  const [specText, setSpecText] = useState("");
  const [specPath, setSpecPath] = useState("");
  const [specFile, setSpecFile] = useState<File | null>(null);

  const [planMode, setPlanMode] = useState<SourceMode>("paste");
  const [planText, setPlanText] = useState("");
  const [planPath, setPlanPath] = useState("");
  const [planFile, setPlanFile] = useState<File | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const existingSpec: ExistingSpecInput = {};
    let derivedTitle: string | null = null;

    if (specMode === "paste") {
      const value = specText.trim();
      if (value) {
        existingSpec.spec = value;
        derivedTitle = getMeaningfulHeading(value);
      }
    } else if (specMode === "path") {
      const value = specPath.trim();
      if (value) {
        existingSpec.specPath = value;
        derivedTitle = getPathBaseName(value);
      }
    } else if (specFile) {
      existingSpec.spec = await readFileText(specFile);
      existingSpec.specFileName = specFile.name;
      derivedTitle = specFile.name;
    }

    if (!existingSpec.spec && !existingSpec.specPath) {
      setError("Provide specification text, a daemon path, or an uploaded file.");
      return;
    }

    if (planMode === "paste") {
      const value = planText.trim();
      if (value) {
        existingSpec.implementationPlan = value;
      }
    } else if (planMode === "path") {
      const value = planPath.trim();
      if (value) {
        existingSpec.implementationPlanPath = value;
      }
    } else if (planFile) {
      existingSpec.implementationPlan = await readFileText(planFile);
      existingSpec.implementationPlanFileName = planFile.name;
    }

    setSubmitting(true);
    try {
      await input.onCreate({
        title: derivedTitle ?? "Existing spec review",
        prompt: prompt.trim(),
        existingSpec
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card session-form" onSubmit={handleSubmit}>
      <div className="existing-spec-form__section">
        <label className="session-form__label" htmlFor="existing-spec-focus">
          Review focus
        </label>
        <textarea
          id="existing-spec-focus"
          name="reviewFocus"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Optional context for the review, rollout risk, or areas to challenge."
        />
      </div>

      <div className="existing-spec-form__section">
        <label className="session-form__label">Specification source</label>
        <div className="source-toggle" role="group" aria-label="Specification source mode">
          <button
            type="button"
            aria-pressed={specMode === "paste"}
            onClick={() => setSpecMode("paste")}
          >
            Spec paste
          </button>
          <button
            type="button"
            aria-pressed={specMode === "path"}
            onClick={() => setSpecMode("path")}
          >
            Spec path
          </button>
          <button
            type="button"
            aria-pressed={specMode === "upload"}
            onClick={() => setSpecMode("upload")}
          >
            Spec upload
          </button>
        </div>
        {specMode === "paste" && (
          <>
            <label className="session-form__label" htmlFor="existing-spec-text">
              Specification text
            </label>
            <textarea
              id="existing-spec-text"
              name="specificationText"
              rows={8}
              value={specText}
              onChange={(event) => setSpecText(event.target.value)}
              placeholder="# Existing Spec"
            />
          </>
        )}
        {specMode === "path" && (
          <>
            <label className="session-form__label" htmlFor="existing-spec-path">
              Specification path
            </label>
            <input
              id="existing-spec-path"
              className="session-form__input"
              name="specificationPath"
              type="text"
              value={specPath}
              onChange={(event) => setSpecPath(event.target.value)}
              placeholder="/repo/specs/existing-spec.md"
            />
          </>
        )}
        {specMode === "upload" && (
          <>
            <label className="session-form__label" htmlFor="existing-spec-file">
              Specification file
            </label>
            <input
              id="existing-spec-file"
              className="session-form__input"
              name="specificationFile"
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onChange={(event) => setSpecFile(event.target.files?.[0] ?? null)}
            />
          </>
        )}
      </div>

      <div className="existing-spec-form__section">
        <label className="session-form__label">Implementation plan source</label>
        <div className="source-toggle" role="group" aria-label="Implementation plan source mode">
          <button
            type="button"
            aria-pressed={planMode === "paste"}
            onClick={() => setPlanMode("paste")}
          >
            Plan paste
          </button>
          <button
            type="button"
            aria-pressed={planMode === "path"}
            onClick={() => setPlanMode("path")}
          >
            Plan path
          </button>
          <button
            type="button"
            aria-pressed={planMode === "upload"}
            onClick={() => setPlanMode("upload")}
          >
            Plan upload
          </button>
        </div>
        {planMode === "paste" && (
          <>
            <label className="session-form__label" htmlFor="existing-plan-text">
              Implementation plan text
            </label>
            <textarea
              id="existing-plan-text"
              name="implementationPlanText"
              rows={6}
              value={planText}
              onChange={(event) => setPlanText(event.target.value)}
              placeholder="# Existing Plan"
            />
          </>
        )}
        {planMode === "path" && (
          <>
            <label className="session-form__label" htmlFor="existing-plan-path">
              Implementation plan path
            </label>
            <input
              id="existing-plan-path"
              className="session-form__input"
              name="implementationPlanPath"
              type="text"
              value={planPath}
              onChange={(event) => setPlanPath(event.target.value)}
              placeholder="/repo/plans/implementation-plan.md"
            />
          </>
        )}
        {planMode === "upload" && (
          <>
            <label className="session-form__label" htmlFor="existing-plan-file">
              Implementation plan file
            </label>
            <input
              id="existing-plan-file"
              className="session-form__input"
              name="implementationPlanFile"
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onChange={(event) => setPlanFile(event.target.files?.[0] ?? null)}
            />
          </>
        )}
      </div>

      {error && <div className="existing-spec-form__error" role="alert">{error}</div>}

      <div className="session-form__actions">
        <button disabled={submitting} type="submit">
          {submitting ? "Reading documents..." : "Start review"}
        </button>
      </div>
    </form>
  );
}
