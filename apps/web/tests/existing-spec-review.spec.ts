import { expect, test } from "@playwright/test";

test("creates an existing spec review session from pasted text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Review Existing Spec" }).click();
  await page.getByLabel("Specification text").fill("# Existing Spec\nShip a dashboard.");
  await page.getByLabel("Implementation plan text").fill("# Existing Plan\n1. Build the UI.");
  await page.getByRole("button", { name: "Start review" }).click();

  await expect(page.getByText(/reviewing the supplied spec/i)).toBeVisible();
});
