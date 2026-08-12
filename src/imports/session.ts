import type { ProviderEpisode, ProviderShow, Settings, TelevisionProvider } from "../domain/models";
import type { ImdbImportRow, ImdbParseResult } from "./imdb";
import {
  fillProgressCoverage,
  mapTvTimeProgressDetailed,
  reconcileShows,
  type EpisodeNumberingConflict,
  type ShowMatch,
  type TvTimeProgressMapping,
  type UnresolvedTvTimeEpisode,
} from "./reconcile";
import type { TvTimeParseResult, TvTimeShow } from "./tvtime";
import { expandSplitTvTimeShows } from "./split-show-routes";

export type ImportStage =
  | "select_files"
  | "validate_parse"
  | "analyze_sources"
  | "resolve_ids"
  | "download_episodes"
  | "reconcile"
  | "report"
  | "progress_decisions"
  | "final_preview"
  | "commit"
  | "complete";

export interface ImportStageProgress {
  stage: ImportStage;
  completed: number;
  total: number;
  message: string;
}

interface ImportSourceCounts {
  imdbRowsParsed: number;
  tvTimeShowsParsed: number;
  tvTimeEpisodesParsed: number;
}

export interface SelectedImportSources {
  imdbRows: ImdbImportRow[];
  tvTimeShows: TvTimeShow[];
  counts: ImportSourceCounts;
}

type ImportProviderErrorCode =
  | "imdb_lookup_failed"
  | "tvdb_lookup_failed"
  | "rate_limit"
  | "episode_metadata_failed"
  | "provider_network_failed";

export interface ImportProviderError {
  code: ImportProviderErrorCode;
  stage: "resolve_ids" | "download_episodes";
  recordName: string;
  message: string;
  retryable: boolean;
}

export interface ImportShowRecord extends ShowMatch {
  episodes: ProviderEpisode[];
  progress?: TvTimeProgressMapping;
  backfilled?: number;
}

export interface BackfilledShow {
  show: string;
  count: number;
}

interface ImportReport {
  imdbRowsParsed: number;
  tvTimeShowsParsed: number;
  exactImdbMatches: number;
  exactTvdbMatches: number;
  successfullyMerged: number;
  imdbOnly: number;
  tvTimeOnly: number;
  conflicts: number;
  unmatchedShows: number;
  tvTimeEpisodesParsed: number;
  watchedEpisodesMapped: number;
  explicitUnwatchedEpisodesMapped: number;
  futureEpisodesExcludedFromBacklog: number;
  specialsExcluded: number;
  unresolvedEpisodes: number;
  episodesBackfilled: number;
  showsRequiringProgressSetup: number;
  providerNetworkErrors: number;
  conflictNames: string[];
  unmatchedNames: string[];
  tvTimeOnlyNames: string[];
  unresolvedEpisodeRecords: UnresolvedTvTimeEpisode[];
  numberingConflicts: EpisodeNumberingConflict[];
  backfilledShows: BackfilledShow[];
  providerErrors: ImportProviderError[];
}

export interface ImportAnalysis {
  sessionId: string;
  importedAt: string;
  counts: ImportSourceCounts;
  records: ImportShowRecord[];
  providerShows: ProviderShow[];
  episodesByShow: Map<number, ProviderEpisode[]>;
  report: ImportReport;
}

export interface AnalyzeImportOptions {
  selected: SelectedImportSources;
  provider: TelevisionProvider;
  settings: Settings;
  now?: Date;
  onProgress?: (progress: ImportStageProgress) => void;
}

