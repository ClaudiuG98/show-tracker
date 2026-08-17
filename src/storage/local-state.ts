import { z } from "zod";
import { DEFAULT_SETTINGS, type Settings, type TrackedShow, type WatchedAction, type WatchedEpisodeState } from "../domain/models";

export const LOCAL_STATE_KEY = "trackerState";
const LOCAL_SCHEMA_VERSION = 1;

export interface LocalState {
  schemaVersion: number;
  shows: TrackedShow[];
  progress: WatchedEpisodeState[];
  history: WatchedAction[];
  settings: Settings;
  lastSyncAt?: string;
  lastSyncFailure?: { failedAt: string; message: string; retryAt?: string; attempt: number };
  importCommit?: { sessionId: string; marker: "prepared" | "local_committed" | "complete" };
  /** When the dashboard was last opened, which is what makes a release stop counting as new. */
  lastReleaseSeenAt?: string;
}

const externalIdsSchema = z.object({ imdb: z.string().optional(), tvdbShow: z.number().int().positive().optional(), tvmazeShow: z.number().int().positive().optional() });
const userStateSchema = z.enum(["watching", "caught_up", "not_started", "paused", "completed", "progress_unknown"]);
const progressSchema = z.object({ localShowId: z.string(), tvmazeEpisodeId: z.number().int().positive().optional(), tvdbEpisodeId: z.number().int().positive().optional(),
  season: z.number().int().nonnegative(), episode: z.number().int().positive(), watched: z.boolean(), watchedAt: z.string().datetime().optional(),
  source: z.enum(["tvtime", "user", "assumption", "restore", "backfill"]), rewatchCount: z.number().int().nonnegative().optional() });
const snapshotSchema = z.object({ episodes: z.array(progressSchema), userState: userStateSchema });
const showSchema = z.object({ id: z.string(), externalIds: externalIdsSchema, titleSnapshot: z.string(), sourceTitle: z.string().optional(), imdbAddedAt: z.string().optional(), tvTimeAddedAt: z.string().optional(),
  tvTimeRating: z.number().min(1).max(5).optional(), imdbRating: z.number().min(1).max(10).optional(), userState: userStateSchema,
  userStateSource: z.enum(["import", "user"]).optional(), userStateUpdatedAt: z.string().optional(), importSources: z.array(z.enum(["imdb", "tvtime", "manual"])),
  providerUpdatedAt: z.number().optional(), progressUpdatedAt: z.string().optional(), createdAt: z.string(), updatedAt: z.string() });
const historySchema = z.object({ id: z.string(), showId: z.string(), episodeKeys: z.array(z.string()),
  action: z.enum(["watched", "unwatched", "bulk_watched", "bulk_unwatched", "state_changed"]), before: snapshotSchema, after: snapshotSchema, occurredAt: z.string() });
export const localStateSchema = z.object({ schemaVersion: z.number().int().positive(), shows: z.array(showSchema), progress: z.array(progressSchema), history: z.array(historySchema),
  settings: z.object({ dateOnlyReleaseHour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1), notifications: z.boolean().default(true) }), lastSyncAt: z.string().optional(),
  lastSyncFailure: z.object({ failedAt: z.string().datetime(), message: z.string().min(1), retryAt: z.string().datetime().optional(), attempt: z.number().int().positive() }).optional(),
  importCommit: z.object({ sessionId: z.string(), marker: z.enum(["prepared", "local_committed", "complete"]) }).optional(),
  lastReleaseSeenAt: z.string().optional() });
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

// A pre-fix import bug could persist non-positive tvdbEpisodeId values, which the schema
// (correctly) rejects -- but rejecting the whole state on one bad field bricks the tracker
// with no recovery path, since every future read (including the one inside updateLocalState)
// hits the same parse failure. tvdbEpisodeId is optional and matching already falls back to
// season/episode number, so dropping just the bad field is a safe, silent repair.
function dropInvalidTvdbEpisodeIds(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { progress?: unknown }).progress)) return value;
  const record = value as { progress: unknown[] };
  return { ...record, progress: record.progress.map((entry) => {
    if (!entry || typeof entry !== "object" || !("tvdbEpisodeId" in entry)) return entry;
    const { tvdbEpisodeId, ...rest } = entry as { tvdbEpisodeId?: unknown };
    return typeof tvdbEpisodeId === "number" && Number.isInteger(tvdbEpisodeId) && tvdbEpisodeId > 0 ? entry : rest;
  }) };
}

export async function readLocalState(): Promise<LocalState> {
  const value = (await chrome.storage.local.get(LOCAL_STATE_KEY))[LOCAL_STATE_KEY];
  if (!value) return emptyLocalState();
  const parsed = localStateSchema.parse(dropInvalidTvdbEpisodeIds(value));
  if (parsed.schemaVersion > LOCAL_SCHEMA_VERSION) throw new Error("Tracker data was created by a newer extension version.");
  return migrateLocalState(parsed as LocalState);
}

function migrateLocalState(value: LocalState): LocalState {
  return { ...emptyLocalState(), ...value, schemaVersion: LOCAL_SCHEMA_VERSION };
}

async function writeLocalStateUnlocked(value: LocalState) {
  await chrome.storage.local.set({ [LOCAL_STATE_KEY]: { ...value, schemaVersion: LOCAL_SCHEMA_VERSION, history: value.history.slice(0, 500) } });
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
