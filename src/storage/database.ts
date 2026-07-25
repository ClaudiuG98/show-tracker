import Dexie, { type EntityTable } from "dexie";
import type { ProviderEpisode, ProviderShow } from "../domain/models";

export interface CacheEntry { key: string; value: unknown; expiresAt: number }

class TrackerDatabase extends Dexie {
  providerShows!: EntityTable<ProviderShow, "id">;
  episodes!: EntityTable<ProviderEpisode, "id">;
  cache!: EntityTable<CacheEntry, "key">;

  constructor() {
    super("imdbShowsTracker");
    this.version(1).stores({
      providerShows: "id, updatedAt, externalIds.imdb, externalIds.tvdbShow",
      episodes: "id, showId, [showId+season+number]",
      cache: "key, expiresAt",
      stagedImports: "id, phase, stagedAt",
    });
    this.version(2).stores({ stagedImports: null });
  }
}

export const db = new TrackerDatabase();
export async function resetMetadataCache() {
  await db.transaction("rw", db.providerShows, db.cache, async () => {
    await db.cache.clear();
    await db.providerShows.toCollection().modify((show) => { show.metadataVersion = 0; });
  });
}

export async function clearTrackerDatabase() {
  await db.transaction("rw", db.providerShows, db.episodes, db.cache, async () => {
    await db.episodes.clear();
    await db.providerShows.clear();
    await db.cache.clear();
  });
}