export function selectFullImportSources(
  imdb: ImdbParseResult | undefined,
  tvtime: TvTimeParseResult | undefined,
): SelectedImportSources {
  const imdbRows = imdb?.rows ?? [];
  const tvTimeShows = tvtime?.shows ?? [];
  return {
    imdbRows,
    tvTimeShows,
    counts: {
      imdbRowsParsed: imdb?.totalRows ?? 0,
      tvTimeShowsParsed: tvTimeShows.length,
      tvTimeEpisodesParsed: tvTimeShows.reduce((total, show) => total + show.episodes.length, 0),
    },
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Unknown provider error";
}

function providerError(
  error: unknown,
  fallback: Exclude<ImportProviderErrorCode, "rate_limit">,
  stage: ImportProviderError["stage"],
  recordName: string,
): ImportProviderError {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const isRateLimit = code === "rate_limit" || /\b429\b|rate limit/i.test(message(error));
  return {
    code: isRateLimit ? "rate_limit" : fallback,
    stage,
    recordName,
    message: isRateLimit ? `TVMaze rate limit reached: ${message(error)}` : message(error),
    retryable: true,
  };
}

export async function analyzeImport(options: AnalyzeImportOptions): Promise<ImportAnalysis> {
  const { selected, provider, settings, onProgress } = options;
  const tvTimeShows = expandSplitTvTimeShows(selected.tvTimeShows);
  const now = options.now ?? new Date();
  const imdbResults = new Map<string, ProviderShow | null>();
  const tvdbResults = new Map<number, ProviderShow | null>();
  const tvtimeImdbResults = new Map<string, ProviderShow | null>();
  const directTvmazeResults = new Map<string, ProviderShow | null>();
  const errors: ImportProviderError[] = [];

  const tvTimeImdbIds = new Set(tvTimeShows.flatMap((show) => show.imdbId ? [show.imdbId] : []));
  const lookupTotal = selected.imdbRows.length
    + tvTimeShows.filter((show) => show.tvdbShowId !== undefined && show.providerShowId === undefined).length
    + tvTimeShows.filter((show) => show.providerShowId !== undefined).length
    + [...tvTimeImdbIds].filter((id) => !selected.imdbRows.some((row) => row.imdbId === id)).length;
  let lookupDone = 0;
  onProgress?.({ stage: "resolve_ids", completed: 0, total: lookupTotal, message: "Resolving exact IMDb and TVDB identifiers." });

  await Promise.all(selected.imdbRows.map(async (row) => {
    try {
      imdbResults.set(row.imdbId, await provider.lookupByImdbId(row.imdbId));
    } catch (error) {
      errors.push(providerError(error, "imdb_lookup_failed", "resolve_ids", row.title));
    } finally {
      onProgress?.({ stage: "resolve_ids", completed: ++lookupDone, total: lookupTotal, message: `Resolved ${lookupDone} of ${lookupTotal} identifiers.` });
    }
  }));

  await Promise.all(tvTimeShows.flatMap((show) => show.tvdbShowId === undefined || show.providerShowId !== undefined ? [] : [
    (async () => {
      try {
        tvdbResults.set(show.tvdbShowId!, await provider.lookupByTvdbId(show.tvdbShowId!));
      } catch (error) {
        errors.push(providerError(error, "tvdb_lookup_failed", "resolve_ids", show.title));
      } finally {
        onProgress?.({ stage: "resolve_ids", completed: ++lookupDone, total: lookupTotal, message: `Resolved ${lookupDone} of ${lookupTotal} identifiers.` });
      }
    })(),
  ]));

  await Promise.all(tvTimeShows.flatMap((show) => show.providerShowId === undefined ? [] : [
    (async () => {
      try { directTvmazeResults.set(show.uuid, await provider.getShow(show.providerShowId!)); }
      catch (error) { errors.push(providerError(error, "provider_network_failed", "resolve_ids", show.title)); }
      finally { onProgress?.({ stage: "resolve_ids", completed: ++lookupDone, total: lookupTotal, message: `Resolved ${lookupDone} of ${lookupTotal} identifiers.` }); }
    })(),
  ]));

  await Promise.all([...tvTimeImdbIds].flatMap((id) => imdbResults.has(id) ? [] : [
    (async () => {
      const show = tvTimeShows.find((candidate) => candidate.imdbId === id);
      try {
        tvtimeImdbResults.set(id, await provider.lookupByImdbId(id));
      } catch (error) {
        errors.push(providerError(error, "imdb_lookup_failed", "resolve_ids", show?.title ?? id));
      } finally {
        onProgress?.({ stage: "resolve_ids", completed: ++lookupDone, total: lookupTotal, message: `Resolved ${lookupDone} of ${lookupTotal} identifiers.` });
      }
    })(),
  ]));
  for (const id of tvTimeImdbIds) {
    if (imdbResults.has(id)) tvtimeImdbResults.set(id, imdbResults.get(id) ?? null);
  }

  const successfulImdb = new Map([...imdbResults].flatMap(([id, show]) => show ? [[id, show] as const] : []));
  const successfulTvdb = new Map([...tvdbResults].flatMap(([id, show]) => show ? [[id, show] as const] : []));
  const successfulTvtimeImdb = new Map([...tvtimeImdbResults].flatMap(([id, show]) => show ? [[id, show] as const] : []));
  const successfulDirect = new Map([...directTvmazeResults].flatMap(([id, show]) => show ? [[id, show] as const] : []));
  const reconciled = reconcileShows(selected.imdbRows, tvTimeShows, successfulImdb, successfulTvdb, successfulTvtimeImdb, successfulDirect);
  const providers = new Map<number, ProviderShow>();
  for (const record of reconciled) {
    if (record.provider) providers.set(record.provider.id, record.provider);
    if (record.conflict?.imdbProvider) providers.set(record.conflict.imdbProvider.id, record.conflict.imdbProvider);
    if (record.conflict?.tvtimeProvider) providers.set(record.conflict.tvtimeProvider.id, record.conflict.tvtimeProvider);
  }

  const requiredProviderIds = new Set(reconciled.flatMap((record) =>
    record.kind !== "conflict" && record.provider ? [record.provider.id] : []));
  const episodesByShow = new Map<number, ProviderEpisode[]>();
  let episodeDone = 0;
  onProgress?.({ stage: "download_episodes", completed: 0, total: requiredProviderIds.size, message: "Downloading required TVMaze episode metadata." });
  await Promise.all([...requiredProviderIds].map(async (showId) => {
    const metadata = providers.get(showId);
    try {
      episodesByShow.set(showId, await provider.getEpisodes(showId));
    } catch (error) {
      errors.push(providerError(error, "episode_metadata_failed", "download_episodes", metadata?.name ?? `TVMaze ${showId}`));
    } finally {
      onProgress?.({ stage: "download_episodes", completed: ++episodeDone, total: requiredProviderIds.size, message: `Loaded episodes for ${episodeDone} of ${requiredProviderIds.size} shows.` });
    }
  }));

  onProgress?.({ stage: "reconcile", completed: 0, total: reconciled.length, message: "Reconciling source records and episode progress." });
  let records: ImportShowRecord[] = reconciled.map((record, index) => {
    const episodes = record.provider ? episodesByShow.get(record.provider.id) ?? [] : [];
    const progress = record.tvtime && record.provider && episodesByShow.has(record.provider.id) && record.kind !== "conflict"
      ? mapTvTimeProgressDetailed(record.tvtime, episodes, { now, settings })
      : undefined;
    onProgress?.({ stage: "reconcile", completed: index + 1, total: reconciled.length, message: `Reconciled ${index + 1} of ${reconciled.length} records.` });
    return { ...record, episodes, ...(progress ? { progress } : {}) };
  });

  if (provider.getAlternateEpisodeMappings) {
    records = await Promise.all(records.map(async (record) => {
      if (!record.provider || !record.tvtime || !record.progress?.unresolved.length) return record;
      try {
        const alternates = await provider.getAlternateEpisodeMappings!(record.provider.id);
        if (alternates.length === 0) return record;
        const remapped = mapTvTimeProgressDetailed(record.tvtime, record.episodes, { now, settings }, alternates);
        return remapped.unresolved.length < record.progress.unresolved.length ? { ...record, progress: remapped } : record;
      } catch { return record; }
    }));
  }

  // Runs last so the fill sees the best mapping available, including anything the alternate
  // episode lists rescued above.
  records = records.map((record) => {
    if (!record.tvtime || !record.progress) return record;
    const { states, backfilled } = fillProgressCoverage(record.tvtime, record.episodes, record.progress.states, { now, settings });
    return backfilled === 0 ? record : { ...record, progress: { ...record.progress, states }, backfilled };
  });

  const progressReports = records.flatMap((record) => record.progress ? [record.progress] : []);
  const report: ImportReport = {
    imdbRowsParsed: selected.counts.imdbRowsParsed,
    tvTimeShowsParsed: selected.counts.tvTimeShowsParsed,
    exactImdbMatches: new Set([
      ...[...imdbResults].flatMap(([id, show]) => show ? [id] : []),
      ...[...tvtimeImdbResults].flatMap(([id, show]) => show ? [id] : []),
    ]).size,
    exactTvdbMatches: [...tvdbResults.values()].filter(Boolean).length,
    successfullyMerged: records.filter((record) => record.kind === "matched").length,
    imdbOnly: records.filter((record) => record.kind === "imdb_only").length,
    tvTimeOnly: records.filter((record) => record.kind === "tvtime_only").length,
    conflicts: records.filter((record) => record.kind === "conflict").length,
    unmatchedShows: records.filter((record) => record.kind === "unmatched").length,
    tvTimeEpisodesParsed: selected.counts.tvTimeEpisodesParsed,
    watchedEpisodesMapped: progressReports.reduce((total, progress) => total + progress.watchedMapped, 0),
    explicitUnwatchedEpisodesMapped: progressReports.reduce((total, progress) => total + progress.explicitUnwatchedMapped, 0),
    futureEpisodesExcludedFromBacklog: progressReports.reduce((total, progress) => total + progress.futureUnwatchedExcluded, 0),
    specialsExcluded: progressReports.reduce((total, progress) => total + progress.specialsExcluded, 0),
    unresolvedEpisodes: progressReports.reduce((total, progress) => total + progress.unresolved.length, 0),
    episodesBackfilled: records.reduce((total, record) => total + (record.backfilled ?? 0), 0),
    showsRequiringProgressSetup: records.filter((record) => record.kind === "imdb_only").length,
    providerNetworkErrors: errors.length,
    conflictNames: records.filter((record) => record.kind === "conflict").map((record) => record.imdb?.title ?? record.tvtime?.title ?? record.id),
    unmatchedNames: records.filter((record) => record.kind === "unmatched").map((record) => record.imdb?.title ?? record.tvtime?.title ?? record.id),
    tvTimeOnlyNames: records.filter((record) => record.kind === "tvtime_only").map((record) => record.tvtime?.title ?? record.provider?.name ?? record.id),
    unresolvedEpisodeRecords: progressReports.flatMap((progress) => progress.unresolved),
    numberingConflicts: progressReports.flatMap((progress) => progress.numberingConflicts),
    backfilledShows: records.flatMap((record) => record.backfilled
      ? [{ show: record.tvtime?.title ?? record.provider?.name ?? record.id, count: record.backfilled }]
      : []).sort((a, b) => b.count - a.count),
    providerErrors: errors,
  };
  return {
    sessionId: crypto.randomUUID(),
    importedAt: now.toISOString(),
    counts: selected.counts,
    records,
    providerShows: [...providers.values()],
    episodesByShow,
    report,
  };
}
