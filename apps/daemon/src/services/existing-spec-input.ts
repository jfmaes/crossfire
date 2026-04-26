import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExistingSpecSourceMetadata } from "@council/storage";

export interface ExistingSpecRequestInput {
  prompt?: string;
  existingSpec?: {
    spec?: string;
    specPath?: string;
    specFileName?: string;
    implementationPlan?: string;
    implementationPlanPath?: string;
    implementationPlanFileName?: string;
  };
}

interface ResolvedDocument {
  text: string;
  source: ExistingSpecSourceMetadata;
}

const MAX_DOCUMENT_CHARS = 250_000;
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

export async function resolveExistingSpecInput(input: ExistingSpecRequestInput) {
  const existingSpec = input.existingSpec ?? {};
  const spec = await resolveDocument({
    label: "spec",
    text: existingSpec.spec,
    filePath: existingSpec.specPath,
    fileName: existingSpec.specFileName,
    required: true
  });
  const implementationPlan = await resolveDocument({
    label: "implementationPlan",
    text: existingSpec.implementationPlan,
    filePath: existingSpec.implementationPlanPath,
    fileName: existingSpec.implementationPlanFileName,
    required: false
  });
  if (!spec) {
    throw new Error("existingSpec.spec or existingSpec.specPath is required");
  }

  const prompt = [
    input.prompt?.trim()
      ? `HUMAN REVIEW CONTEXT:\n${input.prompt.trim()}`
      : "HUMAN REVIEW CONTEXT:\nNo additional context supplied.",
    "",
    "EXISTING SPECIFICATION:",
    spec.text,
    "",
    implementationPlan
      ? ["EXISTING IMPLEMENTATION PLAN:", implementationPlan.text].join("\n")
      : "EXISTING IMPLEMENTATION PLAN:\nNo implementation plan was supplied."
  ].join("\n");

  return {
    prompt,
    spec: spec.text,
    implementationPlan: implementationPlan?.text ?? null,
    sources: [spec.source, ...(implementationPlan ? [implementationPlan.source] : [])]
  };
}

async function resolveDocument(input: {
  label: "spec" | "implementationPlan";
  text?: string;
  filePath?: string;
  fileName?: string;
  required: boolean;
}): Promise<ResolvedDocument | null> {
  const text = input.text?.trim();
  const filePath = input.filePath?.trim();

  if (text && filePath) {
    throw new Error(
      `Provide either ${input.label} text or ${
        input.label === "spec" ? "specPath" : "implementationPlanPath"
      }, not both`
    );
  }

  if (!text && !filePath) {
    if (input.required) {
      throw new Error("existingSpec.spec or existingSpec.specPath is required");
    }

    return null;
  }

  if (text) {
    ensureDocumentSize(input.label, text);
    return {
      text,
      source: {
        label: input.label,
        sourceType: "text",
        path: null,
        fileName: input.fileName?.trim() || null,
        chars: text.length
      }
    };
  }

  const resolvedPath = path.resolve(filePath!);
  const stats = await stat(resolvedPath).catch((error: unknown) => {
    throw new Error(
      `Unable to read ${input.label} path: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  if (!stats.isFile()) {
    throw new Error(`${input.label} path must be a file`);
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported ${input.label} file extension: ${extension || "(none)"}`);
  }

  const content = await readFile(resolvedPath, "utf8");
  ensureDocumentSize(input.label, content);

  return {
    text: content,
    source: {
      label: input.label,
      sourceType: "path",
      path: resolvedPath,
      fileName: path.basename(resolvedPath),
      chars: content.length
    }
  };
}

function ensureDocumentSize(label: "spec" | "implementationPlan", text: string): void {
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new Error(`${label} exceeds ${MAX_DOCUMENT_CHARS} character limit`);
  }
}
