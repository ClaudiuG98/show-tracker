import { expect, test, chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bingersZip } from "../fixtures/bingers";

test("keeps multiple history undo errors inline without overlap", async () => {
  const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  test.skip(!existsSync(resolve(extensionPath, "manifest.json")), "Build the Chrome extension first.");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    await worker.evaluate(async () => {
      const episode = { localShowId: "show", tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true, source: "user" };
      const action = { showId: "show", episodeKeys: ["1"], action: "watched", occurredAt: "2026-01-01T12:00:00.000Z",
        before: { episodes: [], userState: "watching" }, after: { episodes: [episode], userState: "watching" } };
      await chrome.storage.local.set({ trackerState: {
        schemaVersion: 1, settings: { timezone: "UTC", dateOnlyReleaseHour: "09:00", notifications: false },
        shows: [{ id: "show", titleSnapshot: "Bodies", externalIds: { tvmazeShow: 1 }, userState: "watching",
          createdAt: action.occurredAt, updatedAt: action.occurredAt, importSources: ["manual"] }],
        progress: [{ ...episode, rewatchCount: 1 }], history: [{ ...action, id: "first" }, { ...action, id: "second" }],
      } });
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html#/watch-list`);
    await page.locator(".history > summary").click();
    await expect(page.locator(".history-group")).toHaveCount(1);
    await expect(page.locator(".history-group > summary .poster")).toHaveCount(1);
    await expect(page.locator(".history-entry .poster")).toHaveCount(0);
    await expect(page.locator(".history-group > summary")).toContainText("1 episode marked watched · 2 actions");
    await expect(page.getByRole("button", { name: "Undo", exact: true }).first()).not.toBeVisible();
    await page.locator(".history-group > summary").click();
    await page.getByRole("button", { name: "Undo", exact: true }).first().click();
    await page.getByRole("button", { name: "Undo", exact: true }).nth(1).click();
    const alerts = page.getByRole("alert").filter({ hasText: "Cannot undo" });
    await expect(alerts).toHaveCount(2);
    const feedback = alerts.first();
    await expect(feedback).toBeVisible();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await feedback.scrollIntoViewIfNeeded();
      await expect.poll(async () => feedback.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth;
      })).toBe(true);
      const firstBox = await alerts.first().boundingBox();
      const secondBox = await alerts.nth(1).boundingBox();
      expect(firstBox!.y + firstBox!.height).toBeLessThanOrEqual(secondBox!.y);
      await expect(alerts.first()).not.toContainText("Try again");
      await page.screenshot({ path: test.info().outputPath(`history-errors-${width}.png`), fullPage: true });
      await expect.poll(async () => feedback.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
      })).toBe(true);
    }
  } finally {
    await context.close();
  }
});

test("imports a Bingers ZIP alongside IMDb through confirmation and commit", async () => {
  const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", { channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    await context.route("https://api.tvmaze.com/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const show = { id: 100, name: "Silo", status: "Running", updated: 123, externals: { imdb: "tt1", thetvdb: 10, tvrage: null } };
      const episodes = [1, 2, 3].map((number) => ({ id: number, season: 1, number, name: `Episode ${number}`, type: "regular",
        airdate: number === 3 ? "2099-01-01" : "2025-01-01", airtime: "00:00", airstamp: number === 3 ? "2099-01-01T00:00:00Z" : "2025-01-01T00:00:00Z" }));
      await route.fulfill({ json: path.endsWith("/episodes") ? episodes : path.endsWith("/alternatelists") ? [] : show });
    });
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html`);
    await page.locator("#import-files").setInputFiles([
      { name: "export.zip", mimeType: "application/zip", buffer: Buffer.from(bingersZip()) },
      { name: "imdb.csv", mimeType: "text/csv", buffer: Buffer.from("Const,Title,Title Type,Created\ntt1,Silo,TV Series,2024-01-01") },
    ]);
    await expect(page.locator(".selected-files")).toContainText("Bingers");
    await page.getByRole("button", { name: "Import 1 show", exact: true }).click();
    await expect(page.getByRole("link", { name: "Go to Watch List" })).toBeVisible();
    const state = await worker.evaluate(async () => (await chrome.storage.local.get("trackerState")).trackerState);
    expect(state.shows).toHaveLength(1);
    expect(state.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ tvmazeEpisodeId: 1, watched: true }),
      expect.objectContaining({ tvmazeEpisodeId: 2, watched: true, rewatchCount: 1 }),
    ]));
    expect(state.progress.some((episode: { tvmazeEpisodeId: number }) => episode.tvmazeEpisodeId === 3)).toBe(false);
    await page.screenshot({ path: test.info().outputPath("bingers-import.png"), fullPage: true });
  } finally { await context.close(); }
});

test("loads the unpacked extension dashboard and importer", async () => {
  const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  test.skip(!existsSync(resolve(extensionPath, "manifest.json")), "Build the Chrome extension before the unpacked smoke test.");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await expect(page.getByRole("heading", { name: "Import", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/import$/);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 720 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toBeVisible();
  } finally {
    await context.close();
  }
});
