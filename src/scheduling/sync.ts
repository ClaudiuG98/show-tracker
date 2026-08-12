import { db } from "../storage/database";
import { readLocalState, updateLocalState } from "../storage/local-state";
import { TvMazeProvider } from "../providers/tvmaze/provider";
import { episodeReleaseInstant } from "../domain/availability";
import { selectWatchListShows, type DomainState } from "../domain/selectors";
import type { TelevisionProvider } from "../domain/models";

const provider = new TvMazeProvider();
export const DAILY_SYNC_ALARM = "daily-metadata-sync";
export const METADATA_RETRY_ALARM = "metadata-sync-retry";
export const RELEASE_ALARM = "next-episode-release";
const RETRY_DELAYS_MINUTES = [30, 2 * 60, 6 * 60] as const;
let synchronization: Promise<void> | undefined;

function windowFor(last?: string): "day" | "week" | "month" | "all" {
  if (!last) return "all";
  const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
  return days <= 2 ? "day" : days <= 8 ? "week" : days <= 32 ? "month" : "all";
}

export function shouldRefreshMetadata(lastSyncAt: string | undefined, changedAt: number | undefined, providerUpdatedAt: number | undefined, metadataVersion: number | undefined) {
  return !lastSyncAt || (metadataVersion ?? 0) < 2 || (changedAt !== undefined && changedAt !== providerUpdatedAt);
}

async function runSynchronization(syncProvider: TelevisionProvider) {
  const local = await readLocalState();
  const [changed, storedProviderShows] = await Promise.all([syncProvider.getChangedShows(windowFor(local.lastSyncAt)), db.providerShows.toArray()]);
  const storedById = new Map(storedProviderShows.map((show) => [show.id, show]));
  // One show failing (rate limit exhausted, transient network error, ...) must not stop every
  // other show behind it in the loop from being refreshed -- isolate failures per show instead.
  const failedIds = new Set<number>();
  for (const show of local.shows) {
    const id = show.externalIds.tvmazeShow;
    if (!id || !shouldRefreshMetadata(local.lastSyncAt, changed.get(id), show.providerUpdatedAt, storedById.get(id)?.metadataVersion)) continue;
    try {
      const [metadata, episodes] = await Promise.all([syncProvider.getShow(id), syncProvider.getEpisodes(id)]);
      if (metadata) await db.transaction("rw", db.providerShows, db.episodes, async () => {
        await db.providerShows.put(metadata);
        await db.episodes.where("showId").equals(id).delete();
        await db.episodes.bulkPut(episodes);
      });
    } catch {
      failedIds.add(id);
    }
  }
  await updateLocalState((value) => {
    const { lastSyncFailure: _lastSyncFailure, ...current } = value;
    const checkedAt = new Date().toISOString();
    return { ...current, lastSyncAt: checkedAt, shows: value.shows.map((show) => {
      const tvmazeId = show.externalIds.tvmazeShow;
      // Don't mark a show as up to date if its refresh failed -- leave it eligible so the next
      // sync (automatic retry or a manual "Check for updates") tries it again.
      const updated = tvmazeId && !failedIds.has(tvmazeId) ? changed.get(tvmazeId) : undefined;
      return updated ? { ...show, providerUpdatedAt: updated, updatedAt: checkedAt } : show;
    }) };
  });
  await chrome.alarms.clear(METADATA_RETRY_ALARM);
  await recomputeBadgeAndReleaseAlarm();
  if (failedIds.size > 0) throw new Error(`${failedIds.size} show${failedIds.size === 1 ? "" : "s"} could not be refreshed.`);
}

export function synchronize(syncProvider: TelevisionProvider = provider) {
  if (synchronization) return synchronization;
  synchronization = runSynchronization(syncProvider).finally(() => { synchronization = undefined; });
  return synchronization;
}

function readableSyncError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  if (!message || /failed to fetch|networkerror|network request failed/i.test(message)) {
    return "TVMaze could not be reached. Check your internet connection.";
  }
  return message.slice(0, 240);
}

