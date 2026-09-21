import { unzipSync } from "fflate";
import Papa from "papaparse";
import { resolveShowByTitle, type RefractResolver } from "./refract";
import type { TvTimeParseResult, TvTimeShow } from "./tvtime";

interface BingersShow extends TvTimeShow { originalTitle?: string; year?: number }
export interface BingersParseResult extends TvTimeParseResult { shows: BingersShow[] }
export class BingersImportError extends Error {
  constructor(readonly code: "not_bingers" | "zip_validation" | "schema" | "no_shows", message: string) {
    super(message);
    this.name = "BingersImportError";
  }
}

type Row = Record<string, string | undefined>;
const integer = (value: string | undefined, minimum = 1) => value?.trim() && Number.isSafeInteger(Number(value)) && Number(value) >= minimum ? Number(value) : undefined;
const date = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

export function parseBingersZip(bytes: Uint8Array): BingersParseResult {
  if (bytes.byteLength > 25 * 1024 * 1024) throw new BingersImportError("zip_validation", "Bingers ZIP exceeds the 25 MB limit.");
  let files: Record<string, Uint8Array>;
  let entries = 0, expanded = 0;
  try {
    files = unzipSync(bytes, { filter: (file) => {
      entries++;
      expanded += file.originalSize;
      if (file.name.includes("..") || file.name.startsWith("/") || file.name.includes("\\") || /^[A-Za-z]:/.test(file.name)) throw new Error("Unsafe ZIP path.");
      if (entries > 10_000 || expanded > 100 * 1024 * 1024 || file.originalSize > 20 * 1024 * 1024) throw new Error("ZIP exceeds safe extraction limits.");
      return /(?:^|\/)(?:library|watches)\.csv$/i.test(file.name);
    } });
  } catch (cause) {
    throw new BingersImportError("zip_validation", `ZIP validation failed: ${cause instanceof Error ? cause.message : "Cannot open archive."}`);
  }
  const findFile = (name: string) => {
    const matches = Object.keys(files).filter((path) => path.split("/").at(-1)?.toLowerCase() === name);
    if (matches.length > 1) throw new BingersImportError("schema", `Bingers export contains multiple ${name} files.`);
    return matches[0];
  };
  const library = findFile("library.csv"), watches = findFile("watches.csv");
  if (!library) throw new BingersImportError("not_bingers", "Not a Bingers export: library.csv was not found.");
  if (!watches) throw new BingersImportError("schema", "Bingers export is missing watches.csv. Export your complete library and watch history.");
  const parse = (path: string, required: string[]) => {
    const result = Papa.parse<Row>(new TextDecoder().decode(files[path]), { header: true, skipEmptyLines: "greedy",
      transformHeader: (header) => header.replace(/^\uFEFF/, "").trim().toLowerCase() });
    if (result.errors.length || !required.every((field) => result.meta.fields?.includes(field))) {
      throw new BingersImportError("schema", `Bingers ${path} has invalid CSV or missing required columns.`);
    }
    return result.data;
  };
  const libraryRows = parse(library, ["type", "title", "tvdb_id", "tmdb_id", "list_status"]);
  const watchRows = parse(watches, ["type", "title", "tvdb_id", "tmdb_id", "season_number", "episode_number", "plays"]);
  const shows: BingersShow[] = [], ignoredEntries: string[] = [];
  const byTvdb = new Map<number, BingersShow>(), byTmdb = new Map<number, BingersShow>();
  const getShow = (row: Row, context: string, fromLibrary: boolean): BingersShow | undefined => {
    const tvdb = integer(row.tvdb_id), tmdb = integer(row.tmdb_id);
    const title = row.title?.trim() || row.original_title?.trim();
    if (!title || (!tvdb && !tmdb)) { ignoredEntries.push(`${context}: missing title or valid TVDB/TMDB show ID.`); return undefined; }
    const tvdbMatch = tvdb ? byTvdb.get(tvdb) : undefined, tmdbMatch = tmdb ? byTmdb.get(tmdb) : undefined;
    if ((tvdbMatch && tmdbMatch && tvdbMatch !== tmdbMatch) || (tmdbMatch?.tvdbShowId && tvdb && tmdbMatch.tvdbShowId !== tvdb)) {
      throw new BingersImportError("schema", `${context}: conflicting show identifiers.`);
    }
    let show = tvdbMatch ?? tmdbMatch;
    if (!show) {
      const listStatus = row.list_status?.trim().toLowerCase();
      const status: TvTimeShow["status"] = ["stopped", "hidden", "dropped"].includes(listStatus ?? "") || (!listStatus && (row.stopped_watching_at || row.hidden_at))
        ? "stopped" : ["for_later", "watchlist", "not_started"].includes(listStatus ?? "") || (!listStatus && row.for_later_at) ? "not_started_yet" : "continuing";
      show = { uuid: `bingers:${tvdb ? `tvdb:${tvdb}` : `tmdb:${tmdb}`}`, ...(tvdb ? { tvdbShowId: tvdb } : {}), title,
        ...(row.original_title?.trim() ? { originalTitle: row.original_title.trim() } : {}),
        ...(integer(row.year, 1900) ? { year: integer(row.year, 1900)! } : {}),
        createdAt: date(row.added_at) ?? date(row.first_watched_at) ?? new Date(0).toISOString(),
        status, coverage: "watched_through", episodes: [] };
      shows.push(show);
    } else if (fromLibrary) ignoredEntries.push(`${context}: duplicate library show merged.`);
    if (tvdb) { show.tvdbShowId = tvdb; byTvdb.set(tvdb, show); }
    if (tmdb) byTmdb.set(tmdb, show);
    return show;
  };
  libraryRows.forEach((row, index) => {
    if (row.type?.trim().toLowerCase() !== "show") { ignoredEntries.push(`library.csv row ${index + 2}: non-show skipped.`); return; }
    getShow(row, `library.csv row ${index + 2}`, true);
  });
  watchRows.forEach((row, index) => {
    const context = `watches.csv row ${index + 2}`;
    if (row.type?.trim().toLowerCase() !== "episode") { ignoredEntries.push(`${context}: non-episode skipped.`); return; }
    const season = integer(row.season_number, 0), number = integer(row.episode_number), plays = integer(row.plays, 0);
    if (season === undefined || number === undefined || plays === undefined) { ignoredEntries.push(`${context}: invalid season, episode, or play count.`); return; }
    if (plays === 0) return;
    const show = getShow(row, context, false);
    if (!show) return;
    const watchedAt = date(row.last_watched_at) ?? date(row.first_watched_at);
    const existing = show.episodes.find((episode) => episode.season === season && episode.number === number);
    if (existing) {
      existing.rewatchCount = Math.max(existing.rewatchCount, plays - 1);
      if (watchedAt && (!existing.watchedAt || watchedAt > existing.watchedAt)) existing.watchedAt = watchedAt;
    } else show.episodes.push({ tvdbEpisodeId: -(show.episodes.length + 1), season, number, name: `S${season}E${number}`,
      special: season === 0, watched: true, ...(watchedAt ? { watchedAt } : {}), rewatchCount: plays - 1 });
  });
  if (shows.length === 0) throw new BingersImportError("no_shows", "No supported shows were found in the Bingers export.");
  return { shows, specials: shows.reduce((total, show) => total + show.episodes.filter((episode) => episode.special).length, 0),
    specialFlagMismatches: 0, ignoredEntries };
}

export async function resolveBingersShows(parsed: BingersParseResult, resolver: RefractResolver): Promise<BingersParseResult> {
  const shows = await Promise.all(parsed.shows.map(async (show) => {
    if (show.tvdbShowId !== undefined) return show;
    const match = await resolveShowByTitle({ key: show.uuid, title: show.title.replace(/\s*\(\d{4}\)$/, ""),
      originalTitle: (show.originalTitle ?? show.title).replace(/\s*\(\d{4}\)$/, ""),
      ...(show.year ? { year: show.year } : {}), status: show.status }, resolver);
    return match ? { ...show, providerShowId: match.id } : show;
  }));
  return { ...parsed, shows };
}
