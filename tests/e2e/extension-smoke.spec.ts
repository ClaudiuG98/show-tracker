import { expect, test, chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/import`);
    await expect(page.getByRole("heading", { name: "Import", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByText("Fixture subset mode:")).toHaveCount(process.env.EXPECT_FIXTURE_MODE === "1" ? 1 : 0);
    await page.setViewportSize({ width: 320, height: 720 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus-visible")).toBeVisible();
  } finally {
    await context.close();
  }
});
