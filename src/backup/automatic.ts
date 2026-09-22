import { createBackup, parseBackup } from "./backup";
import { readLocalState, type LocalState } from "../storage/local-state";
import { backupDb, readBackupDestination, readBackupSettings, withBackupLock, type BackupDestination, type BackupFile, type BackupFrequency, type BackupSettings } from "./automatic-store";

export const BACKUP_ALARM = "show-tracker:automatic-backup";
const RETAINED_BACKUPS = 5;
const RETRY_DELAY = 60 * 60 * 1000;
const downloadUrls = new Map<number, string>();

async function downloadBackup(contents: string, name: string) {
  const url = import.meta.env.FIREFOX
    ? URL.createObjectURL(new Blob([contents], { type: "application/json" }))
    : `data:application/json;charset=utf-8,${encodeURIComponent(contents)}`;
  try {
    const id = await chrome.downloads.download({ url, filename: `Show Tracker Backups/${name}`, conflictAction: "uniquify", saveAs: false });
    if (import.meta.env.FIREFOX) downloadUrls.set(id, url);
    return id;
  } catch (error) {
    if (import.meta.env.FIREFOX) URL.revokeObjectURL(url);
    throw error;
  }
}

export function nextBackupCheck(now: number, frequency: BackupFrequency) {
  if (frequency === "monthly") {
    const next = new Date(now);
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
    return next.getTime();
  }
  return now + (frequency === "weekly" ? 7 : 1) * 24 * 60 * 60 * 1000;
}

export async function hashText(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function backupFingerprint(state: LocalState) {
  return hashText(JSON.stringify({
    shows: state.shows.map((show) => ({ ...show, providerUpdatedAt: undefined, updatedAt: undefined })),
    progress: state.progress, history: state.history, settings: state.settings,
  }));
}

async function ensureBackupAlarm(settings: BackupSettings) {
  if (settings.frequency === "off") { await chrome.alarms.clear(BACKUP_ALARM); return; }
  if (!await chrome.alarms.get(BACKUP_ALARM)) await chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 15 });
}

async function pruneBackups(destination: BackupDestination) {
  while (destination.files.length > RETAINED_BACKUPS) {
    const oldest = destination.files[0]!;
    if (!/^show-tracker-auto-[\dT-]+Z-[\da-f-]+\.json$/.test(oldest.name)) throw new Error("An unrecognized backup was left untouched.");
    if (destination.handle) {
      try {
        const handle = await destination.handle.getFileHandle(oldest.name);
        const contents = await (await handle.getFile()).text();
        if (await hashText(contents) !== oldest.contentHash) throw new Error("An older backup was modified. It was left untouched; move it out of the backup folder to resume cleanup.");
        await destination.handle.removeEntry(oldest.name);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
      }
    } else if (oldest.downloadId !== undefined) {
      const [download] = await chrome.downloads.search({ id: oldest.downloadId });
      if (!download) throw new Error("An older backup is no longer in the browser's download history and was left untouched.");
      if (download) {
        if (download.byExtensionId !== chrome.runtime.id || download.filename.replaceAll("\\", "/").split("/").at(-1) !== oldest.name) {
          throw new Error("An older download could not be verified as this extension's backup; it was left untouched.");
        }
        if (download.exists) await chrome.downloads.removeFile(oldest.downloadId);
      }
    }
    destination.files.shift();
    await backupDb.destinations.put(destination);
  }
}

async function finishBackup(destination: BackupDestination, file: BackupFile, settings: BackupSettings, now: number) {
  if (!destination.files.some((entry) => entry.name === file.name)) destination.files.push(file);
  delete destination.pending;
  await backupDb.destinations.put(destination);
  settings.lastSuccessAt = now;
  if (settings.destinationId === destination.id) settings.nextCheckAt = nextBackupCheck(now, settings.frequency);
  settings.message = "Backup saved successfully.";
  delete settings.error;
  await backupDb.settings.put(settings);
  try { await pruneBackups(destination); }
  catch { settings.error = "Backup saved, but some older files could not be removed. They were kept for safety; check folder access and the older backup files."; await backupDb.settings.put(settings); }
}

