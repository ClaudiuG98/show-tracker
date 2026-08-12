import { describe, expect, it } from "vitest";
import type { ProviderEpisode } from "../../src/domain/models";
import { fillProgressCoverage, mapTvTimeProgressDetailed, reconcileShows, type ImportedEpisodeState } from "../../src/imports/reconcile";
import type { TvTimeCoverage, TvTimeShow } from "../../src/imports/tvtime";

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
    expect(result.states[0]!.tvdbEpisodeId).toBeUndefined();
    expect(result.explicitUnwatchedMapped).toBe(1);
    expect(result.specialsExcluded).toBe(1);
    expect(result.unresolved).toMatchObject([{ show: "Show", name: "Missing", season: 9, episode: 9 }]);
  });
});

describe("season-layout remapping", () => {
  // Refract holds the same 6 episodes split 3+3; TVMaze splits them 2+4.
  const provider: ProviderEpisode[] = [
    { id: 11, showId: 1, season: 1, number: 1, kind: "regular" }, { id: 12, showId: 1, season: 1, number: 2, kind: "regular" },
    { id: 21, showId: 1, season: 2, number: 1, kind: "regular" }, { id: 22, showId: 1, season: 2, number: 2, kind: "regular" },
    { id: 23, showId: 1, season: 2, number: 3, kind: "regular" }, { id: 24, showId: 1, season: 2, number: 4, kind: "regular" },
  ];
  const sourceEpisode = (season: number, number: number, index: number) =>
    ({ tvdbEpisodeId: -(index + 1), season, number, name: `S${season}E${number}`, special: false, watched: true, rewatchCount: 0 });
  const show = (pairs: Array<[number, number]>): TvTimeShow => ({ uuid: "x", title: "Split", createdAt: "2025-01-01T00:00:00Z",
    status: "continuing", episodes: pairs.map(([season, number], index) => sourceEpisode(season, number, index)) });

  it("maps by position when the numbering disagrees but both sides hold the same run", () => {
    const result = mapTvTimeProgressDetailed(show([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]), provider);

    expect(result.unresolved).toHaveLength(0);
    expect(result.states.map((state) => state.tvmazeEpisodeId)).toEqual([11, 12, 21, 22, 23, 24]);
    expect(result.numberingConflicts.map((conflict) => `${conflict.sourceNumber}->${conflict.providerNumber}`))
      .toEqual(["S1E3->S2E1", "S2E1->S2E2", "S2E2->S2E3", "S2E3->S2E4"]);
  });

  it("leaves episodes unresolved rather than guessing when the runs are different lengths", () => {
    const result = mapTvTimeProgressDetailed(show([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]]), provider);

    expect(result.unresolved.map((episode) => `S${episode.season}E${episode.episode}`)).toEqual(["S1E3"]);
    expect(result.states.map((state) => state.tvmazeEpisodeId)).toEqual([11, 12, 21, 22]);
  });

  it("does not second-guess numbering that already lines up", () => {
    const result = mapTvTimeProgressDetailed(show([[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4]]), provider);

    expect(result.numberingConflicts).toHaveLength(0);
    expect(result.states.map((state) => state.tvmazeEpisodeId)).toEqual([11, 12, 21, 22, 23, 24]);
  });
});

describe("watched-only export coverage fill", () => {
  const clock = { now: new Date("2025-06-01T00:00:00Z"), settings: { timezone: "UTC", dateOnlyReleaseHour: "09:00", notifications: true } };
  const episodes: ProviderEpisode[] = [
    { id: 1, showId: 1, season: 1, number: 1, kind: "regular", airstamp: "2025-01-01T00:00:00Z" },
    { id: 2, showId: 1, season: 1, number: 2, kind: "regular", airstamp: "2025-01-08T00:00:00Z" },
    { id: 3, showId: 1, season: 1, number: 3, kind: "regular", airstamp: "2025-01-15T00:00:00Z" },
    { id: 4, showId: 1, season: 1, number: 4, kind: "regular", airstamp: "2025-01-22T00:00:00Z" },
    { id: 5, showId: 1, season: 0, number: 1, kind: "special", airstamp: "2025-01-02T00:00:00Z" },
    { id: 6, showId: 1, season: 1, number: 5, kind: "regular", airstamp: "2099-01-01T00:00:00Z" },
  ];
  const show = (coverage?: TvTimeCoverage): TvTimeShow => ({ uuid: "x", title: "Show", createdAt: "2025-01-01T00:00:00Z",
    status: "continuing", ...(coverage ? { coverage } : {}), episodes: [] });
  const state = (id: number, watched = true): ImportedEpisodeState =>
    ({ tvmazeEpisodeId: id, season: 1, episode: id, watched, source: "tvtime" });
  const backfilled = (states: ImportedEpisodeState[]) =>
    states.filter((item) => item.source === "backfill").map((item) => item.tvmazeEpisodeId);

  it("fills every aired regular episode for an all_aired show, skipping specials and future episodes", () => {
    const result = fillProgressCoverage(show("all_aired"), episodes, [state(2)], clock);

    expect(result.backfilled).toBe(3);
    expect(backfilled(result.states)).toEqual([1, 3, 4]);
    expect(result.states.every((item) => item.watched)).toBe(true);
  });

  it("fills gaps below the latest watched episode but keeps the unwatched tail", () => {
    const result = fillProgressCoverage(show("watched_through"), episodes, [state(1), state(3)], clock);

    expect(backfilled(result.states)).toEqual([2]);
    expect(result.states.some((item) => item.tvmazeEpisodeId === 4)).toBe(false);
  });

  it("fills nothing when the export states watched and unwatched explicitly", () => {
    const states = [state(1)];

    const result = fillProgressCoverage(show(), episodes, states, clock);

    expect(result).toEqual({ states, backfilled: 0 });
  });

  it("never overwrites an episode the export explicitly marked unwatched", () => {
    const result = fillProgressCoverage(show("all_aired"), episodes, [state(3, false)], clock);

    expect(backfilled(result.states)).toEqual([1, 2, 4]);
    expect(result.states.find((item) => item.tvmazeEpisodeId === 3)).toMatchObject({ watched: false, source: "tvtime" });
  });

  it("fills nothing for a watched_through show with no watched episode at all", () => {
    const result = fillProgressCoverage(show("watched_through"), episodes, [], clock);

    expect(result).toEqual({ states: [], backfilled: 0 });
  });
});
