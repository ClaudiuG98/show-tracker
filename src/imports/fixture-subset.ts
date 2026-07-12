import type { ImdbImportRow } from "./imdb";
import type { TvTimeShow } from "./tvtime";

export interface FixtureSubsetOptions {
  imdbRows: readonly ImdbImportRow[];
  tvTimeShows: readonly TvTimeShow[];
  newestCount: number;
  requiredTitles: readonly string[];
}

export interface FixtureSubsetCounts {
  parsed: {
    imdbRows: number;
    tvTimeShows: number;
    tvTimeEpisodes: number;
  };
  selected: {
    imdbRows: number;
    tvTimeShows: number;
    tvTimeEpisodes: number;
  };
}

export interface FixtureSubsetResult {
  imdbRows: ImdbImportRow[];
  tvTimeShows: TvTimeShow[];
  counts: FixtureSubsetCounts;
}

const MISSING_POSITION = Number.MAX_SAFE_INTEGER;

function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function compareImdbRows(a: ImdbImportRow, b: ImdbImportRow) {
  return (b.created ?? "").localeCompare(a.created ?? "")
    || (a.position ?? MISSING_POSITION) - (b.position ?? MISSING_POSITION)
    || a.imdbId.localeCompare(b.imdbId)
    || a.title.localeCompare(b.title);
}

function compareTvTimeShows(a: TvTimeShow, b: TvTimeShow) {
  return b.createdAt.localeCompare(a.createdAt)
    || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title))
    || (a.tvdbShowId ?? MISSING_POSITION) - (b.tvdbShowId ?? MISSING_POSITION)
    || (a.imdbId ?? "").localeCompare(b.imdbId ?? "")
    || a.uuid.localeCompare(b.uuid);
}

function episodeCount(shows: readonly TvTimeShow[]) {
  return shows.reduce((total, show) => total + show.episodes.length, 0);
}

/**
 * Reduces the real export fixtures to a quick, repeatable development sample.
 * Title normalization is intentionally confined to this helper; production
 * reconciliation must continue to use stable external identifiers.
 */
export function selectFixtureSubset({
  imdbRows,
  tvTimeShows,
  newestCount,
  requiredTitles,
}: FixtureSubsetOptions): FixtureSubsetResult {
  if (!Number.isInteger(newestCount) || newestCount < 0) {
    throw new RangeError("newestCount must be a non-negative integer.");
  }

  const orderedImdbRows = [...imdbRows].sort(compareImdbRows);
  const required = [...new Set(requiredTitles.map(normalizeTitle).filter(Boolean))];
  const requiredSet = new Set(required);
  const selectedByImdbId = new Map<string, ImdbImportRow>();

  for (const row of orderedImdbRows.slice(0, newestCount)) {
    selectedByImdbId.set(row.imdbId, row);
  }

  for (const requiredTitle of required) {
    const row = orderedImdbRows.find((candidate) => normalizeTitle(candidate.title) === requiredTitle);
    if (row) selectedByImdbId.set(row.imdbId, row);
  }

  const selectedImdbRows = [...selectedByImdbId.values()].sort(compareImdbRows);
  const selectedImdbIds = new Set(selectedImdbRows.map((row) => row.imdbId));
  const selectedTitleRank = new Map<string, number>();
  const selectedImdbRank = new Map<string, number>();

  selectedImdbRows.forEach((row, index) => {
    selectedImdbRank.set(row.imdbId, index);
    const title = normalizeTitle(row.title);
    if (!selectedTitleRank.has(title)) selectedTitleRank.set(title, index);
  });

  for (const requiredTitle of requiredSet) {
    if (!selectedTitleRank.has(requiredTitle)) {
      selectedTitleRank.set(requiredTitle, selectedTitleRank.size);
    }
  }

  const rank = (show: TvTimeShow) => {
    if (show.imdbId && selectedImdbIds.has(show.imdbId)) {
      return selectedImdbRank.get(show.imdbId) ?? Number.MAX_SAFE_INTEGER;
    }
    return selectedTitleRank.get(normalizeTitle(show.title)) ?? Number.MAX_SAFE_INTEGER;
  };

  const selectedTvTimeShows = selectedImdbRows.length > 0
    ? tvTimeShows
      .filter((show) =>
        Boolean(show.imdbId && selectedImdbIds.has(show.imdbId))
        || selectedTitleRank.has(normalizeTitle(show.title)))
      .sort((a, b) => rank(a) - rank(b)
        || normalizeTitle(a.title).localeCompare(normalizeTitle(b.title))
        || (a.tvdbShowId ?? MISSING_POSITION) - (b.tvdbShowId ?? MISSING_POSITION)
        || a.uuid.localeCompare(b.uuid))
    : (() => {
      const ordered = [...tvTimeShows].sort(compareTvTimeShows);
      const selected = new Map(ordered.slice(0, newestCount).map((show) => [show.uuid, show]));
      for (const requiredTitle of requiredSet) {
        const show = ordered.find((candidate) => normalizeTitle(candidate.title) === requiredTitle);
        if (show) selected.set(show.uuid, show);
      }
      return [...selected.values()].sort(compareTvTimeShows);
    })();

  return {
    imdbRows: selectedImdbRows,
    tvTimeShows: selectedTvTimeShows,
    counts: {
      parsed: {
        imdbRows: imdbRows.length,
        tvTimeShows: tvTimeShows.length,
        tvTimeEpisodes: episodeCount(tvTimeShows),
      },
      selected: {
        imdbRows: selectedImdbRows.length,
        tvTimeShows: selectedTvTimeShows.length,
        tvTimeEpisodes: episodeCount(selectedTvTimeShows),
      },
    },
  };
}
