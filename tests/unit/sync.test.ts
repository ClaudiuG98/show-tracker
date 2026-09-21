import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEpisode, ProviderShow, TelevisionProvider, TrackedShow } from "../../src/domain/models";
import { DAILY_SYNC_ALARM, METADATA_RETRY_ALARM, ensureDailySyncAlarm, ensureMetadataRetryAlarm, NEW_BADGE_TEXT, newReleasesSinceSeen, pulseReleaseBadge, recomputeBadgeAndReleaseAlarm, releaseTooltip, runAutomaticSynchronization, shouldRefreshMetadata, synchronize } from "../../src/scheduling/sync";
import { db } from "../../src/storage/database";
import { emptyLocalState, type LocalState } from "../../src/storage/local-state";
import { TvMazeProvider } from "../../src/providers/tvmaze/provider";

const trackedShow = {
  id: "local-1",
  externalIds: { tvmazeShow: 10 },
  titleSnapshot: "Silo",
  userState: "watching" as const,
  importSources: ["manual" as const],
  providerUpdatedAt: 100,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const providerShow = (updatedAt = 100): ProviderShow => ({
  provider: "tvmaze",
  id: 10,
  name: "Silo",
  status: "running",
  externalIds: { tvmazeShow: 10 },
  detailsLoaded: true,
  metadataVersion: 2,
  updatedAt,
});

function fakeProvider(changed: Map<number, number>): TelevisionProvider {
  return {
    lookupByImdbId: vi.fn(async () => null),
    lookupByTvdbId: vi.fn(async () => null),
    getShow: vi.fn(async () => providerShow(changed.get(10) ?? 100)),
    getEpisodes: vi.fn(async () => []),
    getChangedShows: vi.fn(async () => changed),
  };
}

let stored: LocalState;

beforeEach(async () => {
  stored = {
    ...emptyLocalState(),
    shows: [trackedShow],
    lastSyncAt: "2026-07-25T00:00:00.000Z",
  };
  vi.stubGlobal("chrome", {
    storage: { local: {
      get: vi.fn(async () => ({ trackerState: stored })),
      set: vi.fn(async (value: { trackerState: LocalState }) => { stored = value.trackerState; }),
    } },
    action: {
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setBadgeTextColor: vi.fn(async () => undefined),
      setBadgeText: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    alarms: {
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
    },
    notifications: {
      create: vi.fn(async () => "notification-id"),
    },
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
  });
  await Promise.all([db.providerShows.clear(), db.episodes.clear(), db.cache.clear()]);
  await db.providerShows.put(providerShow());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("metadata refresh selection", () => {
  it("bypasses warm caches for changed shows and refreshes caches for later imports", async () => {
    const oldShow = { id: 10, name: "Silo", status: "Running", updated: 100,
      externals: { imdb: "tt14688458", thetvdb: 403245, tvrage: null } };
    const oldEpisode = { id: 1, name: "Old episode", season: 1, number: 1, type: "regular", airdate: "2026-01-01", airtime: "20:00", airstamp: "2026-01-01T20:00:00Z" };
    let updated = false;
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/updates/shows")) return { "10": 101 };
      if (path.endsWith("/episodes")) return updated ? [oldEpisode, { ...oldEpisode, id: 2, number: 2 }] : [oldEpisode];
      return updated ? { ...oldShow, name: "Updated Silo", updated: 101 } : oldShow;
    });
    const provider = new TvMazeProvider({ request });
    await provider.getShow(10);
    await provider.getEpisodes(10);
    stored.progress = [{ localShowId: trackedShow.id, tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true, source: "user" }];
    const progress = structuredClone(stored.progress);
    updated = true;
    request.mockClear();

    await synchronize(provider);

    expect(request.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(["/shows/10", "/shows/10/episodes"]));
    expect((await db.providerShows.get(10))?.name).toBe("Updated Silo");
    expect(await db.episodes.count()).toBe(2);
    expect(stored.shows[0]?.providerUpdatedAt).toBe(101);
    expect(stored.progress).toEqual(progress);
    request.mockClear();
    await expect(provider.lookupByImdbId("tt14688458")).resolves.toMatchObject({ updatedAt: 101 });
    await expect(provider.getEpisodes(10)).resolves.toHaveLength(2);
    expect(request).not.toHaveBeenCalled();
    await synchronize(provider);
    expect(request.mock.calls.every(([path]) => path.startsWith("/updates/shows"))).toBe(true);
  });

  it.each(["episodes", "missing show", "stale show", "storage"])("keeps failed %s refreshes eligible and preserves saved metadata", async (failure) => {
    const provider = fakeProvider(new Map([[10, 101]]));
    const lastSyncAt = stored.lastSyncAt;
    const oldEpisode: ProviderEpisode = { id: 1, showId: 10, season: 1, number: 1, kind: "regular" };
    await db.episodes.put(oldEpisode);
    if (failure === "episodes") vi.mocked(provider.getEpisodes).mockRejectedValueOnce(new Error("Offline"));
    if (failure === "missing show") vi.mocked(provider.getShow).mockResolvedValueOnce(null);
    if (failure === "stale show") vi.mocked(provider.getShow).mockResolvedValueOnce(providerShow(100));
    if (failure === "storage") vi.spyOn(db.episodes, "bulkPut").mockRejectedValueOnce(new Error("Storage failed"));

    await expect(synchronize(provider)).rejects.toThrow("1 show could not be refreshed.");
    expect(stored.lastSyncAt).toBe(lastSyncAt);
    expect(stored.shows[0]?.providerUpdatedAt).toBe(100);
    expect((await db.providerShows.get(10))?.updatedAt).toBe(100);
    expect(await db.episodes.toArray()).toEqual([oldEpisode]);

    await synchronize(provider);
    expect(stored.shows[0]?.providerUpdatedAt).toBe(101);
    expect(stored.lastSyncAt).not.toBe(lastSyncAt);
  });

  it("preserves retry backoff across repeated per-show failures", async () => {
    const provider = fakeProvider(new Map([[10, 101]]));
    vi.mocked(provider.getEpisodes).mockRejectedValue(new Error("Offline"));
    await runAutomaticSynchronization("daily", provider);
    expect(stored.lastSyncFailure?.attempt).toBe(1);
    await runAutomaticSynchronization("retry", provider);
    expect(stored.lastSyncFailure?.attempt).toBe(2);
    await runAutomaticSynchronization("retry", provider);
    expect(stored.lastSyncFailure?.attempt).toBe(3);
    await runAutomaticSynchronization("retry", provider);
    expect(stored.lastSyncFailure?.attempt).toBe(4);
    expect(stored.lastSyncFailure?.retryAt).toBeUndefined();
  });

  it("skips current metadata when TVMaze omits an unchanged show", () => {
    expect(shouldRefreshMetadata(stored.lastSyncAt, undefined, 100, 2)).toBe(false);
  });

  it("refreshes only missing, outdated, or explicitly changed metadata", () => {
    expect(shouldRefreshMetadata(undefined, undefined, 100, 2)).toBe(true);
    expect(shouldRefreshMetadata(stored.lastSyncAt, undefined, 100, 1)).toBe(true);
    expect(shouldRefreshMetadata(stored.lastSyncAt, 101, 100, 2)).toBe(true);
    expect(shouldRefreshMetadata(stored.lastSyncAt, 100, 100, 2)).toBe(false);
  });

  it("deduplicates overlapping syncs and makes no show requests for unchanged metadata", async () => {
    const provider = fakeProvider(new Map());

    const first = synchronize(provider);
    const second = synchronize(provider);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(provider.getChangedShows).toHaveBeenCalledTimes(1);
    expect(provider.getShow).not.toHaveBeenCalled();
    expect(provider.getEpisodes).not.toHaveBeenCalled();
  });

  it("downloads only a show whose TVMaze timestamp changed", async () => {
    const provider = fakeProvider(new Map([[10, 101]]));

    await synchronize(provider);

    expect(provider.getShow).toHaveBeenCalledTimes(1);
    expect(provider.getShow).toHaveBeenCalledWith(10, { forceRefresh: true });
    expect(provider.getEpisodes).toHaveBeenCalledTimes(1);
    expect(provider.getEpisodes).toHaveBeenCalledWith(10, { forceRefresh: true });
  });

  it("isolates a per-show failure so other shows still refresh, and leaves the failed one eligible for retry", async () => {
    const secondShow = { ...trackedShow, id: "local-2", externalIds: { tvmazeShow: 11 } };
    stored.shows = [trackedShow, secondShow];
    const changed = new Map([[10, 101], [11, 101]]);
    const provider: TelevisionProvider = {
      lookupByImdbId: vi.fn(async () => null),
      lookupByTvdbId: vi.fn(async () => null),
      getShow: vi.fn(async (id: number) => {
        if (id === 11) throw new Error("boom");
        return providerShow(101);
      }),
      getEpisodes: vi.fn(async () => []),
      getChangedShows: vi.fn(async () => changed),
    };

    await expect(synchronize(provider)).rejects.toThrow("1 show could not be refreshed.");

    expect(provider.getShow).toHaveBeenCalledWith(10, { forceRefresh: true });
    expect(provider.getShow).toHaveBeenCalledWith(11, { forceRefresh: true });
    expect(stored.shows.find((show) => show.id === "local-1")?.providerUpdatedAt).toBe(101);
    expect(stored.shows.find((show) => show.id === "local-2")?.providerUpdatedAt).toBe(100);
  });

  it("clears a previous automatic failure after a successful check", async () => {
    stored.lastSyncFailure = {
      failedAt: "2026-07-25T12:00:00.000Z",
      message: "TVMaze could not be reached.",
      retryAt: "2026-07-25T12:30:00.000Z",
      attempt: 1,
    };

    await synchronize(fakeProvider(new Map()));

    expect(stored.lastSyncFailure).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(METADATA_RETRY_ALARM);
  });
});

describe("daily synchronization alarm", () => {
  it("preserves an existing daily alarm instead of moving it one minute ahead", async () => {
    vi.mocked(chrome.alarms.get).mockResolvedValue({ name: DAILY_SYNC_ALARM, scheduledTime: Date.now() + 60_000 });

    await ensureDailySyncAlarm();

    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  it("creates the daily alarm only when it is missing", async () => {
    await ensureDailySyncAlarm();

    expect(chrome.alarms.create).toHaveBeenCalledWith(DAILY_SYNC_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 24 * 60,
    });
  });

  it("records an automatic failure and schedules a quiet retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
    const provider = fakeProvider(new Map());
    vi.mocked(provider.getChangedShows).mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(runAutomaticSynchronization("daily", provider)).resolves.toBe(false);

    expect(stored.lastSyncFailure).toEqual({
      failedAt: "2026-07-26T12:00:00.000Z",
      message: "TVMaze could not be reached. Check your internet connection.",
      retryAt: "2026-07-26T12:30:00.000Z",
      attempt: 1,
    });
    expect(chrome.alarms.create).toHaveBeenCalledWith(METADATA_RETRY_ALARM, {
      when: new Date("2026-07-26T12:30:00.000Z").getTime(),
    });
  });

  it("restores a persisted retry alarm after the background process restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
    stored.lastSyncFailure = {
      failedAt: "2026-07-26T11:30:00.000Z",
      message: "TVMaze could not be reached.",
      retryAt: "2026-07-26T12:30:00.000Z",
      attempt: 1,
    };

    await ensureMetadataRetryAlarm();

    expect(chrome.alarms.create).toHaveBeenCalledWith(METADATA_RETRY_ALARM, {
      when: new Date("2026-07-26T12:30:00.000Z").getTime(),
    });
  });

  it("backs retries off and returns to the daily schedule after three attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));
    const provider = fakeProvider(new Map());
    vi.mocked(provider.getChangedShows).mockRejectedValue(new Error("TVMaze is unavailable."));
    stored.lastSyncFailure = {
      failedAt: "2026-07-26T11:00:00.000Z",
      message: "TVMaze is unavailable.",
      retryAt: "2026-07-26T12:00:00.000Z",
      attempt: 3,
    };

    await expect(runAutomaticSynchronization("retry", provider)).resolves.toBe(false);

    expect(stored.lastSyncFailure).toMatchObject({ message: "TVMaze is unavailable.", attempt: 4 });
    expect(stored.lastSyncFailure?.retryAt).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(METADATA_RETRY_ALARM);
  });
});

