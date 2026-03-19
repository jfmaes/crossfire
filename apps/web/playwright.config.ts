import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: {
    ...devices["Pixel 7"],
    baseURL: "http://127.0.0.1:4173"
  }
});
