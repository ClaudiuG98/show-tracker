import { describe, expect, it } from "vitest";
import type { ProviderEpisode } from "../../src/domain/models";
import { mapTvTimeProgressDetailed, reconcileShows } from "../../src/imports/reconcile";
import type { TvTimeShow } from "../../src/imports/tvtime";

describe("TV Time episode reconciliation", () => {
  it("creates a visible conflict when stable exact IDs resolve to different TVMaze shows", () => {
    const imdb = { imdbId: "tt1", title: "Show", titleType: "series" as const };
    const tvtime: TvTimeShow = { uuid: "x", tvdbShowId: 10, title: "Show", createdAt: "2025-01-01T00:00:00Z", status: "continuing", episodes: [] };
    const imdbProvider = { provider: "tvmaze" as const, id: 1, name: "IMDb result", status: "running" as const, externalIds: { imdb: "tt1", tvmazeShow: 1 }, updatedAt: 1 };
    const tvdbProvider = { provider: "tvmaze" as const, id: 2, name: "TVDB result", status: "running" as const, externalIds: { imdb: "tt1", tvdbShow: 10, tvmazeShow: 2 }, updatedAt: 1 };
    const records = reconcileShows([imdb], [tvtime], new Map([["tt1", imdbProvider]]), new Map([[10, tvdbProvider]]));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "conflict", conflict: { imdbProvider: { id: 1 }, tvtimeProvider: { id: 2 } } });
  });

  it("prefers an exact compatible episode ID and reports season-number conflicts", () => {
    const show: TvTimeShow = { uuid: "x", tvdbShowId: 1, title: "Renumbered", createdAt: "2025-01-01T00:00:00Z", status: "continuing", episodes: [
      { tvdbEpisodeId: 500, season: 2, number: 1, name: "Moved", special: false, watched: true, rewatchCount: 0 },
    ] };
    const provider: ProviderEpisode[] = [{ id: 50, showId: 1, tvdbEpisodeId: 500, season: 3, number: 1, kind: "regular" }];

    const result = mapTvTimeProgressDetailed(show, provider);
    expect(result.states).toMatchObject([{ tvmazeEpisodeId: 50, season: 3, episode: 1, watched: true }]);
    expect(result.numberingConflicts).toMatchObject([{ sourceNumber: "S2E1", providerNumber: "S3E1" }]);
    expect(result.unresolved).toHaveLength(0);
  });

  it("keeps explicit unwatched states, excludes specials, and names unresolved episodes", () => {
    const show: TvTimeShow = { uuid: "x", tvdbShowId: 1, title: "Show", createdAt: "2025-01-01T00:00:00Z", status: "continuing", episodes: [
      { tvdbEpisodeId: 1, season: 1, number: 1, name: "Unwatched", special: false, watched: false, rewatchCount: 0 },
      { tvdbEpisodeId: 2, season: 0, number: 1, name: "Special", special: true, watched: false, rewatchCount: 0 },
      { tvdbEpisodeId: 3, season: 9, number: 9, name: "Missing", special: false, watched: true, rewatchCount: 0 },
    ] };
    const result = mapTvTimeProgressDetailed(show, [{ id: 10, showId: 1, season: 1, number: 1, kind: "regular" }]);
    expect(result.states).toMatchObject([{ tvmazeEpisodeId: 10, watched: false }]);
    expect(result.explicitUnwatchedMapped).toBe(1);
    expect(result.specialsExcluded).toBe(1);
    expect(result.unresolved).toMatchObject([{ show: "Show", name: "Missing", season: 9, episode: 9 }]);
  });
});
