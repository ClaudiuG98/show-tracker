import { db } from "../storage/database";
import { readLocalState, updateLocalState } from "../storage/local-state";
import { TvMazeProvider } from "../providers/tvmaze/provider";
import { episodeReleaseInstant } from "../domain/availability";
import { selectWatchListShows, type DomainState } from "../domain/selectors";
import type { ProviderEpisode, TelevisionProvider, TrackedShow } from "../domain/models";
import type { LocalState } from "../storage/local-state";

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
  const refreshed = new Map<number, number>();
  for (const show of local.shows) {
    const id = show.externalIds.tvmazeShow;
    if (!id || !shouldRefreshMetadata(local.lastSyncAt, changed.get(id), show.providerUpdatedAt, storedById.get(id)?.metadataVersion)) continue;
    try {
      const [metadata, episodes] = await Promise.all([
        syncProvider.getShow(id, { forceRefresh: true }), syncProvider.getEpisodes(id, { forceRefresh: true }),
      ]);
      if (!metadata || metadata.updatedAt < (changed.get(id) ?? 0)) throw new Error("Updated show metadata is not available yet.");
      await db.transaction("rw", db.providerShows, db.episodes, async () => {
        await db.providerShows.put(metadata);
        await db.episodes.where("showId").equals(id).delete();
        await db.episodes.bulkPut(episodes);
      });
      refreshed.set(id, metadata.updatedAt);
    } catch {
      failedIds.add(id);
    }
  }
  await updateLocalState((value) => {
    const { lastSyncFailure: _lastSyncFailure, ...current } = value;
    const checkedAt = new Date().toISOString();
    return { ...(failedIds.size > 0 ? value : current), ...(failedIds.size === 0 ? { lastSyncAt: checkedAt } : {}), shows: value.shows.map((show) => {
      const tvmazeId = show.externalIds.tvmazeShow;
      // Don't mark a show as up to date if its refresh failed -- leave it eligible so the next
      // sync (automatic retry or a manual "Check for updates") tries it again.
      const updated = tvmazeId ? refreshed.get(tvmazeId) : undefined;
      return updated !== undefined ? { ...show, providerUpdatedAt: updated, updatedAt: checkedAt } : show;
    }) };
  });
  if (failedIds.size === 0) await chrome.alarms.clear(METADATA_RETRY_ALARM);
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


const ACTIVE_STATES_EXCLUDED = ["paused", "not_started", "completed", "progress_unknown"];

export interface NewRelease { show: TrackedShow; episode: ProviderEpisode }

/**
 * Episodes of shows being watched that aired since the dashboard was last opened.
 *
 * Opening the tracker is what makes a release stop being news. Before the dashboard has been
 * opened once there is no baseline, so nothing counts as new.
 */
export function newReleasesSinceSeen(local: LocalState, episodes: ProviderEpisode[], now = Date.now()): NewRelease[] {
  if (!local.settings.notifications || !local.lastReleaseSeenAt) return [];
  const since = new Date(local.lastReleaseSeenAt).getTime();
  if (Number.isNaN(since)) return [];
  const watching = new Map(local.shows
    .filter((show) => !ACTIVE_STATES_EXCLUDED.includes(show.userState))
    .flatMap((show) => show.externalIds.tvmazeShow ? [[show.externalIds.tvmazeShow, show] as const] : []));
  return episodes
    .filter((episode) => episode.kind === "regular" && watching.has(episode.showId))
    .flatMap((episode) => {
      const instant = episodeReleaseInstant(episode, local.settings.timezone, local.settings.dateOnlyReleaseHour)?.getTime();
      return instant !== undefined && instant > since && instant <= now
        ? [{ show: watching.get(episode.showId)!, episode, instant }] : [];
    })
    .sort((a, b) => b.instant - a.instant)
    .map(({ show, episode }) => ({ show, episode }));
}

export function releaseTooltip(fresh: NewRelease[]) {
  if (fresh.length === 0) return "Open TV Show Tracker";
  const lines = fresh.slice(0, 3).map(({ show, episode }) =>
    `${show.titleSnapshot} — S${String(episode.season).padStart(2, "0")} · E${String(episode.number).padStart(2, "0")}`);
  if (fresh.length > 3) lines.push(`and ${fresh.length - 3} more`);
  return [`${fresh.length} new episode${fresh.length === 1 ? "" : "s"}`, ...lines].join("\n");
}

// A single character: Chrome shrinks badge text to fit, and anything longer buries the icon.
// The red carries the meaning; the tooltip names the actual episodes.
export const NEW_BADGE_TEXT = "!";
const NEW_BADGE_COLOR = "#e03131";
const COUNT_BADGE_COLOR = "#f5c518";

/**
 * Flashes the badge for a few seconds, then leaves it reading NEW.
 *
 * Only the colour alternates -- the text stays put, so the badge never flickers between two
 * different readings. The NEW itself is not cleared here: `recomputeBadgeAndReleaseAlarm` keeps
 * showing it until the dashboard is opened, which is what marks the releases as seen.
 *
 * Kept short on purpose: this runs in a service worker Chrome is free to shut down once idle.
 */
export async function pulseReleaseBadge(sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))) {
  await chrome.action.setBadgeText({ text: NEW_BADGE_TEXT });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  for (let index = 0; index < 5; index++) {
    await chrome.action.setBadgeBackgroundColor({ color: COUNT_BADGE_COLOR });
    await sleep(400);
    await chrome.action.setBadgeBackgroundColor({ color: NEW_BADGE_COLOR });
    await sleep(400);
  }
}

/** Returns the releases it found new, so callers need not scan the episode table a second time. */
export async function recomputeBadgeAndReleaseAlarm(): Promise<NewRelease[]> {
  const [local, providerShows, episodes] = await Promise.all([readLocalState(), db.providerShows.toArray(), db.episodes.toArray()]);
  const state: DomainState = { shows: local.shows, progress: local.progress, settings: local.settings, providerShows, episodes };
  const count = selectWatchListShows(state).length;
  // NEW outranks the waiting count and stays up until the dashboard is opened, so an episode
  // that aired while the browser was closed cannot be missed by glancing at the toolbar.
  const fresh = newReleasesSinceSeen(local, episodes);
  await chrome.action.setBadgeBackgroundColor({ color: fresh.length > 0 ? NEW_BADGE_COLOR : COUNT_BADGE_COLOR });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: fresh.length > 0 ? "#ffffff" : "#111111" });
  await chrome.action.setBadgeText({ text: fresh.length > 0 ? NEW_BADGE_TEXT : count ? String(count) : "" });
  await chrome.action.setTitle({ title: releaseTooltip(fresh) });
  const now = Date.now();
  const nearest = episodes.filter((episode) => episode.kind === "regular")
    .map((episode) => episodeReleaseInstant(episode, local.settings.timezone, local.settings.dateOnlyReleaseHour)?.getTime())
    .filter((instant): instant is number => typeof instant === "number" && instant > now).sort((a, b) => a - b)[0];
  await chrome.alarms.clear(RELEASE_ALARM);
  if (nearest) await chrome.alarms.create(RELEASE_ALARM, { when: nearest });
  return fresh;
}
