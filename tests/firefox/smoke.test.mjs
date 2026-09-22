import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

async function until(operation, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await operation(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(200);
  }
  throw lastError ?? new Error("Timed out waiting for Firefox.");
}

test("Firefox MV3 imports, persists progress, messages its background, and saves Downloads backups", { timeout: 180000 }, async () => {
  const output = resolve("test-results", `firefox-${randomUUID()}`);
  const extension = resolve(process.env.FIREFOX_EXTENSION_PATH ?? ".output/firefox-mv3");
  const manifest = JSON.parse(await readFile(resolve(extension, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ["background.js"] });
  assert.deepEqual(manifest.optional_permissions, ["downloads"]);
  const extensionId = manifest.browser_specific_settings.gecko.id;
  const extensionUuid = randomUUID();
  await mkdir(output, { recursive: true });
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const driver = spawn(process.env.GECKODRIVER ?? resolve(".output/tools", process.platform === "win32" ? "geckodriver.exe" : "geckodriver"), ["--port", String(port), "--host", "127.0.0.1", "--allow-system-access"], { windowsHide: true });
  let driverLog = "";
  let launchError;
  driver.on("error", (error) => { launchError = error; });
  driver.stdout.on("data", (chunk) => { driverLog += chunk; });
  driver.stderr.on("data", (chunk) => { driverLog += chunk; });
  let session;
  async function request(path, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value));
    return result.value;
  }
  const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
  const evaluate = (script, args = []) => command("/execute/sync", { script, args });
  const evaluateAsync = async (script, args = []) => {
    const result = await command("/execute/async", { script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then(value => done({value}), error => done({error: String(error)}));`, args });
    assert.equal(result.error, undefined, result.error);
    return result.value;
  };
  const element = async (selector) => {
    const result = await until(() => command("/element", { using: "css selector", value: selector }));
    return result["element-6066-11e4-a52e-4f735466cecf"];
  };
  const click = async (selector) => command(`/element/${await element(selector)}/click`, {});
  const bodyText = () => evaluate("return document.body.innerText");
  try {
    await until(async () => { if (launchError) throw launchError; return (await request("/status")).ready; });
    const started = await request("/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": {
      ...(process.env.FIREFOX_BINARY || process.platform === "win32" ? { binary: process.env.FIREFOX_BINARY ?? "C:\\Program Files\\Mozilla Firefox\\firefox.exe" } : {}),
      args: ["-headless"], prefs: {
        "extensions.webextensions.uuids": JSON.stringify({ [extensionId]: extensionUuid }),
        "browser.download.folderList": 2, "browser.download.dir": output,
        "browser.download.useDownloadDir": true, "browser.download.alwaysOpenPanel": false,
        "browser.helperApps.neverAsk.saveToDisk": "application/json",
      },
    } } } });
    session = started.sessionId;
    await command("/moz/addon/install", { path: extension, temporary: true });
    const dashboard = `moz-extension://${extensionUuid}/dashboard.html`;
    await command("/url", { url: dashboard });
    await element("#import-files");
    assert.match(await bodyText(), /Import/);
    assert.equal(await evaluateAsync("return (await chrome.storage.local.get('trackerState')).trackerState.shows.length;"), 0);
    await evaluate(`const nativeFetch = window.fetch; window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname !== 'api.tvmaze.com') return nativeFetch(input, options);
      const show = {id:100, name:'Silo', status:'Running', updated:123, externals:{imdb:'tt1', thetvdb:10, tvrage:null}};
      const episodes = [1,2,3].map(number => ({id:number, season:1, number, name:'Episode '+number, type:'regular', airdate:number===3?'2099-01-01':'2025-01-01', airtime:'00:00', airstamp:number===3?'2099-01-01T00:00:00Z':'2025-01-01T00:00:00Z'}));
      return new Response(JSON.stringify(url.pathname.endsWith('/episodes') ? episodes : url.pathname.endsWith('/alternatelists') ? [] : show), {headers:{'Content-Type':'application/json'}});
    };`);
    const archive = resolve(output, "bingers.zip");
    const imdb = resolve(output, "imdb.csv");
    await writeFile(archive, zipSync({
      "library.csv": strToU8("type,title,original_title,year,tvdb_id,tmdb_id,list_status,added_at\nshow,Silo,Silo,2023,10,100,watching,2024-01-01T00:00:00Z"),
      "watches.csv": strToU8("type,title,tvdb_id,tmdb_id,season_number,episode_number,first_watched_at,last_watched_at,plays\nepisode,Silo,10,100,1,2,2025-01-03T00:00:00Z,2025-01-04T00:00:00Z,2"),
    }));
    await writeFile(imdb, "Const,Title,Title Type,Created\ntt1,Silo,TV Series,2024-01-01");
    await command(`/element/${await element("#import-files")}/value`, { text: `${archive}\n${imdb}` });
    await until(() => evaluate("const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Import 1 show'); if (!button || button.disabled) return false; button.id = 'firefox-import'; return true;"));
    await click("#firefox-import");
    await until(async () => (await bodyText()).includes("Go to Watch List"));
    const state = await evaluateAsync("return (await chrome.storage.local.get('trackerState')).trackerState;");
    assert.equal(state.shows.length, 1);
    assert.equal(state.progress.filter(episode => episode.watched).length, 2);
    assert.equal(state.progress.find(episode => episode.tvmazeEpisodeId === 2).rewatchCount, 1);
    assert.equal(state.progress.some(episode => episode.tvmazeEpisodeId === 3), false);
    await command("/refresh", {});
    assert.deepEqual(await evaluateAsync("return (await chrome.storage.local.get('trackerState')).trackerState.progress;"), state.progress);
    await command("/url", { url: `${dashboard}#/settings` });
    await element("#backup-frequency");
    assert.equal(await evaluate("return typeof window.showDirectoryPicker"), "undefined");
    assert.match(await bodyText(), /Firefox does not support/);
    assert.equal((await evaluateAsync("return chrome.runtime.sendMessage({type:'AUTO_BACKUP_RUN'});")).ok, true);
    assert.equal(await evaluateAsync("return chrome.permissions.contains({permissions:['downloads']});"), false);
    await evaluate("document.querySelectorAll('button').forEach(button => { if (button.textContent === 'Preview the alert') button.id = 'preview-alert'; });");
    await click("#preview-alert");
    await until(async () => (await evaluateAsync("return chrome.action.getTitle({});")).includes("Example Show"));
    await until(() => evaluate("return document.getElementById('preview-alert')?.textContent === 'Preview the alert';"));
    await writeFile(resolve(output, "settings.png"), Buffer.from(await command("/screenshot"), "base64"));
    await click("#backup-frequency option[value='weekly']");
    await until(() => evaluate("const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Apply schedule'); if (!button || button.disabled) return false; button.id = 'apply-schedule'; return true;"));
    await click("#apply-schedule");
    await command("/moz/context", { context: "chrome" });
    await until(() => evaluate("const notification = document.getElementById('addon-webext-permissions-notification'); if (!notification?.button || notification.hidden) return false; notification.button.click(); return true;"));
    await command("/moz/context", { context: "content" });
    await until(async () => /Last successful automatic backup: (?!Not yet)/.test(await bodyText()));
    const downloads = await evaluateAsync("return chrome.downloads.search({state:'complete'});");
    const backup = downloads.find(download => download.filename.includes("show-tracker-auto-"));
    assert.ok(backup, "An actual backup file should be downloaded");
    assert.equal(backup.byExtensionId, extensionId);
    assert.deepEqual(JSON.parse(await readFile(backup.filename, "utf8")).state.progress, state.progress);
    assert.ok(await evaluateAsync("return chrome.alarms.get('show-tracker:automatic-backup');"));
    const backupFolder = resolve(output, "Show Tracker Backups");
    await writeFile(resolve(backupFolder, "manual-backup.json"), "manual export");
    for (let number = 0; number < 5; number++) {
      assert.equal((await evaluateAsync("return chrome.runtime.sendMessage({type:'AUTO_BACKUP_RUN', force:true});")).ok, true);
      await until(async () => (await evaluateAsync("return chrome.downloads.search({state:'complete'});")).filter(download => download.filename.includes("show-tracker-auto-")).length === number + 2);
      await until(() => evaluateAsync("return new Promise((resolve, reject) => { const request = indexedDB.open('showTrackerBackups'); request.onerror = () => reject(request.error); request.onsuccess = () => { const database = request.result; const query = database.transaction('destinations').objectStore('destinations').get('downloads'); query.onsuccess = () => { database.close(); resolve(!query.result.pending); }; query.onerror = () => { database.close(); reject(query.error); }; }; });"));
    }
    await until(async () => (await readdir(backupFolder)).filter(name => name.startsWith("show-tracker-auto-")).length === 5);
    assert.equal(await readFile(resolve(backupFolder, "manual-backup.json"), "utf8"), "manual export");
    await click("#backup-frequency option[value='off']");
    await click("#apply-schedule");
    await until(async () => !await evaluateAsync("return chrome.alarms.get('show-tracker:automatic-backup');"));
    await writeFile(resolve(output, "backup.png"), Buffer.from(await command("/screenshot"), "base64"));
  } catch (error) {
    if (session) {
      await writeFile(resolve(output, "failure.txt"), await bodyText().catch(String));
      await command("/screenshot").then(data => writeFile(resolve(output, "failure.png"), Buffer.from(data, "base64"))).catch(() => {});
    }
    throw error;
  } finally {
    if (session) await command("", undefined, "DELETE").catch(() => {});
    driver.kill();
    await writeFile(resolve(output, "geckodriver.log"), driverLog);
  }
});
