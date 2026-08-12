import { unzipSync } from "fflate";
import Papa from "papaparse";
import { z } from "zod";

const ZIP_LIMITS = { compressed: 25 * 1024 * 1024, expanded: 100 * 1024 * 1024, entries: 10_000, entry: 20 * 1024 * 1024 };
const showIdSchema = z.object({ tvdb: z.number().int().positive().nullable().optional(), imdb: z.string().nullable().optional() });
const episodeIdSchema = z.object({ tvdb: z.number().int().positive(), imdb: z.string().nullable().optional() });
const episodeSchema = z.object({ id: episodeIdSchema, number: z.number().int().positive(), name: z.string(), special: z.boolean(), is_watched: z.boolean(),
  watched_at: z.string().datetime({ offset: true }).nullable(), rewatch_count: z.number().int().nonnegative(), watched_count: z.number().int().nonnegative() });
const seasonSchema = z.object({ number: z.number().int().nonnegative(), is_specials: z.boolean(), episodes: z.array(episodeSchema).max(20_000) });
const showSchema = z.object({ uuid: z.string(), id: showIdSchema, created_at: z.string().datetime({ offset: true }), title: z.string(),
  status: z.enum(["up_to_date", "continuing", "not_started_yet", "stopped"]), is_favorite: z.boolean(),
  _noEpisodeData: z.boolean(), seasons: z.array(seasonSchema).max(1_000) });

interface TvTimeEpisode {
  tvdbEpisodeId: number; season: number; number: number; name: string; special: boolean;
  watched: boolean; watchedAt?: string; rewatchCount: number;
}
/**
 * How to treat provider episodes the export never mentions. Watched-only exports (the GDPR
 * CSV, Refract) emit a row only for episodes you watched, so an absent episode cannot be read
 * as "unwatched" -- it is simply unknown, and would otherwise become permanent backlog.
 *
 * - `explicit`: the export states watched and unwatched per episode; trust it, fill nothing.
 * - `watched_through`: fill every aired episode up to the latest watched one, never past it.
 * - `all_aired`: the show is finished or caught up; fill every aired episode.
 */
export type TvTimeCoverage = "explicit" | "watched_through" | "all_aired";

export interface TvTimeShow {
  uuid: string; tvdbShowId?: number; imdbId?: string; title: string; createdAt: string;
  providerShowId?: number;
  rating?: number;
  coverage?: TvTimeCoverage;
  status: "up_to_date" | "continuing" | "not_started_yet" | "stopped"; episodes: TvTimeEpisode[];
}
export interface TvTimeParseResult { shows: TvTimeShow[]; specials: number; specialFlagMismatches: number; ignoredEntries: string[] }

export type TvTimeImportErrorCode = "zip_validation" | "schema" | "no_shows";
export class TvTimeImportError extends Error {
  constructor(public readonly code: TvTimeImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TvTimeImportError";
  }
}

type CsvRow = Record<string, string | undefined>;

function positiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function flag(value: string | undefined) {
  return ["1", "true", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function timestamp(value: string | undefined) {
  const raw = value?.trim();
  if (!raw) return undefined;
  let date: Date;
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const millis = numeric >= 1e15 ? numeric / 1_000 : numeric >= 1e12 ? numeric : numeric * 1_000;
    date = new Date(millis);
  } else {
    date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw);
  }
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function csv(files: Record<string, Uint8Array>, name: string): CsvRow[] {
  const bytes = files[name];
  if (!bytes) return [];
  const result = Papa.parse<CsvRow>(new TextDecoder().decode(bytes), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim().toLowerCase(),
  });
  if (result.errors.length > 0) throw new TvTimeImportError("schema", `TV Time GDPR schema could not be parsed: ${name}.`);
  return result.data;
}

function entryNamed(names: string[], basename: string) {
  return names.find((name) => name.split("/").at(-1)?.toLowerCase() === basename);
}

function parseJsonExport(files: Record<string, Uint8Array>, names: string[], seriesName: string): TvTimeParseResult {
  let parsed: z.infer<typeof showSchema>[];
  try {
    const raw = JSON.parse(new TextDecoder().decode(files[seriesName]));
    parsed = z.array(showSchema).max(20_000).parse(raw);
  } catch (cause) {
    throw new TvTimeImportError("schema", "TV Time schema could not be parsed.", { cause });
  }
  if (parsed.length === 0) throw new TvTimeImportError("no_shows", "No TV Time shows were found.");
  let specials = 0, specialFlagMismatches = 0;
  const shows = parsed.map((show): TvTimeShow => ({ uuid: show.uuid, ...(show.id.tvdb ? { tvdbShowId: show.id.tvdb } : {}),
    ...(show.id.imdb && /^tt\d+$/.test(show.id.imdb) ? { imdbId: show.id.imdb } : {}), title: show.title,
    createdAt: show.created_at, status: show.status, episodes: show.seasons.flatMap((season) => season.episodes.map((episode) => {
      if (season.is_specials !== episode.special) specialFlagMismatches++;
      const special = season.is_specials || episode.special;
      if (special) specials++;
      return { tvdbEpisodeId: episode.id.tvdb, season: season.number, number: episode.number, name: episode.name, special,
        watched: episode.is_watched, ...(episode.watched_at ? { watchedAt: episode.watched_at } : {}), rewatchCount: episode.rewatch_count };
    })) }));
  return { shows, specials, specialFlagMismatches, ignoredEntries: names.filter((name) => name !== seriesName) };
}

