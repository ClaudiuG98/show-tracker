import { getEpisodeAvailability } from "../domain/availability";
import type { ProviderEpisode, ProviderShow, Settings, WatchedEpisodeState } from "../domain/models";
import type { ImdbImportRow } from "./imdb";
import type { TvTimeShow } from "./tvtime";

export type ShowMatchKind = "matched" | "imdb_only" | "tvtime_only" | "conflict" | "unmatched";

export interface ShowMatchConflict {
  reason: string;
  imdbProvider?: ProviderShow;
  tvtimeProvider?: ProviderShow;
}

export interface ShowMatch {
  id: string;
  imdb?: ImdbImportRow;
  tvtime?: TvTimeShow;
  provider?: ProviderShow;
  kind: ShowMatchKind;
  conflict?: ShowMatchConflict;
}

/**
 * Reconciles only stable identifiers. Title matching deliberately does not occur
 * here; normalized titles are restricted to the development fixture selector.
 */
export function reconcileShows(
  imdb: ImdbImportRow[],
  tvtime: TvTimeShow[],
  imdbMatches: Map<string, ProviderShow>,
  tvdbMatches: Map<number, ProviderShow>,
  tvtimeImdbMatches: Map<string, ProviderShow> = imdbMatches,
): ShowMatch[] {
  const records: ShowMatch[] = imdb.map((row) => {
    const provider = imdbMatches.get(row.imdbId);
    return provider
      ? { id: `imdb:${row.imdbId}`, imdb: row, provider, kind: "imdb_only" }
      : { id: `imdb:${row.imdbId}`, imdb: row, kind: "unmatched" };
  });
  const byImdbId = new Map(records.flatMap((record) => record.imdb ? [[record.imdb.imdbId, record] as const] : []));
  const byProviderId = new Map(records.flatMap((record) => record.provider ? [[record.provider.id, record] as const] : []));

  for (const show of tvtime) {
    const tvdbProvider = show.tvdbShowId === undefined ? undefined : tvdbMatches.get(show.tvdbShowId);
    const imdbProvider = show.imdbId ? tvtimeImdbMatches.get(show.imdbId) : undefined;
    const stableImdbId = show.imdbId ?? tvdbProvider?.externalIds.imdb ?? imdbProvider?.externalIds.imdb;
    const linked = (stableImdbId ? byImdbId.get(stableImdbId) : undefined)
      ?? (tvdbProvider ? byProviderId.get(tvdbProvider.id) : undefined)
      ?? (imdbProvider ? byProviderId.get(imdbProvider.id) : undefined);

    const exactProvidersDiffer = Boolean(tvdbProvider && imdbProvider && tvdbProvider.id !== imdbProvider.id);
    const resolved = tvdbProvider ?? imdbProvider;
    const sourceProvidersDiffer = Boolean(linked?.provider && resolved && linked.provider.id !== resolved.id);
    if (exactProvidersDiffer || sourceProvidersDiffer || linked?.tvtime) {
      const conflict: ShowMatch = linked ?? { id: `tvtime:${show.uuid}`, kind: "conflict" };
      const imdbConflictProvider = linked?.provider ?? imdbProvider;
      const tvtimeConflictProvider = tvdbProvider ?? resolved;
      conflict.tvtime = show;
      conflict.kind = "conflict";
      conflict.conflict = {
        reason: linked?.tvtime
          ? "Multiple TV Time records resolve to the same source record."
          : "Exact source identifiers resolve to different TVMaze shows.",
        ...(imdbConflictProvider ? { imdbProvider: imdbConflictProvider } : {}),
        ...(tvtimeConflictProvider ? { tvtimeProvider: tvtimeConflictProvider } : {}),
      };
      if (!linked) records.push(conflict);
      continue;
    }

    if (linked) {
      linked.tvtime = show;
      if (resolved) linked.provider = resolved;
      linked.kind = linked.provider ? "matched" : "unmatched";
      if (linked.provider) byProviderId.set(linked.provider.id, linked);
      continue;
    }

    if (resolved) {
      const record: ShowMatch = { id: `tvtime:${show.uuid}`, tvtime: show, provider: resolved, kind: "tvtime_only" };
      records.push(record);
      byProviderId.set(resolved.id, record);
    } else {
      records.push({ id: `tvtime:${show.uuid}`, tvtime: show, kind: "unmatched" });
    }
  }
  return records;
}

