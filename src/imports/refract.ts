import { unzipSync } from "fflate";
import Papa from "papaparse";
import type { ProviderShow } from "../domain/models";
import type { TvTimeCoverage, TvTimeShow } from "./tvtime";

const ZIP_LIMITS = { compressed: 25 * 1024 * 1024, expanded: 100 * 1024 * 1024, entries: 10_000, entry: 20 * 1024 * 1024 };
const SUPPORTED_TYPES = new Set(["tv show", "anime"]);

export interface RefractShow {
  key: string;
  title: string;
  /** Native-language title. TVMaze often indexes only this one for non-English shows. */
  originalTitle?: string;
  year?: number;
  country?: string;
  status: string;
  watchedDate?: string;
}
export interface RefractEpisode {
  season: number;
  number: number;
  watchedAt?: string;
}
interface ImportIssue { row: number; reason: string }
export interface RefractParseResult {
  shows: RefractShow[];
  episodesByShow: Map<string, RefractEpisode[]>;
  malformed: ImportIssue[];
  unsupported: ImportIssue[];
  duplicates: ImportIssue[];
  totalRows: number;
}

export type RefractImportErrorCode = "not_refract" | "zip_validation" | "schema" | "no_shows";
export class RefractImportError extends Error {
  constructor(public readonly code: RefractImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefractImportError";
  }
}

function normalizeKey(title: string) {
  return title.trim().toLocaleLowerCase("en-US").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

// Remakes share a title ("Dracula" 2013 US and 2020 GB), so a title-only key silently collapses
// them into one show and pools both their episodes. episodes.csv carries ShowCountry alongside
// media.csv's Country, so the country qualifies the key on both sides of the join.
function showKey(title: string, country: string | undefined) {
  return `${normalizeKey(title)}|${normalizeKey(country ?? "")}`;
}

function entryNamed(names: string[], basename: string) {
  return names.find((name) => name.split("/").at(-1)?.toLowerCase() === basename);
}

function parseYear(value: string | undefined) {
  const year = Number(value);
  return Number.isInteger(year) && year > 1900 && year < 3000 ? year : undefined;
}

function calendarDate(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

type CsvRow = Record<string, string | undefined>;
function csv(files: Record<string, Uint8Array>, name: string): { rows: CsvRow[]; fields: string[] } {
  const bytes = files[name];
  if (!bytes) return { rows: [], fields: [] };
  const result = Papa.parse<CsvRow>(new TextDecoder().decode(bytes), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });
  if (result.errors.length > 0) throw new RefractImportError("schema", `Refract export schema could not be parsed: ${name}.`);
  return { rows: result.data, fields: result.meta.fields ?? [] };
}

export function parseRefractZip(bytes: Uint8Array): RefractParseResult {
  if (bytes.byteLength > ZIP_LIMITS.compressed) throw new RefractImportError("zip_validation", "ZIP validation failed: Refract export exceeds the 25 MB limit.");
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
      return /\.csv$/i.test(file.name);
    } });
  } catch (cause) {
    throw new RefractImportError("zip_validation", `ZIP validation failed: ${cause instanceof Error ? cause.message : "the archive could not be opened."}`, { cause });
  }
  const names = Object.keys(files);
  const mediaName = entryNamed(names, "media.csv");
  if (!mediaName) throw new RefractImportError("not_refract", "This is not a Refract export (media.csv was not found).");

  const media = csv(files, mediaName);
  const requiredFields = ["Title", "OriginalTitle", "Type", "Status"];
  if (!requiredFields.every((field) => media.fields.includes(field))) {
    throw new RefractImportError("schema", "Refract export schema could not be parsed: media.csv is missing expected columns.");
  }

  const malformed: ImportIssue[] = [], unsupported: ImportIssue[] = [], duplicates: ImportIssue[] = [];
  const shows: RefractShow[] = [];
  const seen = new Set<string>();
  // media.csv and episodes.csv can each independently leave either Title or OriginalTitle blank
  // for the same show (seen in real exports), so episodes.csv can only be joined to media.csv
  // reliably by treating both title columns as aliases of the same show, not by picking one
  // column and hoping both files agree on which one is populated.
  const aliasToKey = new Map<string, string>();
  // Fallback for rows whose ShowCountry does not line up with media.csv's Country. A title that
  // belongs to more than one show is stored as null so an ambiguous row is never misfiled.
  const titleOnlyToKey = new Map<string, string | null>();
  const addAlias = (title: string, country: string | undefined, key: string) => {
    aliasToKey.set(showKey(title, country), key);
    const titleOnly = normalizeKey(title);
    titleOnlyToKey.set(titleOnly, titleOnlyToKey.has(titleOnly) && titleOnlyToKey.get(titleOnly) !== key ? null : key);
  };
  media.rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const primary = row.Title?.trim() || row.OriginalTitle?.trim();
    const alias = row.Title?.trim() && row.OriginalTitle?.trim() && row.Title.trim() !== row.OriginalTitle.trim() ? row.OriginalTitle.trim() : undefined;
    const type = row.Type?.trim().toLowerCase();
    if (!primary) { malformed.push({ row: rowNumber, reason: "Missing title." }); return; }
    if (!type || !SUPPORTED_TYPES.has(type)) { unsupported.push({ row: rowNumber, reason: `Unsupported type: ${row.Type ?? "missing"}` }); return; }
    const country = row.Country?.trim();
    const key = showKey(primary, country);
    if (seen.has(key)) {
      duplicates.push({ row: rowNumber, reason: `${primary}${row.Year ? ` (${row.Year})` : ""}${country ? `, ${country}` : ""} repeats an earlier row and was skipped. Add it manually if you track both.` });
      return;
    }
    seen.add(key);
    addAlias(primary, country, key);
    if (alias) addAlias(alias, country, key);
    const year = parseYear(row.Year), watchedDate = calendarDate(row.WatchedDate);
    shows.push({ key, title: primary, ...(alias ? { originalTitle: alias } : {}), ...(year !== undefined ? { year } : {}),
      ...(country ? { country } : {}), status: row.Status?.trim().toLowerCase() || "unknown", ...(watchedDate ? { watchedDate } : {}) });
  });
  if (shows.length === 0) throw new RefractImportError("no_shows", "No supported shows were found in this Refract export.");

  const episodesByShow = new Map<string, RefractEpisode[]>();
  const episodesName = entryNamed(names, "episodes.csv");
  if (episodesName) {
    const episodes = csv(files, episodesName);
    const titleOnly = (title: string) => titleOnlyToKey.get(normalizeKey(title)) ?? undefined;
    for (const row of episodes.rows) {
      const type = row.ShowType?.trim().toLowerCase();
      if (type && !SUPPORTED_TYPES.has(type)) continue;
      const title = row.ShowTitle?.trim() || row.ShowOriginalTitle?.trim();
      const alternate = row.ShowOriginalTitle?.trim();
      const country = row.ShowCountry?.trim();
      const season = Number(row.Season), number = Number(row.Episode);
      if (!title || !Number.isInteger(season) || season < 0 || !Number.isInteger(number) || number <= 0) continue;
      const key = aliasToKey.get(showKey(title, country))
        ?? (alternate ? aliasToKey.get(showKey(alternate, country)) : undefined)
        ?? titleOnly(title)
        ?? (alternate ? titleOnly(alternate) : undefined)
        ?? showKey(title, country);
      const list = episodesByShow.get(key) ?? [];
      const watchedAt = calendarDate(row.WatchedAt);
      list.push({ season, number, ...(watchedAt ? { watchedAt } : {}) });
      episodesByShow.set(key, list);
    }
  }

  return { shows, episodesByShow, malformed, unsupported, duplicates, totalRows: media.rows.length };
}

