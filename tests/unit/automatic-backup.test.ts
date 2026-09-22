import { webcrypto } from "node:crypto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupDb, configureBackups, defaultBackupSettings, defaultDestination, type BackupDestination, type BackupDirectory, type BackupFile, type BackupSettings } from "../../src/backup/automatic-store";
import { BACKUP_ALARM, backupFingerprint, hashText, nextBackupCheck, runAutomaticBackup } from "../../src/backup/automatic";
import { createBackup, parseBackup } from "../../src/backup/backup";
import { emptyLocalState, type LocalState } from "../../src/storage/local-state";

let settings: BackupSettings;
let state: LocalState;
let destinations: Map<string, BackupDestination>;
let downloads: Map<number, chrome.downloads.DownloadItem>;
const now = Date.parse("2026-01-31T12:00:00Z");
const hasDownloads = vi.fn(async () => true);

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(Date, "now").mockReturnValue(now);
  settings = { ...defaultBackupSettings(), frequency: "weekly" };
  state = { ...emptyLocalState(), shows: [{ id: "show", titleSnapshot: "Silo", externalIds: { tvmazeShow: 100 }, userState: "watching", importSources: ["manual"], createdAt: "2026-01-01", updatedAt: "2026-01-01" }] };
  destinations = new Map(); downloads = new Map();
  hasDownloads.mockResolvedValue(true);
  vi.spyOn(backupDb.settings, "get").mockImplementation(() => Dexie.Promise.resolve(structuredClone(settings)));
  vi.spyOn(backupDb.settings, "put").mockImplementation((value) => { settings = structuredClone({ ...value, id: "settings" }); return Dexie.Promise.resolve("settings"); });
  vi.spyOn(backupDb.destinations, "get").mockImplementation((key) => Dexie.Promise.resolve(destinations.get(String(key))));
  vi.spyOn(backupDb.destinations, "toArray").mockImplementation(() => Dexie.Promise.resolve([...destinations.values()]));
  vi.spyOn(backupDb.destinations, "put").mockImplementation((value) => { const destination = { ...value, id: value.id! }; destinations.set(destination.id, destination); return Dexie.Promise.resolve(destination.id); });
  vi.stubGlobal("chrome", {
    runtime: { id: "test-extension" },
    storage: { local: { get: vi.fn(async () => ({ trackerState: state })) } },
    alarms: { get: vi.fn(async () => undefined), create: vi.fn(), clear: vi.fn() },
    permissions: { contains: hasDownloads },
    downloads: {
      download: vi.fn(async (options: chrome.downloads.DownloadOptions) => {
        const id = downloads.size + 1;
        downloads.set(id, { id, state: "in_progress", exists: true, byExtensionId: "test-extension", filename: `C:/Downloads/${options.filename}` } as chrome.downloads.DownloadItem);
        return id;
      }),
      search: vi.fn(async (query: chrome.downloads.DownloadQuery) => downloads.has(query.id!) ? [downloads.get(query.id!)!] : []),
      removeFile: vi.fn(async () => undefined),
    },
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function completedDownload() {
  await runAutomaticBackup();
  downloads.get(1)!.state = "complete";
  await runAutomaticBackup();
}

function directory(permission: PermissionState = "granted") {
  const files = new Map<string, string>();
  const removed = vi.fn(async (name: string) => { files.delete(name); });
  const close = vi.fn(async () => undefined);
  const handle = {
    name: "My backups", queryPermission: vi.fn(async () => permission), removeEntry: removed,
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!options?.create && !files.has(name)) throw new DOMException("Missing", "NotFoundError");
      return { getFile: async () => ({ text: async () => files.get(name) ?? "" }), createWritable: async () => ({ write: async (contents: string) => { files.set(name, contents); }, close, abort: vi.fn(async () => undefined) }) };
    }),
  } as unknown as BackupDirectory;
  settings.destinationId = "custom";
  destinations.set("custom", { id: "custom", name: handle.name, handle, files: [] });
  return { handle, files, removed, close };
}