describe("in-browser release cues", () => {
  const settings = { timezone: "UTC", dateOnlyReleaseHour: "09:00", notifications: true };
  const show = (id: string, tvmazeShow: number, userState: TrackedShow["userState"] = "watching"): TrackedShow =>
    ({ id, externalIds: { tvmazeShow }, titleSnapshot: `Show ${tvmazeShow}`, userState,
      importSources: ["manual"], createdAt: "2024-01-01", updatedAt: "2024-01-01" });
  const episode = (id: number, showId: number, number: number, airstamp: string): ProviderEpisode =>
    ({ id, showId, season: 3, number, kind: "regular", airstamp });
  const state = (shows: TrackedShow[], lastReleaseSeenAt?: string): LocalState =>
    ({ ...emptyLocalState(), settings, shows, ...(lastReleaseSeenAt ? { lastReleaseSeenAt } : {}) });
  const now = Date.parse("2026-08-16T12:00:00Z");

  it("counts only episodes aired since the dashboard was last opened", () => {
    const episodes = [
      episode(1, 10, 4, "2026-08-15T20:00:00Z"),  // after last seen
      episode(2, 10, 3, "2026-08-10T20:00:00Z"),  // before last seen
      episode(3, 10, 5, "2026-12-01T20:00:00Z"),  // not aired yet
    ];
    const fresh = newReleasesSinceSeen(state([show("a", 10)], "2026-08-14T00:00:00Z"), episodes, now);

    expect(fresh.map((item) => item.episode.id)).toEqual([1]);
  });

  it("stays quiet when the icon alert is switched off", () => {
    const episodes = [episode(1, 10, 4, "2026-08-15T20:00:00Z")];
    const off = { ...state([show("a", 10)], "2026-08-14T00:00:00Z"), settings: { ...settings, notifications: false } };

    expect(newReleasesSinceSeen(off, episodes, now)).toEqual([]);
  });

  it("stays quiet for shows that are not being watched", () => {
    const episodes = [episode(1, 10, 4, "2026-08-15T20:00:00Z")];
    for (const userState of ["paused", "completed", "not_started"] as const) {
      expect(newReleasesSinceSeen(state([show("a", 10, userState)], "2026-08-14T00:00:00Z"), episodes, now)).toEqual([]);
    }
  });

  it("has no baseline before the dashboard has ever been opened", () => {
    const episodes = [episode(1, 10, 4, "2026-08-15T20:00:00Z")];

    expect(newReleasesSinceSeen(state([show("a", 10)]), episodes, now)).toEqual([]);
  });

  it("names the new episodes in the toolbar tooltip and folds the rest away", () => {
    const fresh = [10, 11, 12, 13].map((tvmazeShow, index) =>
      ({ show: show(`s${index}`, tvmazeShow), episode: episode(index, tvmazeShow, index + 1, "2026-08-15T20:00:00Z") }));

    expect(releaseTooltip(fresh).split("\n")).toEqual([
      "4 new episodes", "Show 10 — S03 · E01", "Show 11 — S03 · E02", "Show 12 — S03 · E03", "and 1 more",
    ]);
    expect(releaseTooltip([])).toBe("Open TV Show Tracker");
  });

  it("marks the badge instead of showing the waiting count until the releases have been seen", async () => {
    const badge: Array<{ text: string; color: string }> = [];
    let color = "";
    vi.stubGlobal("chrome", {
      action: {
        setBadgeBackgroundColor: vi.fn(async (d: { color: string }) => { color = d.color; }),
        setBadgeTextColor: vi.fn(async () => undefined),
        setBadgeText: vi.fn(async (d: { text: string }) => { badge.push({ text: d.text, color }); }),
        setTitle: vi.fn(async () => undefined),
      },
      alarms: { clear: vi.fn(async () => undefined), create: vi.fn(async () => undefined) },
      storage: { local: { get: vi.fn(async () => ({ trackerState: stored })), set: vi.fn(async () => undefined) } },
    });
    const aired = episode(900, 10, 4, "2026-08-15T20:00:00Z");
    await db.providerShows.put({ provider: "tvmaze", id: 10, name: "Show 10", status: "running",
      externalIds: { tvmazeShow: 10 }, updatedAt: 1 });
    await db.episodes.put(aired);

    stored = state([show("a", 10)], "2026-08-14T00:00:00Z");
    await recomputeBadgeAndReleaseAlarm();
    expect(badge.at(-1)).toMatchObject({ text: NEW_BADGE_TEXT, color: "#e03131" });
    expect(NEW_BADGE_TEXT).toHaveLength(1);

    // Opening the dashboard stamps "seen", and the badge falls back to the waiting count.
    stored = state([show("a", 10)], "2026-08-16T18:00:00Z");
    await recomputeBadgeAndReleaseAlarm();
    expect(badge.at(-1)?.text).not.toBe(NEW_BADGE_TEXT);
    expect(badge.at(-1)?.color).toBe("#f5c518");
  });

  it("hands the new releases back so callers need not rescan the episode table", async () => {
    vi.stubGlobal("chrome", {
      action: {
        setBadgeBackgroundColor: vi.fn(async () => undefined), setBadgeTextColor: vi.fn(async () => undefined),
        setBadgeText: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined),
      },
      alarms: { clear: vi.fn(async () => undefined), create: vi.fn(async () => undefined) },
      storage: { local: { get: vi.fn(async () => ({ trackerState: stored })), set: vi.fn(async () => undefined) } },
    });
    await db.providerShows.put({ provider: "tvmaze", id: 10, name: "Show 10", status: "running",
      externalIds: { tvmazeShow: 10 }, updatedAt: 1 });
    await db.episodes.put(episode(900, 10, 4, "2026-08-15T20:00:00Z"));
    stored = state([show("a", 10)], "2026-08-14T00:00:00Z");

    const fresh = await recomputeBadgeAndReleaseAlarm();

    expect(fresh.map((item) => item.episode.id)).toEqual([900]);
  });

  it("flashes only the colour and leaves the badge marked", async () => {
    const text: string[] = [], colors: string[] = [];
    vi.stubGlobal("chrome", { action: {
      setBadgeText: vi.fn(async ({ text: value }: { text: string }) => { text.push(value); }),
      setBadgeBackgroundColor: vi.fn(async ({ color }: { color: string }) => { colors.push(color); }),
    } });

    await pulseReleaseBadge(async () => undefined);

    // The reading never changes mid-flash; only the colour alternates, ending on the alert one.
    expect(text).toEqual([NEW_BADGE_TEXT]);
    expect(colors).toHaveLength(10);
    expect(colors.at(-1)).toBe("#e03131");
  });
});
