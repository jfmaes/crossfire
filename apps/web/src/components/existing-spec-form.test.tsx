// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExistingSpecForm } from "./existing-spec-form";

describe("ExistingSpecForm", () => {
  afterEach(() => {
    cleanup();
  });

  it("submits pasted spec and plan text", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Review focus"), {
      target: { value: "Focus on rollout risk." }
    });
    fireEvent.change(screen.getByLabelText("Specification text"), {
      target: { value: "# Existing Spec" }
    });
    fireEvent.change(screen.getByLabelText("Implementation plan text"), {
      target: { value: "# Existing Plan" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Existing spec review",
        prompt: "Focus on rollout risk.",
        existingSpec: {
          spec: "# Existing Spec",
          implementationPlan: "# Existing Plan"
        }
      });
    });
  });

  it("submits daemon path references without reading browser files", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Spec path" }));
    fireEvent.change(screen.getByLabelText("Specification path"), {
      target: { value: "/repo/specs/auth.md" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "auth.md",
        prompt: "",
        existingSpec: { specPath: "/repo/specs/auth.md" }
      });
    });
  });

  it("reads uploaded markdown files as request text", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ExistingSpecForm onCreate={onCreate} />);

    fireEvent.click(screen.getByRole("button", { name: "Spec upload" }));
    const file = new File(["# Uploaded Spec"], "uploaded-spec.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("Specification file"), {
      target: { files: [file] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "uploaded-spec.md",
        prompt: "",
        existingSpec: {
          spec: "# Uploaded Spec",
          specFileName: "uploaded-spec.md"
        }
      });
    });
  });
});
