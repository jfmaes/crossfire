import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = "/home/jenkins/Documents/jfmaes-me/public/blog/crossfire-when-one-llm-isnt-enough";
const PHASE_TIMEOUT = 900_000; // 15 minutes per phase wait

test("full session lifecycle — real providers", async ({ page }) => {
  // ── 00: Landing page ──
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/00-landing.png` });

  // ── 01: Fill the prompt ──
  await page.getByLabel("Problem statement").fill(
    "Build a CLI bookmark manager that stores URLs with tags in a local SQLite database."
  );
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-prompt-filled.png` });

  // ── Submit ──
  await page.getByRole("button", { name: "Start session" }).click();

  // Wait for interview (analysis + question debate done, auto-advanced)
  await expect(page.getByRole("heading", { name: "Interview" })).toBeVisible({ timeout: PHASE_TIMEOUT });
  // Scroll to top to capture analysis + interview together
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-dual-analysis.png` });

  // Scroll down to interview card
  await page.locator(".card--interview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-interview-question.png` });

  // ── Answer first question ──
  await page.getByLabel("Your answer").fill("SQLite with FTS5 for full-text search on tags and URLs. Single user, no sync needed.");
  await page.getByRole("button", { name: "Submit answer" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-interview-answered.png` });

  // ── Skip to approach debate ──
  await page.getByLabel("Your answer").fill("enough");
  await page.getByRole("button", { name: "Submit answer" }).click();

  // Wait for approach debate checkpoint
  await expect(page.locator(".card--debate")).toBeVisible({ timeout: PHASE_TIMEOUT });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-approach-debate.png` });

  // ── Continue to spec ──
  await page.getByLabel("Your response").fill("Looks good, generate the spec.");
  await page.getByRole("button", { name: "Continue session" }).click();

  await expect(page.locator(".card--spec")).toBeVisible({ timeout: PHASE_TIMEOUT });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-spec-generated.png` });

  // ── Approve ──
  await page.getByLabel("Review").fill("approve");
  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.locator(".finalized-banner")).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/09-finalized.png` });
});
