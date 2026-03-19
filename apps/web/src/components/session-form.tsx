import { useState } from "react";

interface SessionFormProps {
  onCreate(prompt: string, groundingRoot?: string): Promise<void>;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  loadingLabel?: string;
  showGrounding?: boolean;
}

export function SessionForm(input: SessionFormProps) {
  const [prompt, setPrompt] = useState("");
  const [groundingRoot, setGroundingRoot] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const label = input.label ?? "Problem statement";
  const placeholder = input.placeholder ??
    "Describe the idea, problem, or product you want Claude and GPT to reason through.";
  const submitLabel = input.submitLabel ?? "Start session";
  const showGrounding = input.showGrounding ?? false;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!prompt.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      await input.onCreate(prompt.trim(), groundingRoot.trim() || undefined);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card session-form" onSubmit={handleSubmit}>
      <label className="session-form__label" htmlFor="problem-statement">
        {label}
      </label>
      <textarea
        id="problem-statement"
        name="problemStatement"
        rows={5}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={placeholder}
      />
      {showGrounding && (
        <>
          <label className="session-form__label" htmlFor="grounding-root">
            Grounding directory <span className="session-form__optional">(optional)</span>
          </label>
          <input
            id="grounding-root"
            name="groundingRoot"
            type="text"
            className="session-form__input"
            value={groundingRoot}
            onChange={(event) => setGroundingRoot(event.target.value)}
            placeholder="/path/to/your/project — injects file contents as context for the models"
          />
        </>
      )}
      <button disabled={submitting} type="submit">
        {submitting ? (
          <span className="btn-loading">
            <span className="spinner" />
            {input.loadingLabel ?? "Reasoning..."}
          </span>
        ) : (
          submitLabel
        )}
      </button>
    </form>
  );
}
