import { unzipSync } from "fflate";
import { z } from "zod";

export const ZIP_LIMITS = { compressed: 25 * 1024 * 1024, expanded: 100 * 1024 * 1024, entries: 10_000, entry: 20 * 1024 * 1024 };
const showIdSchema = z.object({ tvdb: z.number().int().positive().nullable().optional(), imdb: z.string().nullable().optional() });
const episodeIdSchema = z.object({ tvdb: z.number().int().positive(), imdb: z.string().nullable().optional() });
const episodeSchema = z.object({ id: episodeIdSchema, number: z.number().int().positive(), name: z.string(), special: z.boolean(), is_watched: z.boolean(),
  watched_at: z.string().datetime({ offset: true }).nullable(), rewatch_count: z.number().int().nonnegative(), watched_count: z.number().int().nonnegative() });
const seasonSchema = z.object({ number: z.number().int().nonnegative(), is_specials: z.boolean(), episodes: z.array(episodeSchema).max(20_000) });
const showSchema = z.object({ uuid: z.string(), id: showIdSchema, created_at: z.string().datetime({ offset: true }), title: z.string(),
  status: z.enum(["up_to_date", "continuing", "not_started_yet", "stopped"]), is_favorite: z.boolean(),
  _noEpisodeData: z.boolean(), seasons: z.array(seasonSchema).max(1_000) });

export interface TvTimeEpisode {
  tvdbEpisodeId: number; season: number; number: number; name: string; special: boolean;
  watched: boolean; watchedAt?: string; rewatchCount: number;
}
export interface TvTimeShow {
  uuid: string; tvdbShowId?: number; imdbId?: string; title: string; createdAt: string;
  providerShowId?: number;
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

export function parseTvTimeZip(bytes: Uint8Array): TvTimeParseResult {
  if (bytes.byteLength > ZIP_LIMITS.compressed) throw new TvTimeImportError("zip_validation", "ZIP validation failed: TV Time ZIP exceeds the 25 MB limit.");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => {
      if (file.name.includes("..") || file.name.startsWith("/") || /^[A-Za-z]:/.test(file.name)) throw new Error("Unsafe ZIP path.");
      if (file.originalSize > ZIP_LIMITS.entry) throw new Error("ZIP entry exceeds the 20 MB limit.");
      return file.name.endsWith(".json");
    }});
  } catch (cause) {
    throw new TvTimeImportError("zip_validation", `ZIP validation failed: ${cause instanceof Error ? cause.message : "the archive could not be opened."}`, { cause });
  }
  const names = Object.keys(files);
  if (names.length > ZIP_LIMITS.entries) throw new TvTimeImportError("zip_validation", "ZIP validation failed: ZIP contains too many entries.");
  if (Object.values(files).reduce((sum, file) => sum + file.byteLength, 0) > ZIP_LIMITS.expanded) throw new TvTimeImportError("zip_validation", "ZIP validation failed: expanded ZIP exceeds the 100 MB limit.");
  const seriesName = names.find((name) => /(^|\/)tvtime-series-[^/]+\.json$/i.test(name));
  if (!seriesName || !files[seriesName]) throw new TvTimeImportError("no_shows", "No TV Time shows were found.");
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
