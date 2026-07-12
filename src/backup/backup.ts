import { z } from "zod";
import { localStateSchema, type LocalState } from "../storage/local-state";

export const BACKUP_VERSION = 1;
export interface TrackerBackup { format: "imdb-shows-tracker"; version: number; exportedAt: string; state: LocalState }
export function createBackup(state: LocalState): TrackerBackup { return { format: "imdb-shows-tracker", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), state }; }
const backupEnvelope = z.object({ format: z.literal("imdb-shows-tracker"), version: z.literal(BACKUP_VERSION), exportedAt: z.string().datetime(), state: localStateSchema });
export function parseBackup(value: string) { return backupEnvelope.parse(JSON.parse(value)) as TrackerBackup; }
