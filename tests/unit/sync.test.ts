import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderShow, TelevisionProvider } from "../../src/domain/models";
import { DAILY_SYNC_ALARM, METADATA_RETRY_ALARM, ensureDailySyncAlarm, ensureMetadataRetryAlarm, runAutomaticSynchronization, shouldRefreshMetadata, synchronize } from "../../src/scheduling/sync";
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
