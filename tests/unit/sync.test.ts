import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEpisode, ProviderShow, TelevisionProvider } from "../../src/domain/models";
import { DAILY_SYNC_ALARM, METADATA_RETRY_ALARM, checkReleaseNotifications, ensureDailySyncAlarm, ensureMetadataRetryAlarm, runAutomaticSynchronization, shouldRefreshMetadata, synchronize } from "../../src/scheduling/sync";
import { db } from "../../src/storage/database";
import { emptyLocalState, type LocalState } from "../../src/storage/local-state";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("metadata refresh selection", () => {
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
    expect(provider.getShow).toHaveBeenCalledWith(10);
    expect(provider.getEpisodes).toHaveBeenCalledTimes(1);
    expect(provider.getEpisodes).toHaveBeenCalledWith(10);
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

    expect(provider.getShow).toHaveBeenCalledWith(10);
    expect(provider.getShow).toHaveBeenCalledWith(11);
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

describe("release notifications", () => {
  const nowMs = new Date("2026-07-26T12:00:00.000Z").getTime();
  const now = () => nowMs;
  const episode = (overrides: Partial<ProviderEpisode> = {}): ProviderEpisode => ({
    id: 1, showId: 10, season: 1, number: 3, name: "New episode", kind: "regular", airstamp: new Date(nowMs - 3 * 3_600_000).toISOString(), ...overrides,
  });

  it("sets a baseline on first run without notifying", async () => {
    await db.episodes.put(episode());

    await checkReleaseNotifications(now);

    expect(chrome.notifications.create).not.toHaveBeenCalled();
    expect(stored.lastReleaseNotifiedAt).toBe(new Date(nowMs).toISOString());
  });

  it("notifies for a newly released episode of an actively tracked show", async () => {
    stored.lastReleaseNotifiedAt = new Date(nowMs - 4 * 3_600_000).toISOString();
    await db.episodes.put(episode());

    await checkReleaseNotifications(now);

    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(chrome.notifications.create).toHaveBeenCalledWith("release:local-1:1", expect.objectContaining({ title: "Silo" }));
    expect(stored.lastReleaseNotifiedAt).toBe(new Date(nowMs).toISOString());
  });

  it("does not notify for a paused show", async () => {
    stored.shows = [{ ...trackedShow, userState: "paused" }];
    stored.lastReleaseNotifiedAt = new Date(nowMs - 4 * 3_600_000).toISOString();
    await db.episodes.put(episode());

    await checkReleaseNotifications(now);

    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });

  it("skips notifying when disabled but still advances the baseline", async () => {
    stored.settings.notifications = false;
    stored.lastReleaseNotifiedAt = new Date(nowMs - 4 * 3_600_000).toISOString();
    await db.episodes.put(episode());

    await checkReleaseNotifications(now);

    expect(chrome.notifications.create).not.toHaveBeenCalled();
    expect(stored.lastReleaseNotifiedAt).toBe(new Date(nowMs).toISOString());
  });

  it("ignores episodes released before the last check or still in the future", async () => {
    stored.lastReleaseNotifiedAt = new Date(nowMs - 4 * 3_600_000).toISOString();
    await db.episodes.bulkPut([
      episode({ id: 2, airstamp: new Date(nowMs - 5 * 3_600_000).toISOString() }),
      episode({ id: 3, airstamp: new Date(nowMs + 24 * 3_600_000).toISOString() }),
    ]);

    await checkReleaseNotifications(now);

    expect(chrome.notifications.create).not.toHaveBeenCalled();
  });
});
