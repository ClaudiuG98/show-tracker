import { z } from "zod";
import { localStateSchema, type LocalState } from "../storage/local-state";

const BACKUP_VERSION = 1;
export interface TrackerBackup { format: "show-tracker"; version: number; exportedAt: string; state: LocalState }
export function createBackup(state: LocalState): TrackerBackup { return { format: "show-tracker", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), state }; }
const backupEnvelope = z.object({ format: z.union([z.literal("show-tracker"), z.literal("imdb-shows-tracker")]), version: z.literal(BACKUP_VERSION), exportedAt: z.string().datetime(), state: localStateSchema });
export function parseBackup(value: string): TrackerBackup {
  const backup = backupEnvelope.parse(JSON.parse(value));
  return { ...backup, format: "show-tracker" } as TrackerBackup;
}