async function settleDownload(destination: BackupDestination, settings: BackupSettings, now: number) {
  const pending = destination.pending;
  if (pending?.downloadId === undefined) return false;
  if (!await chrome.permissions.contains({ permissions: ["downloads"] })) throw new Error("Downloads access was removed. Re-enable automatic backups to grant it again.");
  const [download] = await chrome.downloads.search({ id: pending.downloadId });
  if (download?.state === "in_progress") return true;
  const url = downloadUrls.get(pending.downloadId);
  if (url) { URL.revokeObjectURL(url); downloadUrls.delete(pending.downloadId); }
  if (download?.state === "complete" && download.exists && download.byExtensionId === chrome.runtime.id) {
    pending.name = download.filename.replaceAll("\\", "/").split("/").at(-1)!;
    await finishBackup(destination, pending, settings, now);
    return settings.destinationId === destination.id;
  }
  delete destination.pending;
  await backupDb.destinations.put(destination);
  throw new Error("The backup download did not finish. Previous backups were kept. Check your browser's Downloads and try again.");
}

export async function runAutomaticBackup(force = false) {
  return withBackupLock(async () => {
    const settings = await readBackupSettings();
    await ensureBackupAlarm(settings);
    const now = Date.now();
    try {
      for (const destination of await backupDb.destinations.toArray()) {
        if (destination.pending && destination.id !== settings.destinationId && !await chrome.permissions.contains({ permissions: ["downloads"] })) continue;
        if (destination.pending && await settleDownload(destination, settings, now)) return;
      }
      if (settings.frequency === "off" || (!force && settings.nextCheckAt > now)) return;
      const state = await readLocalState();
      if (state.importCommit && state.importCommit.marker !== "complete") {
        settings.nextCheckAt = now + 15 * 60 * 1000;
        settings.message = "Waiting for the import to finish before backing up.";
        await backupDb.settings.put(settings);
        return;
      }
      if (!state.shows.length && !state.progress.length && !state.history.length) {
        settings.nextCheckAt = nextBackupCheck(now, settings.frequency);
        settings.message = "No library data to back up yet. Existing backups were kept.";
        await backupDb.settings.put(settings);
        return;
      }
      const destination = await readBackupDestination(settings.destinationId);
      if (!destination) throw new Error("Choose your backup folder again in Settings.");
      if (destination.handle && await destination.handle.queryPermission({ mode: "readwrite" }) !== "granted") {
        throw new Error("Folder access has expired. Click Reconnect folder in Settings to allow backups again.");
      }
      if (!destination.handle && !await chrome.permissions.contains({ permissions: ["downloads"] })) {
        throw new Error("Downloads access is required. Re-enable automatic backups to grant it again.");
      }
      const dataHash = await backupFingerprint(state);
      if (!force && destination.files.at(-1)?.dataHash === dataHash) {
        settings.nextCheckAt = nextBackupCheck(now, settings.frequency);
        settings.message = "No changes since the last backup; no duplicate file created.";
        delete settings.error;
        await backupDb.settings.put(settings);
        return;
      }
      const contents = JSON.stringify(createBackup(state));
      parseBackup(contents);
      const file: BackupFile = { name: `show-tracker-auto-${new Date(now).toISOString().replaceAll(/[:.]/g, "-")}-${crypto.randomUUID()}.json`, createdAt: now, dataHash, contentHash: await hashText(contents) };
      if (destination.handle) {
        const handle = await destination.handle.getFileHandle(file.name, { create: true });
        const writer = await handle.createWritable();
        try { await writer.write(contents); await writer.close(); }
        catch (error) { await writer.abort().catch(() => undefined); throw error; }
        const saved = await (await handle.getFile()).text();
        if (await hashText(saved) !== file.contentHash) throw new Error("The written backup could not be verified. Previous backups were kept.");
        parseBackup(saved);
        await finishBackup(destination, file, settings, now);
      } else {
        file.downloadId = await downloadBackup(contents, file.name);
        destination.pending = file;
        await backupDb.destinations.put(destination);
        settings.message = "Saving backup…";
        delete settings.error;
        await backupDb.settings.put(settings);
        await settleDownload(destination, settings, now);
      }
    } catch (error) {
      delete settings.message;
      settings.error = error instanceof Error ? error.message : "Backup failed. Previous backups were kept.";
      settings.nextCheckAt = now + RETRY_DELAY;
      await backupDb.settings.put(settings);
    }
  });
}