// Refract exports carry no stable external ID (no IMDb/TVDB id) -- only title, year, and
// country -- unlike IMDb and TV Time exports which both include a real external ID for exact
// matching. Each show is instead resolved via a TVMaze title search, disambiguated by year
// where possible. A show search returns no reliable match, or the top result's year clearly
// disagrees with the source year, is left unresolved rather than guessed -- the existing
// reconciliation pipeline already reports unresolved shows so they can be added manually
// through the "+ Add show" search instead of risking a silently wrong match.
export interface RefractResolver {
  searchShows(query: string): Promise<ProviderShow[]>;
}

function candidateYear(show: ProviderShow): number | undefined {
  return show.premiered && /^\d{4}/.test(show.premiered) ? Number(show.premiered.slice(0, 4)) : undefined;
}

/**
 * Ranks one TVMaze candidate against the source row.
 *
 * Searching the title alone used to pick the first result within a year of the source, however
 * poorly the name fit, which quietly matched "Trapped" (Ófærð, IS) to "Cash Trapped" (GB) and
 * "Safe" (GB) to "Safe Harbour" (AU). Names carry the most signal, the country breaks ties
 * between same-named shows, and a genuine country disagreement is strong enough to veto a
 * name that never matched in the first place.
 *
 * A native title outranks the display title, because it is far more distinctive: "Şahsiyet"
 * identifies one show, while "Persona" names several. Country is never a reward -- TVMaze
 * reports none at all for the global streamers, so paying for a match would let a same-named
 * local show outrank the real one (the Korean "Kingdom" beating the Netflix "Kingdom"). It only
 * vetoes, and only a name that never matched anyway, since TVMaze files co-productions under
 * one country ("Leaving Neverland" and "Mars" are GB there and US in the export).
 */
