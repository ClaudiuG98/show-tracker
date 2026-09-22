import Dexie, { type EntityTable } from "dexie";

export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";
export interface BackupSettings {
  id: "settings";
  frequency: BackupFrequency;
  destinationId: string;
  nextCheckAt: number;
  lastSuccessAt?: number;
  message?: string;
  error?: string;
}
export interface BackupFile {
  name: string;
  createdAt: number;
  dataHash: string;
  contentHash: string;
  downloadId?: number;
}
export interface BackupDirectory extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
}
export interface BackupDestination {
  id: string;
  name: string;
  handle?: BackupDirectory;
  files: BackupFile[];
  pending?: BackupFile;
}

class BackupDatabase extends Dexie {
  settings!: EntityTable<BackupSettings, "id">;
  destinations!: EntityTable<BackupDestination, "id">;
  constructor() {
    super("showTrackerBackups");
    this.version(1).stores({ settings: "id", destinations: "id" });
  }
}

export const backupDb = new BackupDatabase();
export const defaultBackupSettings = (): BackupSettings => ({ id: "settings", frequency: "off", destinationId: "downloads", nextCheckAt: 0 });
export const defaultDestination = (): BackupDestination => ({ id: "downloads", name: "Downloads/Show Tracker Backups", files: [] });
export const readBackupSettings = async () => (await backupDb.settings.get("settings")) ?? defaultBackupSettings();
export const readBackupDestination = async (id: string) => (await backupDb.destinations.get(id)) ?? (id === "downloads" ? defaultDestination() : undefined);

let pendingLock = Promise.resolve();
export async function withBackupLock<Result>(operation: () => Promise<Result>): Promise<Result> {
  if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request("show-tracker:automatic-backup", operation);
  const pending = pendingLock.then(operation, operation);
  pendingLock = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function configureBackups(frequency: BackupFrequency, destination?: BackupDirectory | "downloads") {
  return withBackupLock(async () => {
    const settings = await readBackupSettings();
    if (destination === "downloads") settings.destinationId = "downloads";
    else if (destination) {
      const known = await backupDb.destinations.toArray();
      let existing: BackupDestination | undefined;
      for (const candidate of known) {
        if (candidate.handle && await candidate.handle.isSameEntry(destination)) { existing = candidate; break; }
      }
      const selected = existing ?? { id: crypto.randomUUID(), name: destination.name, files: [] };
      selected.handle = destination;
      await backupDb.destinations.put(selected);
      settings.destinationId = selected.id;
    }
    settings.frequency = frequency;
    settings.nextCheckAt = 0;
    delete settings.error;
    delete settings.message;
    await backupDb.settings.put(settings);
  });
}