export async function runAutomaticSynchronization(trigger: "daily" | "retry", syncProvider: TelevisionProvider = provider) {
  try {
    await synchronize(syncProvider);
    return true;
  } catch (cause) {
    const failedAt = new Date();
    let retryAt: Date | undefined;
    await updateLocalState((state) => {
      const attempt = trigger === "daily" ? 1 : (state.lastSyncFailure?.attempt ?? 0) + 1;
      const delay = RETRY_DELAYS_MINUTES[attempt - 1];
      retryAt = delay === undefined ? undefined : new Date(failedAt.getTime() + delay * 60_000);
      return { ...state, lastSyncFailure: {
        failedAt: failedAt.toISOString(),
        message: readableSyncError(cause),
        ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
        attempt,
      } };
    });
    if (retryAt) await chrome.alarms.create(METADATA_RETRY_ALARM, { when: retryAt.getTime() });
    else await chrome.alarms.clear(METADATA_RETRY_ALARM);
    return false;
  }
}

export async function ensureDailySyncAlarm() {
  if (!await chrome.alarms.get(DAILY_SYNC_ALARM)) {
    await chrome.alarms.create(DAILY_SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  }
}

export async function ensureMetadataRetryAlarm() {
  const failure = (await readLocalState()).lastSyncFailure;
  if (!failure?.retryAt || await chrome.alarms.get(METADATA_RETRY_ALARM)) return;
  const retryAt = new Date(failure.retryAt).getTime();
  if (!Number.isFinite(retryAt)) return;
  await chrome.alarms.create(METADATA_RETRY_ALARM, { when: Math.max(retryAt, Date.now() + 60_000) });
}

export async function ensureSyncAlarms() {
  await ensureDailySyncAlarm();
  await ensureMetadataRetryAlarm();
  await recomputeBadgeAndReleaseAlarm();
}

export async function checkReleaseNotifications(now: () => number = Date.now) {
  if (typeof chrome === "undefined" || !chrome.notifications) return;
  const local = await readLocalState();
  const nowInstant = new Date(now()), nowIso = nowInstant.toISOString();
  if (!local.settings.notifications || !local.lastReleaseNotifiedAt) {
    await updateLocalState((state) => ({ ...state, lastReleaseNotifiedAt: nowIso }));
    return;
  }
  const since = new Date(local.lastReleaseNotifiedAt).getTime();
  const episodes = await db.episodes.toArray();
  const activeShowByTvmazeId = new Map(local.shows
    .filter((show) => !["paused", "not_started", "completed", "progress_unknown"].includes(show.userState))
    .flatMap((show) => show.externalIds.tvmazeShow ? [[show.externalIds.tvmazeShow, show] as const] : []));
  const released = episodes
    .filter((episode) => episode.kind === "regular" && activeShowByTvmazeId.has(episode.showId))
    .flatMap((episode) => {
      const instant = episodeReleaseInstant(episode, local.settings.timezone, local.settings.dateOnlyReleaseHour)?.getTime();
      return instant !== undefined && instant > since && instant <= nowInstant.getTime()
        ? [{ episode, instant, show: activeShowByTvmazeId.get(episode.showId)! }] : [];
    })
    .sort((a, b) => a.instant - b.instant);
  for (const { show, episode } of released.slice(0, 5)) {
    await chrome.notifications.create(`release:${show.id}:${episode.id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: show.titleSnapshot,
      message: `S${String(episode.season).padStart(2, "0")} · E${String(episode.number).padStart(2, "0")}${episode.name ? ` — ${episode.name}` : ""} is now available.`,
    });
  }
  await updateLocalState((state) => ({ ...state, lastReleaseNotifiedAt: nowIso }));
}

export async function recomputeBadgeAndReleaseAlarm() {
  const [local, providerShows, episodes] = await Promise.all([readLocalState(), db.providerShows.toArray(), db.episodes.toArray()]);
  const state: DomainState = { shows: local.shows, progress: local.progress, settings: local.settings, providerShows, episodes };
  const count = selectWatchListShows(state).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#f5c518" });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#111111" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
  const now = Date.now();
  const nearest = episodes.filter((episode) => episode.kind === "regular")
    .map((episode) => episodeReleaseInstant(episode, local.settings.timezone, local.settings.dateOnlyReleaseHour)?.getTime())
    .filter((instant): instant is number => typeof instant === "number" && instant > now).sort((a, b) => a - b)[0];
  await chrome.alarms.clear(RELEASE_ALARM);
  if (nearest) await chrome.alarms.create(RELEASE_ALARM, { when: nearest });
}
