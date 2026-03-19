import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { modelTurnSchema } from "@council/core";

const providerTurnSchema = modelTurnSchema.omit({
  actor: true,
  degraded: true
});

const outputPath = path.resolve(process.cwd(), "schemas", "model-turn.schema.json");

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(z.toJSONSchema(providerTurnSchema), null, 2) + "\n",
  "utf8"
);
