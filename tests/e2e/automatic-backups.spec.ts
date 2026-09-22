import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import { resolve } from "node:path";
import { cpSync, readFileSync, writeFileSync } from "node:fs";

async function openSettings(context: BrowserContext) {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent("serviceworker");
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ trackerState: {
      schemaVersion: 1, shows: [{ id: "demo", titleSnapshot: "Demo Show", externalIds: {}, userState: "watching", importSources: ["manual"], createdAt: "2026-01-01", updatedAt: "2026-01-01" }], progress: [], history: [],
      settings: { timezone: "UTC", dateOnlyReleaseHour: "09:00", notifications: false },
    } });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/dashboard.html#/settings`);
  await expect(page.getByLabel("Frequency", { exact: true })).toBeEnabled();
  return { page, worker };
}

test("automatic backups save a real Downloads file with pre-granted permission and can be disabled", async () => {
  const sourcePath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  const extensionPath = test.info().outputPath("extension-with-downloads-permission");
  cpSync(sourcePath, extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expect(manifest.optional_permissions).toContain("downloads");
  manifest.permissions.push("downloads");
  delete manifest.optional_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext("", { channel: "chromium", headless: false,
    downloadsPath: test.info().outputPath("downloads"),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const { page, worker } = await openSettings(context);
    await expect(page.getByLabel("Frequency", { exact: true })).toHaveValue("off");
    await page.getByLabel("Frequency", { exact: true }).selectOption("weekly");
    await expect(page.getByText("Backup saved successfully.", { exact: false })).toBeVisible({ timeout: 15000 });
    const files = await worker.evaluate(async () => (await chrome.downloads.search({})).filter((download) => download.byExtensionId === chrome.runtime.id));
    expect(files).toHaveLength(1);
    expect(files[0]!.state).toBe("complete");
    await page.getByLabel("Frequency", { exact: true }).selectOption("off");
    await expect(page.getByRole("button", { name: "Back up now" })).toBeDisabled();
    await expect.poll(() => worker.evaluate(async () => await chrome.alarms.get("show-tracker:automatic-backup"))).toBeUndefined();
  } finally { await context.close(); }
});

test("a selected directory survives reload, retains five backups, and reports lost access", async () => {
  const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", { channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const { page, worker } = await openSettings(context);
    expect(await page.evaluate(() => typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker)).toBe("function");
    await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("Test backups", { create: true });
      Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => folder });
    });
    await page.getByRole("button", { name: "Choose folder…" }).click();
    await expect(page.getByText("Test backups", { exact: false })).toBeVisible();
    await page.getByLabel("Frequency", { exact: true }).selectOption("daily");
    const saved = page.getByText("Backup saved successfully.", { exact: false });
    await expect(saved).toBeVisible();
    await page.reload();
    await expect(page.getByText("Test backups", { exact: false })).toBeVisible();
    const readFiles = () => worker.evaluate(async () => {
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("Test backups");
      const results: string[] = [];
      for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) results.push(name);
      return results;
    });
    expect(await readFiles()).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      const before = await readFiles();
      await page.getByRole("button", { name: "Back up now" }).click();
      await expect.poll(readFiles).not.toEqual(before);
      await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();
    }
    expect(await readFiles()).toHaveLength(5);
    await worker.evaluate(() => { Object.defineProperty(FileSystemDirectoryHandle.prototype, "queryPermission", { configurable: true, value: async () => "prompt" }); });
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Folder access has expired" })).toBeVisible();
    expect(await readFiles()).toHaveLength(5);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator(".automatic-backups").scrollIntoViewIfNeeded();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.locator(".automatic-backups").screenshot({ path: test.info().outputPath(`automatic-backups-${width}.png`), animations: "disabled" });
    }
  } finally { await context.close(); }
});

test("shows an explanation when the browser does not expose a native folder picker", async () => {
  const extensionPath = resolve(process.env.EXTENSION_PATH ?? ".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", { channel: "chromium", headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    await context.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined }));
    const { page } = await openSettings(context);
    await expect(page.getByRole("button", { name: "Choose folder…" })).toBeDisabled();
    await expect(page.locator("#backup-folder-support")).toContainText("Automatic backups can still use Downloads/Show Tracker Backups");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { await context.close(); }
});
