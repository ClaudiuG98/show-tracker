import type { ProviderEpisode, ProviderShow, ProviderStatus, TelevisionProvider } from "../../domain/models";
import { db, type CacheEntry } from "../../storage/database";
import { tvMazeRequest, type TvMazeRequest } from "./client";
import { tvMazeEpisodeSchema, tvMazeShowSchema } from "./schemas";

export const TVMAZE_CACHE_TTL = {
  exactLookupMs: 7 * 24 * 60 * 60 * 1_000,
  episodesMs: 6 * 60 * 60 * 1_000,
} as const;

export interface TvMazeCacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  put(entry: CacheEntry): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface TvMazeProviderOptions {
  request?: TvMazeRequest;
  cache?: TvMazeCacheStore | null;
  now?: () => number;
}

export type TvMazeProviderErrorKind = "episode_metadata" | "cache";

export class TvMazeProviderError extends Error {
  readonly name = "TvMazeProviderError";

  constructor(
    message: string,
    readonly kind: TvMazeProviderErrorKind,
    cause?: unknown,
  ) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

function status(value: string | null): ProviderStatus {
  switch (value?.toLowerCase()) {
    case "running": return "running";
    case "ended": return "ended";
    case "in development": return "in_development";
    case "to be determined": return "tbd";
    default: return "unknown";
  }
}

function approvedImageUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "static.tvmaze.com" ? url.href : undefined; }
  catch { return undefined; }
}

function normalizeShow(raw: unknown): ProviderShow {
  const show = tvMazeShowSchema.parse(raw);
  const medium = approvedImageUrl(show.image?.medium), original = approvedImageUrl(show.image?.original);
  return {
    provider: "tvmaze", id: show.id, name: show.name, status: status(show.status),
    externalIds: {
      ...(show.externals.imdb ? { imdb: show.externals.imdb } : {}),
      ...(show.externals.thetvdb ? { tvdbShow: show.externals.thetvdb } : {}), tvmazeShow: show.id,
    },
    ...(medium ? { imageUrl: medium } : {}),
    ...(medium || original ? {
      image: {
        ...(medium ? { medium } : {}),
        ...(original ? { original } : {}),
      },
    } : {}),
    ...(show.url ? { providerUrl: show.url } : {}), updatedAt: show.updated,
  };
}

function normalizeEpisodes(raw: unknown, showId: number): ProviderEpisode[] {
  if (!Array.isArray(raw)) {
    throw new TvMazeProviderError("TVMaze returned invalid episode metadata.", "episode_metadata");
  }
  try {
    return raw.map((item) => tvMazeEpisodeSchema.parse(item)).filter((item) => item.number !== null).map((episode) => ({
      id: episode.id, showId, season: episode.season, number: episode.number!,
      ...(episode.name ? { name: episode.name } : {}),
      kind: episode.season === 0 || episode.type === "special" || episode.type?.endsWith("_special") ? "special" : "regular",
      ...(episode.airdate ? { airdate: episode.airdate } : {}), ...(episode.airtime ? { airtime: episode.airtime } : {}),
      ...(episode.airstamp ? { airstamp: episode.airstamp } : {}),
    }));
  } catch (cause) {
    if (cause instanceof TvMazeProviderError) throw cause;
    throw new TvMazeProviderError("TVMaze returned invalid episode metadata.", "episode_metadata", cause);
  }
}

const imdbCacheKey = (id: string) => `tvmaze:v1:lookup:imdb:${id}`;
const tvdbCacheKey = (id: number) => `tvmaze:v1:lookup:tvdb:${id}`;
const episodesCacheKey = (showId: number) => `tvmaze:v1:episodes:${showId}`;

export class TvMazeProvider implements TelevisionProvider {
  private readonly request: TvMazeRequest;
  private readonly cache: TvMazeCacheStore | null;
  private readonly now: () => number;

  constructor(options: TvMazeProviderOptions = {}) {
    this.request = options.request ?? tvMazeRequest;
    this.cache = options.cache === undefined ? db.cache : options.cache;
    this.now = options.now ?? Date.now;
  }

  private async deleteCache(key: string) {
    if (!this.cache) return;
    try {
      await this.cache.delete(key);
    } catch (cause) {
      throw new TvMazeProviderError(`TVMaze cache cleanup failed for ${key}.`, "cache", cause);
    }
  }

  private async readCache<T>(key: string, normalize: (value: unknown) => T): Promise<T | undefined> {
    if (!this.cache) return undefined;
    let entry: CacheEntry | undefined;
    try {
      entry = await this.cache.get(key);
    } catch (cause) {
      throw new TvMazeProviderError(`TVMaze cache read failed for ${key}.`, "cache", cause);
    }
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.deleteCache(key);
      return undefined;
    }
    try {
      return normalize(entry.value);
    } catch {
      await this.deleteCache(key);
      return undefined;
    }
  }

  private async writeCache(key: string, value: unknown, ttl: number) {
    if (!this.cache) return;
    try {
      await this.cache.put({ key, value, expiresAt: this.now() + ttl });
    } catch (cause) {
      throw new TvMazeProviderError(`TVMaze cache write failed for ${key}.`, "cache", cause);
    }
  }

  private async cacheExactShow(requestedKey: string, raw: unknown, show: ProviderShow) {
    const keys = new Set([requestedKey]);
    if (show.externalIds.imdb) keys.add(imdbCacheKey(show.externalIds.imdb));
    if (show.externalIds.tvdbShow) keys.add(tvdbCacheKey(show.externalIds.tvdbShow));
    await Promise.all([...keys].map((key) => this.writeCache(key, raw, TVMAZE_CACHE_TTL.exactLookupMs)));
  }

  private async exactLookup(path: string, key: string) {
    const cached = await this.readCache(key, normalizeShow);
    if (cached) return cached;
    const raw = await this.request(path);
    if (raw === null) return null;
    const show = normalizeShow(raw);
    await this.cacheExactShow(key, raw, show);
    return show;
  }

  lookupByImdbId(id: string) {
    return this.exactLookup(`/lookup/shows?imdb=${encodeURIComponent(id)}`, imdbCacheKey(id));
  }

  lookupByTvdbId(id: number) {
    return this.exactLookup(`/lookup/shows?thetvdb=${id}`, tvdbCacheKey(id));
  }

  async getShow(id: number) {
    const raw = await this.request(`/shows/${id}`);
    return raw ? normalizeShow(raw) : null;
  }

  async getEpisodes(showId: number): Promise<ProviderEpisode[]> {
    const key = episodesCacheKey(showId);
    const cached = await this.readCache(key, (value) => normalizeEpisodes(value, showId));
    if (cached) return cached;
    const raw = await this.request(`/shows/${showId}/episodes`);
    if (raw === null) {
      throw new TvMazeProviderError(`Episode metadata could not be loaded for TVMaze show ${showId}.`, "episode_metadata");
    }
    const episodes = normalizeEpisodes(raw, showId);
    await this.writeCache(key, raw, TVMAZE_CACHE_TTL.episodesMs);
    return episodes;
  }

  async getChangedShows(since: "day" | "week" | "month" | "all") {
    const raw = await this.request(`/updates/shows${since === "all" ? "" : `?since=${since}`}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid TVMaze updates response");
    return new Map(Object.entries(raw).map(([id, timestamp]) => [Number(id), Number(timestamp)]));
  }
}
