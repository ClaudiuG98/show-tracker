import { describe, expect, it } from "vitest";
import { selectFixtureSubset } from "../../src/imports/fixture-subset";
import type { ImdbImportRow } from "../../src/imports/imdb";
import type { TvTimeShow } from "../../src/imports/tvtime";

function imdbRow(
  imdbId: string,
  title: string,
  created?: string,
  position?: number,
): ImdbImportRow {
  return {
    imdbId,
    title,
    titleType: "series",
    ...(created ? { created } : {}),
    ...(position === undefined ? {} : { position }),
  };
}

function tvTimeShow(
  uuid: string,
  title: string,
  options: { imdbId?: string; tvdbShowId?: number; episodes?: number } = {},
): TvTimeShow {
  return {
    uuid,
    title,
    createdAt: "2025-01-01T00:00:00Z",
    status: "continuing",
    episodes: Array.from({ length: options.episodes ?? 0 }, (_, index) => ({
      tvdbEpisodeId: index + 1,
      season: 1,
      number: index + 1,
      name: `Episode ${index + 1}`,
      special: false,
      watched: false,
      rewatchCount: 0,
    })),
    ...(options.imdbId ? { imdbId: options.imdbId } : {}),
    ...(options.tvdbShowId === undefined ? {} : { tvdbShowId: options.tvdbShowId }),
  };
}

describe("development fixture subset selection", () => {
  it("selects the newest rows by Created regardless of input order", () => {
    const result = selectFixtureSubset({
      imdbRows: [
        imdbRow("tt-old", "Old", "2020-01-01", 1),
        imdbRow("tt-newest", "Newest", "2025-04-01", 4),
        imdbRow("tt-middle", "Middle", "2024-03-01", 3),
        imdbRow("tt-newer", "Newer", "2025-03-01", 2),
      ],
      tvTimeShows: [],
      newestCount: 2,
      requiredTitles: [],
    });

    expect(result.imdbRows.map((row) => row.imdbId)).toEqual(["tt-newest", "tt-newer"]);
  });

  it("keeps exactly the newest 20 before adding an older required title", () => {
    const rows = Array.from({ length: 25 }, (_, index) => imdbRow(
      `tt${String(index + 1).padStart(2, "0")}`,
      index === 24 ? "House of the Dragon" : index === 4 ? "Silo" : `Show ${index + 1}`,
      `2025-01-${String(index + 1).padStart(2, "0")}`,
    ));
    const result = selectFixtureSubset({ imdbRows: rows.reverse(), tvTimeShows: [], newestCount: 20, requiredTitles: ["Silo", "House of the Dragon"] });
    expect(result.imdbRows).toHaveLength(21);
    expect(result.imdbRows.slice(0, 20).map((row) => row.created)).toEqual(
      Array.from({ length: 20 }, (_, index) => `2025-01-${String(25 - index).padStart(2, "0")}`),
    );
    expect(result.imdbRows[20]?.title).toBe("Silo");
  });

  it("forces required titles and deduplicates titles already in the newest selection", () => {
    const result = selectFixtureSubset({
      imdbRows: [
        imdbRow("tt1", "Newest", "2025-03-01"),
        imdbRow("tt2", "Silo", "2025-02-01"),
        imdbRow("tt3", "Older", "2024-01-01"),
        imdbRow("tt4", "House of the Dragon", "2022-10-24"),
      ],
      tvTimeShows: [],
      newestCount: 2,
      requiredTitles: ["Silo", "House of the Dragon", "silo"],
    });

    expect(result.imdbRows.map((row) => row.imdbId)).toEqual(["tt1", "tt2", "tt4"]);
    expect(result.counts.selected.imdbRows).toBe(3);
  });

  it("filters TV Time by selected IMDb IDs or development-only normalized titles", () => {
    const result = selectFixtureSubset({
      imdbRows: [
        imdbRow("tt-railway", "The Railway Men: The Untold Story", "2025-01-01"),
        imdbRow("tt-silo", "Silo", "2023-11-03"),
        imdbRow("tt-hotd", "House of the Dragon", "2022-10-24"),
      ],
      tvTimeShows: [
        tvTimeShow("railway", "the railway men - the untold story", { episodes: 2 }),
        tvTimeShow("silo", "SILO", { tvdbShowId: 403245, episodes: 3 }),
        tvTimeShow("hotd", "Unrelated provider title", { imdbId: "tt-hotd", episodes: 4 }),
        tvTimeShow("unrelated", "Unrelated", { episodes: 5 }),
      ],
      newestCount: 1,
      requiredTitles: ["Silo", "House of the Dragon"],
    });

    expect(result.tvTimeShows.map((show) => show.uuid)).toEqual(["railway", "silo", "hotd"]);
    expect(result.counts).toEqual({
      parsed: { imdbRows: 3, tvTimeShows: 4, tvTimeEpisodes: 14 },
      selected: { imdbRows: 3, tvTimeShows: 3, tvTimeEpisodes: 9 },
    });
  });

  it("uses Position and stable IDs as deterministic tie breakers", () => {
    const result = selectFixtureSubset({
      imdbRows: [
        imdbRow("tt3", "Third", undefined, 3),
        imdbRow("tt2", "Second", undefined, 2),
        imdbRow("tt1", "First", undefined, 2),
      ],
      tvTimeShows: [],
      newestCount: 3,
      requiredTitles: [],
    });

    expect(result.imdbRows.map((row) => row.imdbId)).toEqual(["tt1", "tt2", "tt3"]);
  });

  it("rejects invalid newest counts", () => {
    expect(() => selectFixtureSubset({
      imdbRows: [],
      tvTimeShows: [],
      newestCount: -1,
      requiredTitles: [],
    })).toThrow("newestCount must be a non-negative integer");
  });
});
