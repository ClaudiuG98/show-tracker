import { zipSync, strToU8 } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEpisode, ProviderShow, TelevisionProvider } from "../../src/domain/models";
import { selectUpcomingShows, selectWatchListShows } from "../../src/domain/selectors";
import { commitImport } from "../../src/imports/commit";
import type { ImdbImportRow } from "../../src/imports/imdb";
import { buildImportPreview, emptyImportDecisions } from "../../src/imports/preview";
import { analyzeImport, selectFullImportSources, type SelectedImportSources } from "../../src/imports/session";
import { parseTvTimeZip, type TvTimeShow } from "../../src/imports/tvtime";
import { db } from "../../src/storage/database";
import { emptyLocalState, type LocalState } from "../../src/storage/local-state";

const settings = { timezone: "UTC", dateOnlyReleaseHour: "09:00" };
const now = new Date("2025-01-10T12:00:00Z");

function providerShow(id = 100): ProviderShow {
  return {
    provider: "tvmaze",
    id,
    name: "Silo",
    status: "running",
    externalIds: { imdb: "tt1", tvdbShow: 10, tvmazeShow: id },
    updatedAt: 123,
  };
}

const episodes: ProviderEpisode[] = [
  { id: 1, showId: 100, season: 1, number: 1, name: "One", kind: "regular", airstamp: "2025-01-01T00:00:00Z" },
  { id: 2, showId: 100, season: 1, number: 2, name: "Two", kind: "regular", airstamp: "2025-01-02T00:00:00Z" },
  { id: 3, showId: 100, season: 1, number: 3, name: "Future", kind: "regular", airstamp: "2025-02-01T00:00:00Z" },
  { id: 4, showId: 100, season: 0, number: 1, name: "Special", kind: "special", airstamp: "2025-01-01T00:00:00Z" },
];

function imdbRow(): ImdbImportRow {
  return { imdbId: "tt1", title: "Silo", titleType: "series", created: "2024-01-01" };
}

function tvTimeShow(): TvTimeShow {
  return {
    uuid: "tv-silo",
    tvdbShowId: 10,
    title: "Silo",
    createdAt: "2024-01-01T00:00:00Z",
    status: "continuing",
    episodes: [
      { tvdbEpisodeId: 101, season: 1, number: 1, name: "One", special: false, watched: true, watchedAt: "2025-01-03T00:00:00Z", rewatchCount: 2 },
      { tvdbEpisodeId: 102, season: 1, number: 2, name: "Two", special: false, watched: false, rewatchCount: 0 },
      { tvdbEpisodeId: 103, season: 1, number: 3, name: "Future", special: false, watched: false, rewatchCount: 0 },
      { tvdbEpisodeId: 104, season: 0, number: 1, name: "Special", special: true, watched: true, rewatchCount: 0 },
    ],
  };
}

function selected(imdbRows: ImdbImportRow[] = [imdbRow()], tvTimeShows: TvTimeShow[] = [tvTimeShow()]): SelectedImportSources {
  return {
    imdbRows,
    tvTimeShows,
    fixtureSubsetMode: false,
    counts: {
      imdbRowsParsed: imdbRows.length,
      tvTimeShowsParsed: tvTimeShows.length,
      tvTimeEpisodesParsed: tvTimeShows.reduce((total, show) => total + show.episodes.length, 0),
      imdbRowsSelected: imdbRows.length,
      tvTimeShowsSelected: tvTimeShows.length,
      tvTimeEpisodesSelected: tvTimeShows.reduce((total, show) => total + show.episodes.length, 0),
    },
  };
}

class FakeProvider implements TelevisionProvider {
  failEpisodes = 0;
  imdbCalls = 0;
  tvdbCalls = 0;
  episodeCalls = 0;
  async lookupByImdbId() { this.imdbCalls++; return providerShow(); }
  async lookupByTvdbId() { this.tvdbCalls++; return providerShow(); }
  async getShow() { return providerShow(); }
  async getEpisodes() {
    this.episodeCalls++;
    if (this.failEpisodes-- > 0) throw new Error("temporary episode outage");
    return episodes;
  }
  async getChangedShows() { return new Map<number, number>(); }
}

