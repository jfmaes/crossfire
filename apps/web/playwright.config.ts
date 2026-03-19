import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 1_800_000, // 30 minutes — real LLM calls are very slow
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark"
  }
});
