import { chromium, expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
const imdbPath = resolve("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv");
const tvtimePath = resolve("initial-data/tvtime-export-2026-07-11.zip");

test("runs the live reduced fixture import through the unpacked UI", async () => {
  test.skip(process.env.RUN_FIXTURE_IMPORT_E2E !== "1", "Set RUN_FIXTURE_IMPORT_E2E=1 for the optional live fixture flow.");
  test.skip(!existsSync(imdbPath) || !existsSync(tvtimePath), "The private local fixtures are not available.");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html#/import`);
    await expect(page.getByText("Fixture subset mode: importing newest 20 shows plus Silo and House of the Dragon.")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles([imdbPath, tvtimePath]);
    await expect(page.getByText(/IMDb: 184 rows parsed/)).toBeVisible();
    await expect(page.getByText(/TV Time: 213 shows and 8368 episodes parsed/)).toBeVisible();
    await page.getByRole("button", { name: "Analyze sources" }).click();
    await expect(page.getByRole("heading", { name: "Import report" })).toBeVisible({ timeout: 90_000 });
    const counts = page.locator(".import-counts");
    await expect(counts).toContainText("Parsed source records397");
    await expect(counts).toContainText("Selected fixture shows22");
    await expect(counts).toContainText("Matched22");
    await expect(counts).toContainText("Unmatched0");
    await expect(page.locator(".report-metrics")).toContainText("Watched episodes successfully mapped301");
    await expect(page.locator(".report-metrics")).toContainText("Explicit unwatched episodes mapped14");
    await expect(page.locator(".report-metrics")).toContainText("Provider/network errors0");
    await page.getByRole("button", { name: "Continue to progress setup" }).click();
    await page.getByRole("button", { name: "Build final preview" }).click();
    await expect(page.getByText("22 shows will be committed: 22 new and 0 updated.")).toBeVisible();
    await page.getByRole("button", { name: "Commit import once" }).click();
    await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
    await expect(page.getByText("22 shows committed: 22 new and 0 updated.")).toBeVisible();
    await expect(counts).toContainText("Committed22");
    await expect(page.locator(".source-count-summary")).toContainText("TV Time episodes: 8368 parsed / 433 selected");

    await page.getByRole("link", { name: "Watch List" }).click();
    const silo = page.locator("article.watch-card").filter({ has: page.getByRole("heading", { name: /Silo/i }) });
    const hotd = page.locator("article.watch-card").filter({ has: page.getByRole("heading", { name: /House of the Dragon/i }) });
    await expect(silo).toContainText("S03 · E01");
    await expect(silo).toContainText("+1");
    await expect(hotd).toContainText("S03 · E01");
    await silo.getByRole("button", { name: /Mark .* watched/ }).click();
    await expect(silo).toContainText("S03 · E02");
    await page.getByRole("link", { name: "Upcoming" }).click();
    await expect(page.locator("article.upcoming-card").filter({ hasText: /Silo/i })).toContainText("S03 · E03");
    await expect(page.locator("article.upcoming-card").filter({ hasText: /House of the Dragon/i })).toContainText("S03 · E04");
  } finally {
    await context.close();
  }
});
