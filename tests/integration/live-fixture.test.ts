import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectFixtureSubset } from "../../src/imports/fixture-subset";
import { parseImdbCsv } from "../../src/imports/imdb";
import { analyzeImport } from "../../src/imports/session";
import { parseTvTimeZip } from "../../src/imports/tvtime";
import { TvMazeProvider } from "../../src/providers/tvmaze/provider";
import { db } from "../../src/storage/database";

describe("optional live TVMaze fixture smoke", () => {
  const liveIt = process.env.RUN_LIVE_FIXTURE === "1" ? it : it.skip;
  liveIt("prints the current reduced-fixture reconciliation report", async () => {
    await db.cache.clear();
    const imdb = parseImdbCsv(readFileSync("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv", "utf8"));
    const tvtime = parseTvTimeZip(readFileSync("initial-data/tvtime-export-2026-07-11.zip"));
    const subset = selectFixtureSubset({ imdbRows: imdb.rows, tvTimeShows: tvtime.shows, newestCount: 20, requiredTitles: ["Silo", "House of the Dragon"] });
    const analysis = await analyzeImport({
      selected: {
        imdbRows: subset.imdbRows,
        tvTimeShows: subset.tvTimeShows,
        fixtureSubsetMode: true,
        counts: {
          imdbRowsParsed: imdb.totalRows,
          tvTimeShowsParsed: tvtime.shows.length,
          tvTimeEpisodesParsed: tvtime.shows.reduce((total, show) => total + show.episodes.length, 0),
          imdbRowsSelected: subset.imdbRows.length,
          tvTimeShowsSelected: subset.tvTimeShows.length,
          tvTimeEpisodesSelected: subset.counts.selected.tvTimeEpisodes,
        },
      },
      provider: new TvMazeProvider(),
      settings: { timezone: "Europe/Bucharest", dateOnlyReleaseHour: "09:00" },
      now: new Date("2026-07-12T12:00:00+03:00"),
    });
    const required = analysis.records.filter((record) => record.tvtime?.title === "Silo" || record.tvtime?.title === "House of the Dragon").map((record) => ({
      title: record.tvtime!.title,
      kind: record.kind,
      provider: record.provider?.id,
      providerEpisodes: record.episodes.length,
      watchedMapped: record.progress?.watchedMapped ?? 0,
      explicitUnwatchedMapped: record.progress?.explicitUnwatchedMapped ?? 0,
      futureExcluded: record.progress?.futureUnwatchedExcluded ?? 0,
      specialsExcluded: record.progress?.specialsExcluded ?? 0,
      unresolved: record.progress?.unresolved.length ?? 0,
    }));
    expect(analysis.report).toMatchObject({ exactImdbMatches: 22, exactTvdbMatches: 22, successfullyMerged: 22,
      watchedEpisodesMapped: 301, explicitUnwatchedEpisodesMapped: 14, unresolvedEpisodes: 0, providerNetworkErrors: 0 });
    expect(required).toMatchObject([
      { title: "Silo", watchedMapped: 20, explicitUnwatchedMapped: 10, unresolved: 0 },
      { title: "House of the Dragon", watchedMapped: 18, explicitUnwatchedMapped: 3, unresolved: 0 },
    ]);
    console.log(`LIVE_FIXTURE_REPORT=${JSON.stringify({ report: analysis.report, required })}`);
  }, 180_000);
});
