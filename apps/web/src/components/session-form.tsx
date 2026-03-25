import { useRef, useState } from "react";

interface SessionFormProps {
  onCreate(prompt: string): Promise<void>;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  loadingLabel?: string;
}

export function SessionForm(input: SessionFormProps) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const label = input.label ?? "Problem statement";
  const placeholder = input.placeholder ??
    "Describe the idea, problem, or product you want Claude and GPT to reason through.";
  const submitLabel = input.submitLabel ?? "Start session";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!prompt.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      await input.onCreate(prompt.trim());
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form className="card session-form" onSubmit={handleSubmit} ref={formRef}>
      <label className="session-form__label" htmlFor="problem-statement">
        {label}
      </label>
      <textarea
        id="problem-statement"
        name="problemStatement"
        rows={5}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      <div className="session-form__actions">
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
        <span className="session-form__hint">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to submit
        </span>
      </div>
    </form>
  );
}
