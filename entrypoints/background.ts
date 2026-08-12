import { requestSchema } from "../src/messaging/messages";
import { LOCAL_STATE_KEY, readLocalState, updateLocalState } from "../src/storage/local-state";
import { db } from "../src/storage/database";
import { TvMazeProvider } from "../src/providers/tvmaze/provider";
import { DAILY_SYNC_ALARM, METADATA_RETRY_ALARM, RELEASE_ALARM, checkReleaseNotifications, ensureSyncAlarms, recomputeBadgeAndReleaseAlarm, runAutomaticSynchronization, synchronize } from "../src/scheduling/sync";
import { selectWatchListShows } from "../src/domain/selectors";

const dashboardUrl = (route = "/") => chrome.runtime.getURL(`/dashboard.html#${route}`);

export default defineBackground(() => {
  const safely = (label: string, operation: Promise<unknown>) => void operation.catch((error: unknown) => {
    console.warn(`[TV Show Tracker] ${label}`, error);
  });
  chrome.runtime.onInstalled.addListener(() => safely("Could not initialize background alarms after installation.", ensureSyncAlarms()));
  chrome.runtime.onStartup.addListener(() => safely("Could not restore the badge after browser startup.", ensureSyncAlarms()));
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[LOCAL_STATE_KEY]) {
      safely("Could not update the badge after tracker data changed.", recomputeBadgeAndReleaseAlarm());
    }
  });
  chrome.action.onClicked.addListener(() => void chrome.tabs.create({ url: dashboardUrl() }));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DAILY_SYNC_ALARM) safely("Automatic metadata check failed.", runAutomaticSynchronization("daily"));
    else if (alarm.name === METADATA_RETRY_ALARM) safely("Automatic metadata retry failed.", runAutomaticSynchronization("retry"));
    else if (alarm.name === RELEASE_ALARM) safely("Could not update the release badge.", (async () => {
      await checkReleaseNotifications();
      await recomputeBadgeAndReleaseAlarm();
    })());
  });
  chrome.notifications.onClicked.addListener((notificationId) => {
    const [kind, showId, episodeId] = notificationId.split(":");
    if (kind !== "release") return;
    void chrome.notifications.clear(notificationId);
    void chrome.tabs.create({ url: dashboardUrl(episodeId ? `/show/${showId}/episode/${episodeId}` : "/watch-list") });
  });
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) { respond({ ok: false, error: "Invalid request" }); return false; }
    if (sender.url?.startsWith("https://www.imdb.com/") === false && sender.id !== chrome.runtime.id) { respond({ ok: false, error: "Untrusted sender" }); return false; }
    void (async () => {
      const request = parsed.data;
      if (request.type === "OPEN_DASHBOARD") { await chrome.tabs.create({ url: dashboardUrl(request.route) }); return { ok: true }; }
      if (request.type === "SYNC_NOW") { await synchronize(); return { ok: true }; }
      const local = await readLocalState();
      const existing = "imdbId" in request ? local.shows.find((s) => s.externalIds.imdb === request.imdbId) : undefined;
      if (request.type === "GET_IMDB_STATUS" || request.type === "GET_TRACKER_SUMMARY") {
        const [providerShows, episodes] = await Promise.all([db.providerShows.toArray(), db.episodes.toArray()]);
        const count = selectWatchListShows({ shows: local.shows, progress: local.progress, settings: local.settings, providerShows, episodes }).length;
        return { ok: true, tracked: Boolean(existing), showId: existing?.id, count };
      }
      if (request.type === "TRACK_IMDB_SHOW") {
        if (existing) return { ok: true, showId: existing.id };
        const provider = await new TvMazeProvider().lookupByImdbId(request.imdbId);
        if (!provider) return { ok: false, error: "This title could not be found on TVMaze." };
        const episodes = await new TvMazeProvider().getEpisodes(provider.id);
        await db.transaction("rw", db.providerShows, db.episodes, async () => { await db.providerShows.put(provider); await db.episodes.bulkPut(episodes); });
        const now = new Date().toISOString(), id = crypto.randomUUID();
        await updateLocalState((state) => ({ ...state, shows: [...state.shows, { id, externalIds: provider.externalIds, titleSnapshot: provider.name,
          userState: "watching", userStateSource: "user", userStateUpdatedAt: now, importSources: ["manual"], providerUpdatedAt: provider.updatedAt, createdAt: now, updatedAt: now }] }));
        return { ok: true, showId: id };
      }
      return { ok: false, error: "Show is not tracked." };
    })().then(async (result) => { await recomputeBadgeAndReleaseAlarm(); respond(result); }).catch((error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }));
    return true;
  });
});
