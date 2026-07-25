import { z } from "zod";
import { DEFAULT_SETTINGS, type Settings, type TrackedShow, type WatchedAction, type WatchedEpisodeState } from "../domain/models";

const KEY = "trackerState";
const LOCAL_SCHEMA_VERSION = 1;

export interface LocalState {
  schemaVersion: number;
  shows: TrackedShow[];
  progress: WatchedEpisodeState[];
  history: WatchedAction[];
  settings: Settings;
  lastSyncAt?: string;
  importCommit?: { sessionId: string; marker: "prepared" | "local_committed" | "complete" };
}

const externalIdsSchema = z.object({ imdb: z.string().optional(), tvdbShow: z.number().int().positive().optional(), tvmazeShow: z.number().int().positive().optional() });
const userStateSchema = z.enum(["watching", "caught_up", "not_started", "paused", "completed", "progress_unknown"]);
const progressSchema = z.object({ localShowId: z.string(), tvmazeEpisodeId: z.number().int().positive().optional(), tvdbEpisodeId: z.number().int().positive().optional(),
  season: z.number().int().nonnegative(), episode: z.number().int().positive(), watched: z.boolean(), watchedAt: z.string().datetime().optional(),
  source: z.enum(["tvtime", "user", "assumption", "restore"]), rewatchCount: z.number().int().nonnegative().optional() });
const snapshotSchema = z.object({ episodes: z.array(progressSchema), userState: userStateSchema });
const showSchema = z.object({ id: z.string(), externalIds: externalIdsSchema, titleSnapshot: z.string(), imdbAddedAt: z.string().optional(), tvTimeAddedAt: z.string().optional(),
  tvTimeRating: z.number().min(1).max(5).optional(), userState: userStateSchema,
  userStateSource: z.enum(["import", "user"]).optional(), userStateUpdatedAt: z.string().optional(), importSources: z.array(z.enum(["imdb", "tvtime", "manual"])),
  providerUpdatedAt: z.number().optional(), progressUpdatedAt: z.string().optional(), createdAt: z.string(), updatedAt: z.string() });
const historySchema = z.object({ id: z.string(), showId: z.string(), episodeKeys: z.array(z.string()),
  action: z.enum(["watched", "unwatched", "bulk_watched", "bulk_unwatched", "state_changed"]), before: snapshotSchema, after: snapshotSchema, occurredAt: z.string() });
export const localStateSchema = z.object({ schemaVersion: z.number().int().positive(), shows: z.array(showSchema), progress: z.array(progressSchema), history: z.array(historySchema),
  settings: z.object({ dateOnlyReleaseHour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1) }), lastSyncAt: z.string().optional(),
  importCommit: z.object({ sessionId: z.string(), marker: z.enum(["prepared", "local_committed", "complete"]) }).optional() });
export const emptyLocalState = (): LocalState => ({
  schemaVersion: LOCAL_SCHEMA_VERSION, shows: [], progress: [], history: [], settings: DEFAULT_SETTINGS,
});

const STATE_WRITE_LOCK = "imdb-shows-tracker:local-state-writer";
let fallbackWriter = Promise.resolve();

async function serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(STATE_WRITE_LOCK, { mode: "exclusive" }, operation);
  }
  const pending = fallbackWriter.then(operation, operation);
  fallbackWriter = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function readLocalState(): Promise<LocalState> {
  const value = (await chrome.storage.local.get(KEY))[KEY];
  if (!value) return emptyLocalState();
  const parsed = localStateSchema.parse(value);
  if (parsed.schemaVersion > LOCAL_SCHEMA_VERSION) throw new Error("Tracker data was created by a newer extension version.");
  return migrateLocalState(parsed as LocalState);
}

function migrateLocalState(value: LocalState): LocalState {
  return { ...emptyLocalState(), ...value, schemaVersion: LOCAL_SCHEMA_VERSION };
}

async function writeLocalStateUnlocked(value: LocalState) {
  await chrome.storage.local.set({ [KEY]: { ...value, schemaVersion: LOCAL_SCHEMA_VERSION, history: value.history.slice(0, 500) } });
}

export async function writeLocalState(value: LocalState) {
  await serializedWrite(() => writeLocalStateUnlocked(value));
}

export async function updateLocalState(mutator: (value: LocalState) => LocalState) {
  return serializedWrite(async () => {
    const current = await readLocalState();
    const next = mutator(current);
    await writeLocalStateUnlocked(next);
    return next;
  });
}
