import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { modelTurnSchema } from "@council/core";

const providerTurnSchema = modelTurnSchema.omit({
  actor: true,
  degraded: true
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAllDeclaredObjectProperties(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) {
      requireAllDeclaredObjectProperties(item);
    }
    return;
  }

  if (!isRecord(schema)) {
    return;
  }

  if (isRecord(schema.properties)) {
    schema.required = Object.keys(schema.properties);
  }

  for (const value of Object.values(schema)) {
    requireAllDeclaredObjectProperties(value);
  }
}

const outputPath = path.resolve(process.cwd(), "schemas", "model-turn.schema.json");
const jsonSchema = z.toJSONSchema(providerTurnSchema);
requireAllDeclaredObjectProperties(jsonSchema);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(jsonSchema, null, 2) + "\n",
  "utf8"
);
