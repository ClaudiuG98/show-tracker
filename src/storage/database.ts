import Dexie, { type EntityTable } from "dexie";
import type { ProviderEpisode, ProviderShow } from "../domain/models";

export interface CacheEntry { key: string; value: unknown; expiresAt: number }
export interface StagedImport { id: string; phase: string; payload: unknown; stagedAt: string }

class TrackerDatabase extends Dexie {
  providerShows!: EntityTable<ProviderShow, "id">;
  episodes!: EntityTable<ProviderEpisode, "id">;
  cache!: EntityTable<CacheEntry, "key">;
  stagedImports!: EntityTable<StagedImport, "id">;

  constructor() {
    super("imdbShowsTracker");
    this.version(1).stores({
      providerShows: "id, updatedAt, externalIds.imdb, externalIds.tvdbShow",
      episodes: "id, showId, [showId+season+number]",
      cache: "key, expiresAt",
      stagedImports: "id, phase, stagedAt",
    });
  }
}

export const db = new TrackerDatabase();
export async function resetMetadataCache() {
  await db.transaction("rw", db.providerShows, db.episodes, db.cache, async () => {
    await Promise.all([db.providerShows.clear(), db.episodes.clear(), db.cache.clear()]);
  });
}
