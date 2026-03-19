import { expect, test } from "@playwright/test";

test("mobile layout shows checkpoint cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Current understanding")).toBeVisible();
  await expect(page.getByLabel("Problem statement")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtime status" })).toBeVisible();
});
