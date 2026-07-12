// The private fixtures are local-only and excluded from packaged/repository artifacts.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderEpisode, ProviderShow, TelevisionProvider } from "../../src/domain/models";
import { selectUpcomingShows, selectWatchListShows } from "../../src/domain/selectors";
import { selectFixtureSubset } from "../../src/imports/fixture-subset";
import { parseImdbCsv } from "../../src/imports/imdb";
import { buildImportPreview, emptyImportDecisions } from "../../src/imports/preview";
import { analyzeImport } from "../../src/imports/session";
import { parseTvTimeZip } from "../../src/imports/tvtime";
import { emptyLocalState } from "../../src/storage/local-state";

describe("supplied export fixtures", () => {
  const fixtureIt = existsSync("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv")
    && existsSync("initial-data/tvtime-export-2026-07-11.zip") ? it : it.skip;
  fixtureIt("parses the IMDb export", () => {
    const result = parseImdbCsv(readFileSync("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv", "utf8"));
    expect(result.rows).toHaveLength(184); expect(result.malformed).toHaveLength(0); expect(result.unsupported).toHaveLength(0);
  });
  fixtureIt("parses the TV Time archive without rendering its HTML", () => {
    const result = parseTvTimeZip(readFileSync("initial-data/tvtime-export-2026-07-11.zip"));
    expect(result.shows).toHaveLength(213); expect(result.specials).toBe(1953); expect(result.specialFlagMismatches).toBe(45);
    expect(result.shows.flatMap((show) => show.episodes).filter((episode) => episode.watched)).toHaveLength(6090);
  });
  fixtureIt("keeps the deterministic Silo and House of the Dragon fixture regression subset", () => {
    const imdb = parseImdbCsv(readFileSync("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv", "utf8"));
    const tvtime = parseTvTimeZip(readFileSync("initial-data/tvtime-export-2026-07-11.zip"));
    const subset = selectFixtureSubset({ imdbRows: imdb.rows, tvTimeShows: tvtime.shows, newestCount: 20, requiredTitles: ["Silo", "House of the Dragon"] });
    expect(subset.counts).toEqual({
      parsed: { imdbRows: 184, tvTimeShows: 213, tvTimeEpisodes: 8368 },
      selected: { imdbRows: 22, tvTimeShows: 22, tvTimeEpisodes: 433 },
    });
    const sourceCounts = (title: string) => {
      const show = subset.tvTimeShows.find((candidate) => candidate.title === title)!;
      const regular = show.episodes.filter((episode) => !episode.special);
      return {
        total: show.episodes.length,
        regular: regular.length,
        watched: regular.filter((episode) => episode.watched).length,
        unwatched: regular.filter((episode) => !episode.watched).length,
        specials: show.episodes.filter((episode) => episode.special).length,
      };
    };
    expect(sourceCounts("Silo")).toEqual({ total: 34, regular: 30, watched: 20, unwatched: 10, specials: 4 });
    expect(sourceCounts("House of the Dragon")).toEqual({ total: 54, regular: 21, watched: 18, unwatched: 3, specials: 33 });
  });
  fixtureIt("maps the reduced fixture through mocked TVMaze and derives Silo/HOTD Watch List behavior", async () => {
    const imdb = parseImdbCsv(readFileSync("initial-data/98fcfa09-96b4-44c8-ab65-737cacc3572c.csv", "utf8"));
    const tvtime = parseTvTimeZip(readFileSync("initial-data/tvtime-export-2026-07-11.zip"));
    const subset = selectFixtureSubset({ imdbRows: imdb.rows, tvTimeShows: tvtime.shows, newestCount: 20, requiredTitles: ["Silo", "House of the Dragon"] });
    const showsByImdb = new Map<string, ProviderShow>();
    const showsByTvdb = new Map<number, ProviderShow>();
    const episodesByShow = new Map<number, ProviderEpisode[]>();
    const normalize = (value: string) => value.normalize("NFKD").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
    subset.imdbRows.forEach((row, index) => {
      const source = subset.tvTimeShows.find((show) => normalize(show.title) === normalize(row.title));
      expect(source, `TV Time source for ${row.title}`).toBeDefined();
      const id = 10_000 + index;
      const provider: ProviderShow = { provider: "tvmaze", id, name: row.title, status: "running", externalIds: {
        imdb: row.imdbId, ...(source!.tvdbShowId ? { tvdbShow: source!.tvdbShowId } : {}), tvmazeShow: id,
      }, updatedAt: 1 };
      showsByImdb.set(row.imdbId, provider);
      if (source!.tvdbShowId) showsByTvdb.set(source!.tvdbShowId, provider);
      let requiredUnwatchedIndex = 0;
      episodesByShow.set(id, source!.episodes.filter((episode) => !episode.special).map((episode) => {
        const currentUnwatchedIndex = episode.watched ? -1 : requiredUnwatchedIndex++;
        const availableUnwatched = source!.title === "Silo" ? currentUnwatchedIndex < 2
          : source!.title === "House of the Dragon" ? currentUnwatchedIndex < 1
          : false;
        return {
          id: episode.tvdbEpisodeId,
          showId: id,
          tvdbEpisodeId: episode.tvdbEpisodeId,
          season: episode.season,
          number: episode.number,
          name: episode.name,
          kind: "regular" as const,
          airstamp: episode.watched || availableUnwatched ? "2025-01-01T00:00:00Z" : "2027-01-01T00:00:00Z",
        };
      }));
    });
    const provider: TelevisionProvider = {
      lookupByImdbId: async (id) => showsByImdb.get(id) ?? null,
      lookupByTvdbId: async (id) => showsByTvdb.get(id) ?? null,
      getShow: async (id) => [...showsByImdb.values()].find((show) => show.id === id) ?? null,
      getEpisodes: async (id) => episodesByShow.get(id) ?? [],
      getChangedShows: async () => new Map(),
    };
    const settings = { timezone: "UTC", dateOnlyReleaseHour: "09:00" };
    const now = new Date("2026-07-12T12:00:00Z");
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
      }, provider, settings, now,
    });
    expect(analysis.report).toMatchObject({
      showsSelectedByFixture: 22,
      exactImdbMatches: 22,
      exactTvdbMatches: 22,
      successfullyMerged: 22,
      watchedEpisodesMapped: 301,
      explicitUnwatchedEpisodesMapped: 14,
      futureEpisodesExcludedFromBacklog: 11,
      specialsExcluded: 118,
      unresolvedEpisodes: 0,
      providerNetworkErrors: 0,
    });
    const preview = buildImportPreview(analysis, emptyImportDecisions(), { ...emptyLocalState(), settings });
    expect(preview).toMatchObject({ ready: true, committedShows: 22, watchedStates: 301, explicitUnwatchedStates: 14 });
    const tracked = preview.plans.map((plan) => ({ id: plan.recordId, externalIds: plan.provider.externalIds, titleSnapshot: plan.title,
      userState: plan.desiredState, importSources: plan.sources, createdAt: analysis.importedAt, updatedAt: analysis.importedAt }));
    const progress = preview.plans.flatMap((plan) => plan.progress.map((state) => ({ localShowId: plan.recordId, ...state })));
    const domain = { shows: tracked, providerShows: analysis.providerShows, episodes: [...analysis.episodesByShow.values()].flat(), progress, settings };
    const watchList = selectWatchListShows(domain, now);
    const silo = watchList.find((item) => item.show.titleSnapshot === "Silo")!;
    const hotd = watchList.find((item) => item.show.titleSnapshot === "House of the Dragon")!;
    expect(silo).toMatchObject({ episode: { season: 3, number: 1 }, additional: 1 });
    expect(hotd).toMatchObject({ episode: { season: 3, number: 1 }, additional: 0 });
    const upcoming = selectUpcomingShows(domain, now);
    expect(upcoming.find((item) => item.show.titleSnapshot === "Silo")?.episode).toMatchObject({ season: 3, number: 3 });
    expect(upcoming.find((item) => item.show.titleSnapshot === "House of the Dragon")?.episode).toMatchObject({ season: 3, number: 2 });
    const advanced = { ...domain, progress: domain.progress.map((state) => state.localShowId === silo.show.id && state.tvmazeEpisodeId === silo.episode.id
      ? { ...state, watched: true, source: "user" as const }
      : state) };
    expect(selectWatchListShows(advanced, now).find((item) => item.show.titleSnapshot === "Silo")?.episode).toMatchObject({ season: 3, number: 2 });
  });
});
