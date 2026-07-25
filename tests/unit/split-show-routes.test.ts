import { describe, expect, it } from "vitest";
import { expandSplitTvTimeShows } from "../../src/imports/split-show-routes";
import type { TvTimeShow } from "../../src/imports/tvtime";

const episode = (season: number, number: number) => ({
  tvdbEpisodeId: season * 100 + number,
  season,
  number,
  name: `Episode ${number}`,
  special: false,
  watched: true,
  rewatchCount: 0,
});

describe("split TV Time show routing", () => {
  it("routes Physical: 100 seasons to the corresponding TVMaze shows automatically", () => {
    const source: TvTimeShow = {
      uuid: "physical-100",
      tvdbShowId: 424941,
      imdbId: "tt25274446",
      title: "Physical: 100",
      createdAt: "2023-02-16T07:24:57Z",
      status: "continuing",
      episodes: [episode(1, 1), episode(2, 1), episode(3, 1), episode(3, 2)],
    };

    const result = expandSplitTvTimeShows([source]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      tvdbShowId: 424941,
      imdbId: "tt25274446",
      providerShowId: 66547,
      episodes: [{ season: 1, number: 1 }, { season: 2, number: 1 }],
    });
    expect(result[1]).toMatchObject({
      providerShowId: 87808,
      episodes: [{ season: 1, number: 1 }, { season: 1, number: 2 }],
    });
    expect(result[1]).not.toHaveProperty("tvdbShowId");
    expect(result[1]).not.toHaveProperty("imdbId");
  });

  it("keeps future seasons visible for review when no exact route exists yet", () => {
    const source: TvTimeShow = {
      uuid: "physical-100",
      tvdbShowId: 424941,
      title: "Physical: 100",
      createdAt: "2023-02-16T07:24:57Z",
      status: "continuing",
      episodes: [episode(1, 1), episode(4, 1)],
    };

    const result = expandSplitTvTimeShows([source]);
    expect(result.flatMap((show) => show.episodes).map((item) => [item.season, item.number])).toEqual([[1, 1], [4, 1]]);
  });

  it("preserves the existing one-season-per-show anthology routes", () => {
    const source: TvTimeShow = {
      uuid: "monster",
      tvdbShowId: 389492,
      title: "Monster",
      createdAt: "2022-10-16T06:21:47Z",
      status: "continuing",
      episodes: [episode(1, 1), episode(2, 1), episode(3, 1)],
    };

    expect(expandSplitTvTimeShows([source]).map((show) => [show.providerShowId, show.episodes[0]?.season])).toEqual([
      [50907, 1], [68626, 1], [86754, 1],
    ]);
  });

  it("splits The Haunting into its separately titled TVMaze shows", () => {
    const source: TvTimeShow = {
      uuid: "the-haunting",
      tvdbShowId: 345246,
      title: "The Haunting",
      createdAt: "2018-10-12T00:00:00Z",
      status: "continuing",
      episodes: [episode(1, 1), episode(2, 1)],
    };

    expect(expandSplitTvTimeShows([source]).map((show) => [show.providerShowId, show.episodes[0]?.season])).toEqual([
      [29191, 1], [49673, 1],
    ]);
  });

  it("normalizes Money Heist's provider numbering without splitting the show", () => {
    const source: TvTimeShow = {
      uuid: "money-heist",
      tvdbShowId: 327417,
      title: "Money Heist",
      createdAt: "2017-05-02T00:00:00Z",
      status: "continuing",
      episodes: [episode(1, 1), episode(2, 1), episode(2, 6), episode(3, 1), episode(4, 1), episode(5, 1)],
    };

    const [result] = expandSplitTvTimeShows([source]);
    expect(result).toMatchObject({ uuid: "money-heist", title: "Money Heist", providerShowId: 27436 });
    expect(result?.episodes.map((item) => [item.season, item.number])).toEqual([
      [1, 1], [1, 10], [1, 15], [3, 1], [4, 1], [5, 1],
    ]);
  });

  it("excludes Sense8 episodes that TVMaze classifies as narrative specials", () => {
    const source: TvTimeShow = {
      uuid: "sense8",
      tvdbShowId: 268156,
      title: "Sense8",
      createdAt: "2015-06-05T00:00:00Z",
      status: "continuing",
      episodes: [episode(2, 10), episode(2, 11), episode(2, 12)],
    };

    const [result] = expandSplitTvTimeShows([source]);
    expect(result?.episodes.map((item) => [item.number, item.special])).toEqual([
      [10, false], [11, true], [12, true],
    ]);
  });
});
