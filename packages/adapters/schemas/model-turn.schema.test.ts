import { describe, expect, it } from "vitest";
import modelTurnSchema from "./model-turn.schema.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectMissingRequiredProperties(schema: unknown, path = "$"): string[] {
  if (!isRecord(schema)) {
    return [];
  }

  const missing: string[] = [];
  const properties = schema.properties;

  if (isRecord(properties)) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : []
    );

    for (const propertyName of Object.keys(properties)) {
      if (!required.has(propertyName)) {
        missing.push(`${path}.properties.${propertyName}`);
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        missing.push(...collectMissingRequiredProperties(item, `${path}.${key}.${index}`));
      }
      continue;
    }

    if (isRecord(value)) {
      missing.push(...collectMissingRequiredProperties(value, `${path}.${key}`));
    }
  }

  return missing;
}

describe("model turn JSON schema", () => {
  it("requires every declared object property for strict provider schema validation", () => {
    expect(collectMissingRequiredProperties(modelTurnSchema)).toEqual([]);
  });
});
