import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "/home/jenkins/Documents/jfmaes-me/public/blog/crossfire-when-one-llm-isnt-enough";

test("capture spec screenshot from existing session", async ({ page }) => {
  // Session 79b23b30 has a spec at checkpoint
  await page.goto("/#/session/79b23b30-e1b1-4a77-ab39-d1e879cf2d7d");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".card--spec")).toBeVisible({ timeout: 10_000 });
  await page.locator(".card--spec").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-spec-generated.png` });
});

test("capture finalized screenshot from existing session", async ({ page }) => {
  // Session 16a6d855 is finalized
  await page.goto("/#/session/16a6d855-2505-4af0-bdd1-63468fde6bd1");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".finalized-banner")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/09-finalized.png` });
});