let stored: LocalState | undefined;

beforeEach(async () => {
  stored = undefined;
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: vi.fn(async () => stored ? { trackerState: stored } : {}),
      set: vi.fn(async (value: { trackerState: LocalState }) => { stored = value.trackerState; }),
    } },
  });
  await Promise.all([db.providerShows.clear(), db.episodes.clear(), db.cache.clear(), db.stagedImports.clear()]);
});

describe("staged import analysis and commit", () => {
  it("merges exact IMDb and TVDB resolutions and applies active TV Time progress", async () => {
    const analysis = await analyzeImport({ selected: selected(), provider: new FakeProvider(), settings, now });

    expect(analysis.records).toHaveLength(1);
    expect(analysis.records[0]).toMatchObject({ kind: "matched", provider: { id: 100 } });
    expect(analysis.report).toMatchObject({
      exactImdbMatches: 1,
      exactTvdbMatches: 1,
      successfullyMerged: 1,
      watchedEpisodesMapped: 1,
      explicitUnwatchedEpisodesMapped: 2,
      futureEpisodesExcludedFromBacklog: 1,
      specialsExcluded: 1,
      providerNetworkErrors: 0,
    });

    const local = { ...emptyLocalState(), settings };
    const preview = buildImportPreview(analysis, emptyImportDecisions(), local);
    expect(preview.ready).toBe(true);
    expect(preview.plans[0]).toMatchObject({ desiredState: "watching" });

    const result = await commitImport(analysis, preview, emptyImportDecisions());
    expect(result).toMatchObject({ committed: 1, watchedMapped: 1, explicitUnwatchedMapped: 2 });
    expect(stored?.shows).toHaveLength(1);
    expect(stored?.shows[0]?.userState).toBe("watching");
    expect(stored?.progress.map((state) => [state.tvmazeEpisodeId, state.watched, state.source])).toEqual([
      [1, true, "tvtime"], [2, false, "tvtime"], [3, false, "tvtime"],
    ]);

    const domain = { shows: stored!.shows, progress: stored!.progress, settings, providerShows: [providerShow()], episodes };
    expect(selectWatchListShows(domain, now)[0]?.episode.id).toBe(2);
    expect(selectWatchListShows(domain, now)[0]?.additional).toBe(0);
    expect(selectUpcomingShows(domain, now)[0]?.episode.id).toBe(3);
  });

  it("turns a TV Time-only ZIP into a selectable, usable reconciliation record", async () => {
    const raw = [{
      uuid: "only", id: { tvdb: 10, imdb: null }, created_at: "2024-01-01T00:00:00Z", title: "Silo",
      status: "continuing", is_favorite: false, _noEpisodeData: false,
      seasons: [{ number: 1, is_specials: false, episodes: [{ id: { tvdb: 101, imdb: null }, number: 1, name: "One", special: false,
        is_watched: true, watched_at: "2025-01-03T00:00:00Z", rewatch_count: 0, watched_count: 1 }] }],
    }];
    const parsed = parseTvTimeZip(zipSync({ "export/tvtime-series-test.json": strToU8(JSON.stringify(raw)) }));
    const analysis = await analyzeImport({ selected: selectFullImportSources(undefined, parsed), provider: new FakeProvider(), settings, now });
    expect(analysis.records).toMatchObject([{ kind: "tvtime_only", progress: { watchedMapped: 1 } }]);

    const decisions = { ...emptyImportDecisions(), tvTimeOnlyReviewed: true, includeTvTimeOnlyRecordIds: [analysis.records[0]!.id] };
    const preview = buildImportPreview(analysis, decisions, { ...emptyLocalState(), settings });
    expect(preview.ready).toBe(true);
    expect(preview.plans).toHaveLength(1);
    expect(preview.plans[0]?.desiredState).not.toBe("progress_unknown");
    await commitImport(analysis, preview, decisions);
    expect(stored?.shows).toHaveLength(1);
    expect(stored?.shows[0]).toMatchObject({ titleSnapshot: "Silo", userState: "watching" });
    expect(stored?.progress).toMatchObject([{ tvmazeEpisodeId: 1, watched: true, source: "tvtime" }]);
  });

  it("reports a TV Time-only exact IMDb fallback match", async () => {
    const { tvdbShowId: _tvdbShowId, ...base } = tvTimeShow();
    const source: TvTimeShow = { ...base, imdbId: "tt1" };
    const analysis = await analyzeImport({ selected: selected([], [source]), provider: new FakeProvider(), settings, now });
    expect(analysis.report).toMatchObject({ exactImdbMatches: 1, exactTvdbMatches: 0, tvTimeOnly: 1 });
    expect(analysis.records[0]).toMatchObject({ kind: "tvtime_only", provider: { id: 100 } });
  });

  it("does not commit after a required provider failure and succeeds after Retry", async () => {
    const initial = { ...emptyLocalState(), settings };
    stored = initial;
    const provider = new FakeProvider();
    provider.failEpisodes = 1;

    const failed = await analyzeImport({ selected: selected(), provider, settings, now });
    expect(failed.report.providerErrors).toMatchObject([{ code: "episode_metadata_failed", recordName: "Silo" }]);
    const failedPreview = buildImportPreview(failed, emptyImportDecisions(), initial);
    expect(failedPreview.ready).toBe(false);
    await expect(commitImport(failed, failedPreview, emptyImportDecisions())).rejects.toThrow("required provider requests");
    expect(stored).toEqual(initial);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(await db.providerShows.count()).toBe(0);
    expect(await db.episodes.count()).toBe(0);
    expect(await db.stagedImports.count()).toBe(0);

    const retried = await analyzeImport({ selected: selected(), provider, settings, now });
    expect(retried.report.providerErrors).toHaveLength(0);
    const retryPreview = buildImportPreview(retried, emptyImportDecisions(), initial);
    await expect(commitImport(retried, retryPreview, emptyImportDecisions())).resolves.toMatchObject({ committed: 1 });
    expect(stored?.shows).toHaveLength(1);
    expect(provider.episodeCalls).toBe(2);
  });

  it("requires explicit review before committing unresolved progress", async () => {
    const source = tvTimeShow();
    source.episodes.push({ tvdbEpisodeId: 999, season: 9, number: 9, name: "Unresolved", special: false, watched: true, rewatchCount: 0 });
    const analysis = await analyzeImport({ selected: selected([imdbRow()], [source]), provider: new FakeProvider(), settings, now });
    expect(analysis.report.unresolvedEpisodes).toBe(1);
    const local = { ...emptyLocalState(), settings };
    expect(buildImportPreview(analysis, emptyImportDecisions(), local)).toMatchObject({ ready: false });
    const reviewed = { ...emptyImportDecisions(), unresolvedReviewed: true };
    expect(buildImportPreview(analysis, reviewed, local)).toMatchObject({ ready: true, committedShows: 1 });
  });

  it("lets an explicit TV Time unwatched state replace an older IMDb assumption", async () => {
    const analysis = await analyzeImport({ selected: selected(), provider: new FakeProvider(), settings, now });
    const local: LocalState = {
      ...emptyLocalState(), settings,
      shows: [{ id: "local", externalIds: providerShow().externalIds, titleSnapshot: "Silo", userState: "caught_up", importSources: ["imdb"], createdAt: "2024-01-01", updatedAt: "2024-01-01" }],
      progress: [{ localShowId: "local", tvmazeEpisodeId: 2, season: 1, episode: 2, watched: true, source: "assumption" }],
    };
    stored = local;
    const decisions = emptyImportDecisions();
    const preview = buildImportPreview(analysis, decisions, local);
    expect(preview.localProgressConflicts).toHaveLength(0);
    await commitImport(analysis, preview, decisions);
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 2)).toMatchObject({ watched: false, source: "tvtime" });
  });

  it("does not erase prior TV Time history during an IMDb-only reimport", async () => {
    const analysis = await analyzeImport({ selected: selected([imdbRow()], []), provider: new FakeProvider(), settings, now });
    const local: LocalState = {
      ...emptyLocalState(), settings,
      shows: [{ id: "local", externalIds: providerShow().externalIds, titleSnapshot: "Silo", userState: "watching", importSources: ["imdb", "tvtime"], createdAt: "2024-01-01", updatedAt: "2024-01-01" }],
      progress: [{ localShowId: "local", tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true, watchedAt: "2024-05-01T00:00:00Z", source: "tvtime", rewatchCount: 3 }],
    };
    stored = local;
    const decisions = { ...emptyImportDecisions(), progressChoices: { [analysis.records[0]!.id]: { kind: "not_started" as const } } };
    const preview = buildImportPreview(analysis, decisions, local);
    expect(preview.ready).toBe(true);
    await commitImport(analysis, preview, decisions);
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 1)).toMatchObject({ watched: true, source: "tvtime", rewatchCount: 3 });
  });

  it("preserves a conflicting explicit local decision unless final preview approves replacement", async () => {
    const analysis = await analyzeImport({ selected: selected(), provider: new FakeProvider(), settings, now });
    const local: LocalState = {
      ...emptyLocalState(), settings,
      shows: [{ id: "local", externalIds: providerShow().externalIds, titleSnapshot: "Silo", userState: "watching", userStateSource: "user", importSources: ["imdb"], createdAt: "2024-01-01", updatedAt: "2025-01-09" }],
      progress: [
        { localShowId: "local", tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true, source: "user", watchedAt: "2025-01-09T00:00:00Z" },
        { localShowId: "local", tvmazeEpisodeId: 2, season: 1, episode: 2, watched: true, source: "user", watchedAt: "2025-01-09T00:00:00Z" },
      ],
    };
    stored = local;
    const firstDecisions = emptyImportDecisions();
    const firstPreview = buildImportPreview(analysis, firstDecisions, local);
    expect(firstPreview.localProgressConflicts).toHaveLength(1);
    await commitImport(analysis, firstPreview, firstDecisions);
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 2)).toMatchObject({ watched: true, source: "user" });
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 1)).toMatchObject({ watched: true, source: "user" });
    expect(stored?.shows[0]?.userStateSource).toBe("user");

    const replacementKey = firstPreview.localProgressConflicts[0]!.key;
    const approved = { ...firstDecisions, replaceLocalProgressKeys: [replacementKey] };
    const approvedPreview = buildImportPreview(analysis, approved, stored!);
    await commitImport(analysis, approvedPreview, approved);
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 2)).toMatchObject({ watched: false, source: "tvtime" });
    expect(stored?.progress.find((state) => state.tvmazeEpisodeId === 1)?.source).toBe("user");
  });

  it("surfaces a storage commit failure without replacing existing local tracker state", async () => {
    const analysis = await analyzeImport({ selected: selected(), provider: new FakeProvider(), settings, now });
    const initial = { ...emptyLocalState(), settings };
    stored = initial;
    const preview = buildImportPreview(analysis, emptyImportDecisions(), initial);
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error("quota unavailable"));

    await expect(commitImport(analysis, preview, emptyImportDecisions())).rejects.toThrow("metadata were restored");
    expect(stored).toEqual(initial);
    expect(await db.providerShows.count()).toBe(0);
    expect(await db.episodes.count()).toBe(0);
  });
});