export interface UnresolvedTvTimeEpisode {
  show: string;
  tvdbEpisodeId: number;
  season: number;
  episode: number;
  name: string;
  reason: string;
}

export interface EpisodeNumberingConflict {
  show: string;
  episode: string;
  sourceNumber: string;
  providerNumber: string;
}

export type ImportedEpisodeState = Omit<WatchedEpisodeState, "localShowId">;

export interface TvTimeProgressMapping {
  states: ImportedEpisodeState[];
  watchedMapped: number;
  explicitUnwatchedMapped: number;
  futureUnwatchedExcluded: number;
  specialsExcluded: number;
  unresolved: UnresolvedTvTimeEpisode[];
  numberingConflicts: EpisodeNumberingConflict[];
}

export interface ProgressMappingClock {
  now: Date;
  settings: Settings;
}

export function mapTvTimeProgressDetailed(
  tvtime: TvTimeShow,
  providerEpisodes: ProviderEpisode[],
  clock?: ProgressMappingClock,
): TvTimeProgressMapping {
  const regular = providerEpisodes.filter((episode) => episode.kind === "regular");
  const byTvdb = new Map(regular.flatMap((episode) => episode.tvdbEpisodeId === undefined
    ? []
    : [[episode.tvdbEpisodeId, episode] as const]));
  const byNumber = new Map(regular.map((episode) => [`${episode.season}:${episode.number}`, episode]));
  const states: ImportedEpisodeState[] = [];
  const unresolved: UnresolvedTvTimeEpisode[] = [];
  const numberingConflicts: EpisodeNumberingConflict[] = [];
  let watchedMapped = 0;
  let explicitUnwatchedMapped = 0;
  let futureUnwatchedExcluded = 0;
  let specialsExcluded = 0;

  for (const episode of tvtime.episodes) {
    if (episode.special) {
      specialsExcluded++;
      continue;
    }
    const externalMatch = byTvdb.get(episode.tvdbEpisodeId);
    const provider = externalMatch ?? byNumber.get(`${episode.season}:${episode.number}`);
    if (!provider) {
      unresolved.push({
        show: tvtime.title,
        tvdbEpisodeId: episode.tvdbEpisodeId,
        season: episode.season,
        episode: episode.number,
        name: episode.name,
        reason: "No regular TVMaze episode has a compatible external ID or season/episode number.",
      });
      continue;
    }
    if (externalMatch && (provider.season !== episode.season || provider.number !== episode.number)) {
      numberingConflicts.push({
        show: tvtime.title,
        episode: episode.name,
        sourceNumber: `S${episode.season}E${episode.number}`,
        providerNumber: `S${provider.season}E${provider.number}`,
      });
    }
    states.push({
      tvmazeEpisodeId: provider.id,
      tvdbEpisodeId: episode.tvdbEpisodeId,
      season: provider.season,
      episode: provider.number,
      watched: episode.watched,
      ...(episode.watched && episode.watchedAt ? { watchedAt: episode.watchedAt } : {}),
      source: "tvtime",
      rewatchCount: episode.rewatchCount,
    });
    if (episode.watched) watchedMapped++;
    else {
      explicitUnwatchedMapped++;
      if (clock && getEpisodeAvailability(provider, clock.now, clock.settings.timezone, clock.settings.dateOnlyReleaseHour) === "future") {
        futureUnwatchedExcluded++;
      }
    }
  }
  return { states, watchedMapped, explicitUnwatchedMapped, futureUnwatchedExcluded, specialsExcluded, unresolved, numberingConflicts };
}

/** Backwards-compatible convenience wrapper for callers that need localized states. */
export function mapTvTimeProgress(
  localShowId: string,
  tvtime: TvTimeShow,
  providerEpisodes: ProviderEpisode[],
): WatchedEpisodeState[] {
  return mapTvTimeProgressDetailed(tvtime, providerEpisodes).states.map((state) => ({ localShowId, ...state }));
}