function scoreCandidate(candidate: ProviderShow, show: RefractShow) {
  const name = normalizeKey(candidate.name);
  const originalExact = Boolean(show.originalTitle) && name === normalizeKey(show.originalTitle!);
  const titleExact = name === normalizeKey(show.title);
  const nameExact = originalExact || titleExact;
  const year = candidateYear(candidate);
  const bothYearsKnown = show.year !== undefined && year !== undefined;
  const yearClose = bothYearsKnown && Math.abs(year! - show.year!) <= 1;
  const countryKnown = Boolean(candidate.country && show.country);
  const countryConflict = countryKnown && candidate.country!.toLowerCase() !== show.country!.toLowerCase();
  // A year both sides know but disagree on is decisive -- same-name remakes are the common
  // case, so an exact name must never talk us past it. Without a year to check, only an exact
  // name is enough. Ties are broken by search order, which is TVMaze's own relevance ranking.
  const acceptable = bothYearsKnown ? yearClose && (nameExact || !countryConflict) : nameExact && !countryConflict;
  return { acceptable, points: (originalExact ? 5 : titleExact ? 4 : 0) + (yearClose ? 2 : 0) };
}

export async function resolveShowByTitle(show: RefractShow, resolver: RefractResolver): Promise<ProviderShow | undefined> {
  // TVMaze indexes many non-English shows only under their native title, and some titles only
  // without their subtitle ("Demon Slayer" for "Demon Slayer: Kimetsu no Yaiba").
  const stem = show.title.split(/[:\-–—]/)[0]!.trim();
  const queries = [show.title, ...(show.originalTitle && show.originalTitle !== show.title ? [show.originalTitle] : [])];
  const candidates: ProviderShow[] = [];
  try {
    for (const query of queries) candidates.push(...(await resolver.searchShows(query)).slice(0, 5));
    if (candidates.length === 0 && stem && stem !== show.title.trim()) {
      candidates.push(...(await resolver.searchShows(stem)).slice(0, 5));
    }
  } catch { return undefined; }
  if (candidates.length === 0) return undefined;
  if (show.year === undefined && !show.originalTitle) return candidates[0];

  let best: { show: ProviderShow; points: number } | undefined;
  for (const candidate of candidates) {
    if (best?.show.id === candidate.id) continue;
    const { acceptable, points } = scoreCandidate(candidate, show);
    if (acceptable && (!best || points > best.points)) best = { show: candidate, points };
  }
  return best?.show;
}

// Refract's episodes.csv only records episodes you actually watched, so an episode missing from
// it is unknown rather than deliberately unwatched. media.csv's Status is the only signal for
// which of the two it is: a finished or caught-up show should have everything aired watched,
// while a part-way show must keep its unwatched tail intact.
function refractCoverage(status: string): TvTimeCoverage {
  return status === "completed" || status === "up_to_date" ? "all_aired" : "watched_through";
}

// Every Refract show becomes a TvTimeShow (reusing the existing TV Time reconciliation and
// preview pipeline unchanged): resolved shows carry providerShowId, which the pipeline already
// treats as a direct, confident TVMaze match; unresolved shows carry neither providerShowId nor
// tvdbShowId/imdbId, which the same pipeline already classifies as "unmatched" and reports.
// Per-episode watched data has no external ID either, so a synthetic negative tvdbEpisodeId is
// used -- the pipeline's own episode matching already falls back to season/episode number
// whenever the external ID doesn't resolve, which real TVDB ids (always positive) never do.
export async function resolveRefractShows(
  parsed: RefractParseResult,
  resolver: RefractResolver,
  onProgress?: (completed: number, total: number) => void,
): Promise<TvTimeShow[]> {
  const total = parsed.shows.length;
  let completed = 0;
  onProgress?.(0, total);
  return Promise.all(parsed.shows.map(async (show) => {
    const match = await resolveShowByTitle(show, resolver);
    onProgress?.(++completed, total);
    const episodes = parsed.episodesByShow.get(show.key) ?? [];
    return {
      uuid: `refract:${show.key}`,
      ...(match ? { providerShowId: match.id } : {}),
      title: show.title,
      createdAt: show.watchedDate ? `${show.watchedDate}T00:00:00.000Z` : new Date(0).toISOString(),
      status: (show.status === "dropped" ? "stopped" : "continuing") as TvTimeShow["status"],
      coverage: refractCoverage(show.status),
      episodes: episodes.map((episode, index): TvTimeShow["episodes"][number] => ({
        tvdbEpisodeId: -(index + 1),
        season: episode.season,
        number: episode.number,
        name: `S${episode.season}E${episode.number}`,
        // Refract files specials under season 0, where TVMaze has no regular episode to match,
        // so without this they could only ever be reported as unmappable.
        special: episode.season === 0,
        watched: true,
        ...(episode.watchedAt ? { watchedAt: `${episode.watchedAt}T00:00:00.000Z` } : {}),
        rewatchCount: 0,
      })),
    };
  }));
}