function parseGdprExport(files: Record<string, Uint8Array>, names: string[], followedName: string): TvTimeParseResult {
  const userDataName = entryNamed(names, "user_tv_show_data.csv");
  const ratingName = entryNamed(names, "tv_show_rate.csv");
  const trackingNames = [entryNamed(names, "tracking-prod-records-v2.csv"), entryNamed(names, "tracking-prod-records.csv")]
    .filter((name): name is string => Boolean(name));
  const followed = csv(files, followedName);
  if (!followed.every((row) => row.tv_show_id !== undefined && row.tv_show_name !== undefined)) {
    throw new TvTimeImportError("schema", "TV Time GDPR schema could not be parsed: followed_tv_show.csv.");
  }

  const userData = userDataName ? csv(files, userDataName) : [];
  const seenCounts = new Map(userData.flatMap((row) => {
    const showId = positiveInteger(row.tv_show_id), count = nonnegativeInteger(row.nb_episodes_seen);
    return showId !== undefined && count !== undefined ? [[showId, count] as const] : [];
  }));
  // followed_tv_show.csv only lists shows still being followed, so a show dropped from that list
  // keeps its watch history with no title to attach it to. Both the per-show summary and the
  // tracking rows name the show, which is enough to rebuild it.
  const knownTitles = new Map<number, string>();
  const rememberTitle = (showId: number | undefined, title: string | undefined) => {
    if (showId !== undefined && title?.trim() && !knownTitles.has(showId)) knownTitles.set(showId, title.trim());
  };
  for (const row of userData) rememberTitle(positiveInteger(row.tv_show_id), row.tv_show_name);
  const ratings = new Map((ratingName ? csv(files, ratingName) : []).flatMap((row) => {
    const showId = positiveInteger(row.tv_show_id), rating = Number(row.rating);
    return showId !== undefined && Number.isFinite(rating) && rating >= 1 && rating <= 5 ? [[showId, rating] as const] : [];
  }));
  const episodesByShow = new Map<number, Map<number, TvTimeEpisode>>();

  for (const trackingName of trackingNames) {
    const isV2 = trackingName.toLowerCase().endsWith("records-v2.csv");
    for (const row of csv(files, trackingName)) {
      const showId = positiveInteger(isV2 ? row.s_id : row.series_id);
      const episodeId = positiveInteger(isV2 ? row.ep_id : row.episode_id);
      // The v2 GDPR export carries the source season/episode pair in s_no/ep_no.
      // season_number/episode_number is a derived display order for some shows
      // (for example, later Money Heist parts are folded into earlier seasons).
      const season = nonnegativeInteger(isV2 ? row.s_no : row.season_number)
        ?? nonnegativeInteger(isV2 ? row.season_number : row.s_no);
      const number = positiveInteger(isV2 ? row.ep_no : row.episode_number)
        ?? positiveInteger(isV2 ? row.episode_number : row.ep_no);
      rememberTitle(showId, row.series_name);
      if (showId === undefined || episodeId === undefined || season === undefined || number === undefined) continue;
      const watchedAt = timestamp(row.watch_date) ?? timestamp(row.updated_at) ?? timestamp(row.created_at);
      const watchCount = nonnegativeInteger(row.rewatch_count) ?? nonnegativeInteger(row.ep_watch_count) ?? nonnegativeInteger(row.watch_count) ?? 1;
      const episode: TvTimeEpisode = {
        tvdbEpisodeId: episodeId,
        season,
        number,
        name: row.episode_name?.trim() || `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
        special: season === 0 || flag(row.is_special),
        watched: true,
        ...(watchedAt ? { watchedAt } : {}),
        rewatchCount: Math.max(0, watchCount - (row.rewatch_count === undefined ? 1 : 0)),
      };
      const episodes = episodesByShow.get(showId) ?? new Map<number, TvTimeEpisode>();
      const previous = episodes.get(episodeId);
      if (!previous || (episode.watchedAt ?? "") > (previous.watchedAt ?? "")) episodes.set(episodeId, episode);
      else if (episode.rewatchCount > previous.rewatchCount) episodes.set(episodeId, { ...previous, rewatchCount: episode.rewatchCount });
      episodesByShow.set(showId, episodes);
    }
  }

  const shows = followed.flatMap((row): TvTimeShow[] => {
    const showId = positiveInteger(row.tv_show_id), title = row.tv_show_name?.trim();
    if (showId === undefined || !title) return [];
    const createdAt = timestamp(row.created_at) ?? timestamp(row.updated_at) ?? new Date(0).toISOString();
    const stopped = flag(row.archived) || (row.active !== undefined && !flag(row.active));
    // The GDPR summary can lag behind the detailed tracking records. Never let
    // a stale zero override episodes that are explicitly present as watched.
    const watchedCount = Math.max(seenCounts.get(showId) ?? 0, episodesByShow.get(showId)?.size ?? 0);
    const rating = ratings.get(showId);
    return [{
      uuid: `gdpr-tvdb-${showId}`,
      tvdbShowId: showId,
      title,
      createdAt,
      ...(rating !== undefined ? { rating } : {}),
      // The GDPR export only records watch events, so gaps below the latest watched episode
      // are missing data rather than deliberate unwatched states.
      coverage: "watched_through",
      status: stopped ? "stopped" : watchedCount === 0 ? "not_started_yet" : "continuing",
      episodes: [...(episodesByShow.get(showId)?.values() ?? [])].sort((a, b) => a.season - b.season || a.number - b.number || a.tvdbEpisodeId - b.tvdbEpisodeId),
    }];
  });

  // Anything with watch history that the followed list never accounted for. These are treated as
  // ordinary watched shows rather than stopped ones: no longer appearing in that list says
  // nothing about whether the show is finished, and calling them stopped would hide them from
  // the Watch List entirely.
  const accountedFor = new Set(shows.map((show) => show.tvdbShowId));
  for (const [showId, episodes] of episodesByShow) {
    if (accountedFor.has(showId) || episodes.size === 0) continue;
    const title = knownTitles.get(showId);
    if (!title) continue;
    const ordered = [...episodes.values()].sort((a, b) => a.season - b.season || a.number - b.number || a.tvdbEpisodeId - b.tvdbEpisodeId);
    const rating = ratings.get(showId);
    shows.push({
      uuid: `gdpr-tvdb-${showId}`,
      tvdbShowId: showId,
      title,
      createdAt: ordered.flatMap((episode) => episode.watchedAt ? [episode.watchedAt] : []).sort()[0] ?? new Date(0).toISOString(),
      ...(rating !== undefined ? { rating } : {}),
      coverage: "watched_through",
      status: "continuing",
      episodes: ordered,
    });
  }
  if (shows.length === 0) throw new TvTimeImportError("no_shows", "No TV Time shows were found.");
  const used = new Set([followedName, ...(userDataName ? [userDataName] : []), ...(ratingName ? [ratingName] : []), ...trackingNames]);
  return {
    shows,
    specials: shows.flatMap((show) => show.episodes).filter((episode) => episode.special).length,
    specialFlagMismatches: 0,
    ignoredEntries: names.filter((name) => !used.has(name)),
  };
}

export function parseTvTimeZip(bytes: Uint8Array): TvTimeParseResult {
  if (bytes.byteLength > ZIP_LIMITS.compressed) throw new TvTimeImportError("zip_validation", "ZIP validation failed: TV Time ZIP exceeds the 25 MB limit.");
  let files: Record<string, Uint8Array>;
  let entryCount = 0, declaredExpandedSize = 0;
  try {
    files = unzipSync(bytes, { filter: (file) => {
      entryCount++;
      declaredExpandedSize += file.originalSize;
      if (file.name.includes("..") || file.name.startsWith("/") || /^[A-Za-z]:/.test(file.name)) throw new Error("Unsafe ZIP path.");
      if (entryCount > ZIP_LIMITS.entries) throw new Error("ZIP contains too many entries.");
      if (file.originalSize > ZIP_LIMITS.entry) throw new Error("ZIP entry exceeds the 20 MB limit.");
      if (declaredExpandedSize > ZIP_LIMITS.expanded) throw new Error("Expanded ZIP exceeds the 100 MB limit.");
      return /\.(json|csv)$/i.test(file.name);
    }});
  } catch (cause) {
    throw new TvTimeImportError("zip_validation", `ZIP validation failed: ${cause instanceof Error ? cause.message : "the archive could not be opened."}`, { cause });
  }
  const names = Object.keys(files);
  const seriesName = names.find((name) => /(^|\/)tvtime-series-[^/]+\.json$/i.test(name));
  if (seriesName && files[seriesName]) return parseJsonExport(files, names, seriesName);
  const followedName = entryNamed(names, "followed_tv_show.csv");
  if (followedName) return parseGdprExport(files, names, followedName);
  throw new TvTimeImportError("no_shows", "No TV Time shows were found. Select either the official GDPR data ZIP or a supported TV Time JSON export.");
}
