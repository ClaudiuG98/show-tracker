import { db } from "../storage/database";
import { readLocalState, updateLocalState } from "../storage/local-state";
import { TvMazeProvider } from "../providers/tvmaze/provider";
import { episodeReleaseInstant } from "../domain/availability";
import { selectWatchListShows, type DomainState } from "../domain/selectors";
import type { TelevisionProvider } from "../domain/models";

const provider = new TvMazeProvider();
export const DAILY_SYNC_ALARM = "daily-metadata-sync";
export const RELEASE_ALARM = "next-episode-release";
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
  for (const show of local.shows) {
    const id = show.externalIds.tvmazeShow;
    if (!id || !shouldRefreshMetadata(local.lastSyncAt, changed.get(id), show.providerUpdatedAt, storedById.get(id)?.metadataVersion)) continue;
    const [metadata, episodes] = await Promise.all([syncProvider.getShow(id), syncProvider.getEpisodes(id)]);
    if (metadata) await db.transaction("rw", db.providerShows, db.episodes, async () => {
      await db.providerShows.put(metadata);
      await db.episodes.where("showId").equals(id).delete();
      await db.episodes.bulkPut(episodes);
    });
  }
  await updateLocalState((value) => ({ ...value, lastSyncAt: new Date().toISOString(), shows: value.shows.map((show) => {
    const updated = show.externalIds.tvmazeShow ? changed.get(show.externalIds.tvmazeShow) : undefined;
    return updated ? { ...show, providerUpdatedAt: updated, updatedAt: new Date().toISOString() } : show;
  }) }));
  await recomputeBadgeAndReleaseAlarm();
}

export function synchronize(syncProvider: TelevisionProvider = provider) {
  if (synchronization) return synchronization;
  synchronization = runSynchronization(syncProvider).finally(() => { synchronization = undefined; });
  return synchronization;
}

export async function ensureDailySyncAlarm() {
  if (!await chrome.alarms.get(DAILY_SYNC_ALARM)) {
    await chrome.alarms.create(DAILY_SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  }
}

export async function ensureSyncAlarms() {
  await ensureDailySyncAlarm();
  await recomputeBadgeAndReleaseAlarm();
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