describe("automatic backups", () => {
  it("writes the Show Tracker format and restores legacy backup files", () => {
    expect(createBackup(state).format).toBe("show-tracker");
    const legacy = JSON.stringify({ ...createBackup(state), format: "imdb-shows-tracker" });
    expect(parseBackup(legacy)).toMatchObject({ format: "show-tracker", state });
  });
  it("uses a Firefox blob URL and releases it only after the download completes", async () => {
    vi.stubEnv("FIREFOX", "true");
    const createObjectURL = vi.fn(() => "blob:firefox-backup");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    await runAutomaticBackup();
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(chrome.downloads.download).toHaveBeenCalledWith(expect.objectContaining({ url: "blob:firefox-backup" }));
    expect(revokeObjectURL).not.toHaveBeenCalled();
    downloads.get(1)!.state = "complete";
    await runAutomaticBackup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:firefox-backup");
    expect(settings.lastSuccessAt).toBe(now);
  });
  it("releases the Firefox blob URL if starting the download fails", async () => {
    vi.stubEnv("FIREFOX", "true");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:failed-backup"), revokeObjectURL });
    vi.mocked(chrome.downloads.download).mockRejectedValue(new Error("Download blocked"));
    await runAutomaticBackup();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:failed-backup");
    expect(settings.lastSuccessAt).toBeUndefined();
    expect(settings.error).toBe("Download blocked");
  });
  it("is off by default and clears its alarm without downloading", async () => {
    settings = defaultBackupSettings();
    await runAutomaticBackup(true);
    expect(chrome.alarms.clear).toHaveBeenCalledWith(BACKUP_ALARM);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("calculates daily, weekly, and clamped calendar-month intervals", () => {
    expect(nextBackupCheck(now, "daily") - now).toBe(86_400_000);
    expect(nextBackupCheck(now, "weekly") - now).toBe(7 * 86_400_000);
    expect(new Date(nextBackupCheck(now, "monthly")).toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });
  it("writes a valid backup to Downloads and waits for completion before recording success", async () => {
    await runAutomaticBackup();
    const options = vi.mocked(chrome.downloads.download).mock.calls[0]![0];
    expect(options.filename).toMatch(/^Show Tracker Backups\/show-tracker-auto-/);
    expect(options.conflictAction).toBe("uniquify");
    expect(parseBackup(decodeURIComponent(options.url.split(",")[1]!)).state.shows).toEqual(state.shows);
    expect(settings.lastSuccessAt).toBeUndefined();
    expect(destinations.get("downloads")!.files).toHaveLength(0);
    downloads.get(1)!.state = "complete";
    await runAutomaticBackup();
    expect(settings.lastSuccessAt).toBe(now);
    expect(destinations.get("downloads")!.pending).toBeUndefined();
    expect(destinations.get("downloads")!.files).toHaveLength(1);
  });
  it("does not overlap in-flight backups, even when forced", async () => {
    await Promise.all([runAutomaticBackup(true), runAutomaticBackup(true)]);
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
  });
  it("skips unchanged data at the next due check and ignores badge and sync timestamps", async () => {
    await completedDownload();
    settings.nextCheckAt = 0;
    state.lastSyncAt = new Date(now).toISOString(); state.lastReleaseSeenAt = new Date(now).toISOString();
    state.shows[0]!.providerUpdatedAt = now;
    state.shows[0]!.updatedAt = new Date(now).toISOString();
    await runAutomaticBackup();
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    expect(settings.message).toContain("No changes");
  });
  it("detects progress edits but not transient sync state", async () => {
    const original = await backupFingerprint(state);
    state.lastSyncFailure = { attempt: 1, message: "Offline", failedAt: new Date(now).toISOString() };
    expect(await backupFingerprint(state)).toBe(original);
    state.progress.push({ localShowId: "show", season: 1, episode: 1, watched: true, source: "user" });
    expect(await backupFingerprint(state)).not.toBe(original);
  });
  it("honors the interval, but allows an explicit unchanged backup", async () => {
    await completedDownload();
    await runAutomaticBackup();
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    await runAutomaticBackup(true);
    expect(chrome.downloads.download).toHaveBeenCalledTimes(2);
  });
  it("catches up once, not once per missed interval", async () => {
    settings.nextCheckAt = now - 90 * 86_400_000;
    await completedDownload();
    await runAutomaticBackup();
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    expect(settings.nextCheckAt).toBe(nextBackupCheck(now, "weekly"));
  });
  it("does not replace backups with empty data or a partial import", async () => {
    state = emptyLocalState();
    await runAutomaticBackup(true);
    expect(settings.message).toContain("No library");
    state.importCommit = { sessionId: "import", marker: "prepared" };
    await runAutomaticBackup(true);
    expect(settings.message).toContain("Waiting");
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("reports removed download permission without marking success", async () => {
    hasDownloads.mockResolvedValue(false);
    await runAutomaticBackup();
    expect(settings.error).toContain("Downloads access");
    expect(settings.lastSuccessAt).toBeUndefined();
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("keeps previous backups when a download is interrupted", async () => {
    await runAutomaticBackup();
    downloads.get(1)!.state = "interrupted";
    await runAutomaticBackup();
    expect(settings.error).toContain("did not finish");
    expect(settings.lastSuccessAt).toBeUndefined();
    expect(chrome.downloads.removeFile).not.toHaveBeenCalled();
    expect(destinations.get("downloads")!.pending).toBeUndefined();
  });
  it("retains five completed downloads and never removes an in-flight backup", async () => {
    for (let index = 1; index <= 6; index++) {
      await runAutomaticBackup(true);
      expect(chrome.downloads.removeFile).not.toHaveBeenCalled();
      downloads.get(index)!.state = "complete";
      await runAutomaticBackup();
    }
    expect(chrome.downloads.removeFile).toHaveBeenCalledExactlyOnceWith(1);
    expect(destinations.get("downloads")!.files).toHaveLength(5);
  });
  it("writes and validates custom-folder backups without Downloads permission", async () => {
    const { files } = directory();
    hasDownloads.mockResolvedValue(false);
    await runAutomaticBackup();
    expect(files.size).toBe(1);
    expect(parseBackup([...files.values()][0]!).state.shows).toEqual(state.shows);
    expect(settings.lastSuccessAt).toBe(now);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
  it("asks for reconnection without attempting a background permission prompt", async () => {
    const { handle } = directory("prompt");
    await runAutomaticBackup();
    expect(settings.error).toContain("Reconnect folder");
    expect(handle.getFileHandle).not.toHaveBeenCalled();
  });
  it("does not prune custom backups if closing the new file fails", async () => {
    const { close, removed } = directory();
    close.mockRejectedValue(new Error("Disk full"));
    await runAutomaticBackup();
    expect(settings.error).toBe("Disk full");
    expect(settings.lastSuccessAt).toBeUndefined();
    expect(removed).not.toHaveBeenCalled();
  });
  it("prunes only owned, unchanged custom backups and leaves manual files alone", async () => {
    const { files, removed } = directory();
    files.set("manual-backup.json", "keep");
    for (let index = 0; index < 6; index++) await runAutomaticBackup(true);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(6);
    expect(files.get("manual-backup.json")).toBe("keep");
    expect(destinations.get("custom")!.files).toHaveLength(5);
  });
  it("keeps a modified older file and reports a cleanup warning", async () => {
    const { files, removed } = directory();
    for (let index = 0; index < 5; index++) await runAutomaticBackup(true);
    files.set(destinations.get("custom")!.files[0]!.name, "edited by the user");
    await runAutomaticBackup(true);
    expect(removed).not.toHaveBeenCalled();
    expect(settings.error).toContain("Backup saved, but");
    expect(settings.lastSuccessAt).toBe(now);
  });
  it("does not delete a download belonging to another extension", async () => {
    const file: BackupFile = { name: "show-tracker-auto-2026-01-01T00-00-00-000Z-abcd.json", createdAt: 1, contentHash: await hashText("file"), dataHash: "old", downloadId: 99 };
    destinations.set("downloads", { ...defaultDestination(), files: [file, ...Array.from({ length: 4 }, (_, index) => ({ ...file, name: `keep-${index}` }))] });
    downloads.set(99, { id: 99, byExtensionId: "another-extension", filename: file.name, exists: true, state: "complete" } as chrome.downloads.DownloadItem);
    await runAutomaticBackup(true);
    downloads.get(2)!.state = "complete";
    await runAutomaticBackup();
    expect(chrome.downloads.removeFile).not.toHaveBeenCalled();
    expect(settings.error).toContain("older files");
  });
  it("switches destinations without deleting files at the old destination", async () => {
    const { files } = directory();
    await runAutomaticBackup();
    await configureBackups("weekly", "downloads");
    await runAutomaticBackup();
    expect(files.size).toBe(1);
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    expect(settings.destinationId).toBe("downloads");
  });
});
