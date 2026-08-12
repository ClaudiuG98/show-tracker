// Private fixtures are local-only and excluded from packaged/repository artifacts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandSplitTvTimeShows } from "../../src/imports/split-show-routes";
import { parseRefractZip } from "../../src/imports/refract";
import { parseTvTimeZip } from "../../src/imports/tvtime";

describe("supplied export fixtures", () => {
  const gdprFixtureIt = existsSync("initial-data/gdpr-data.zip") ? it : it.skip;
  const refractFixtureName = existsSync("initial-data")
    ? readdirSync("initial-data").find((name) => /^refract-export-.*\.zip$/.test(name))
    : undefined;
  const refractFixtureIt = refractFixtureName ? it : it.skip;

  gdprFixtureIt("parses and normalizes the official TV Time GDPR archive", () => {
    const result = parseTvTimeZip(readFileSync("initial-data/gdpr-data.zip"));
    // 177 shows are still followed; the rest are recovered from their watch history alone.
    expect(result.shows).toHaveLength(215);
    expect(result.shows.find((show) => show.title === "Oz")).toMatchObject({ tvdbShowId: 70682, rating: 5, status: "continuing" });
    // Dropped from followed_tv_show.csv, so only the tracking rows and summary still name it.
    expect(result.shows.find((show) => show.tvdbShowId === 371980)).toMatchObject({
      title: "Severance", status: "continuing", coverage: "watched_through",
    });
    expect(result.shows.find((show) => show.tvdbShowId === 371980)?.episodes.length).toBe(19);
    expect(result.shows.find((show) => show.title === "Godless")).toMatchObject({
      tvdbShowId: 333801,
      status: "continuing",
      episodes: expect.arrayContaining([expect.objectContaining({ season: 1, number: 7, watched: true })]),
    });
    expect(result.shows.flatMap((show) => show.episodes).filter((episode) => episode.watched).length).toBeGreaterThan(5_000);

    const physical = expandSplitTvTimeShows(result.shows.filter((show) => show.tvdbShowId === 424941));
    expect(physical.map((show) => [show.providerShowId, show.episodes.length])).toEqual([[66547, 18], [87808, 12]]);

    const haunting = expandSplitTvTimeShows(result.shows.filter((show) => show.tvdbShowId === 345246));
    expect(haunting.map((show) => [show.providerShowId, show.episodes.length])).toEqual([[29191, 10], [49673, 9]]);

    const moneyHeist = expandSplitTvTimeShows(result.shows.filter((show) => show.tvdbShowId === 327417));
    expect(moneyHeist).toMatchObject([{ providerShowId: 27436 }]);
    expect(moneyHeist[0]?.episodes.map((episode) => `${episode.season}:${episode.number}`)).toEqual([
      ...Array.from({ length: 15 }, (_, index) => `1:${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `3:${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `4:${index + 1}`),
      ...Array.from({ length: 10 }, (_, index) => `5:${index + 1}`),
    ]);

    const sense8 = expandSplitTvTimeShows(result.shows.filter((show) => show.tvdbShowId === 268156));
    expect(sense8[0]?.episodes.filter((episode) => episode.special).map((episode) => `${episode.season}:${episode.number}`)).toEqual(["2:11", "2:12"]);
  });

  refractFixtureIt("parses a real Refract export", () => {
    const result = parseRefractZip(readFileSync(`initial-data/${refractFixtureName}`));
    expect(result.shows.length).toBeGreaterThan(200);
    expect(result.shows.every((show) => show.title.length > 0)).toBe(true);
    // Anime rows use the "Anime" Type column, not "TV Show" -- both must parse, and nothing
    // else (e.g. a Movie row, if the export ever includes one) should slip through.
    expect(result.shows.length).toBe(new Set(result.shows.map((show) => show.key)).size);

    const totalEpisodes = [...result.episodesByShow.values()].reduce((total, episodes) => total + episodes.length, 0);
    expect(totalEpisodes).toBeGreaterThan(1_000);

    const attackOnTitan = result.shows.find((show) => show.title === "Attack on Titan");
    expect(attackOnTitan).toBeDefined();
    expect(result.episodesByShow.get(attackOnTitan!.key)?.length).toBeGreaterThan(0);
  });
});
