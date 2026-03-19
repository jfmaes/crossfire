import { expect, test } from "@playwright/test";

test("creates a session and renders the returned checkpoint", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Problem statement").fill("Help me design a dual-model planning app");
  await page.getByRole("button", { name: "Start session" }).click();

  await expect(page.getByText("Review the first checkpoint")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Checkpoint" })).toBeVisible();
});
