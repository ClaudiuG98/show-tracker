import { useCallback, useEffect, useState } from "react";
import { getEpisodeAvailability } from "../domain/availability";
import type { ActionSnapshot, ProviderEpisode, ProviderShow, TrackedShow, WatchedAction } from "../domain/models";
import { db, resetMetadataCache } from "../storage/database";
import { readLocalState, updateLocalState, type LocalState } from "../storage/local-state";
import type { DomainState } from "../domain/selectors";

export function useTracker() {
  const [local, setLocal] = useState<LocalState>();
  const [domain, setDomain] = useState<DomainState>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  const [metadataAction, setMetadataAction] = useState<"refresh" | "redownload">();
  const [metadataError, setMetadataError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const reload = useCallback(async () => {
    try {
      const [next, providerShows, episodes] = await Promise.all([readLocalState(), db.providerShows.toArray(), db.episodes.toArray()]);
      setLocal(next); setDomain({ shows: next.shows, progress: next.progress, settings: next.settings, providerShows, episodes }); setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load tracker data."); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    const listener = () => void reload();
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener(listener);
    return () => {
      window.clearInterval(timer);
      if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.removeListener(listener);
    };
  }, [reload]);

  const markEpisode = async (show: TrackedShow, episodeId: number, watched: boolean) => {
    await updateLocalState((state) => {
      const beforeEpisodes = state.progress.filter((p) => p.localShowId === show.id);
      const existing = state.progress.find((p) => p.localShowId === show.id && p.tvmazeEpisodeId === episodeId);
      const metadata = domain?.episodes.find((e) => e.id === episodeId);
      if (!metadata) return state;
      const changed = existing ? state.progress.map((p) => {
        if (p !== existing) return p;
        const { watchedAt: _watchedAt, ...base } = p;
        return { ...base, watched, ...(watched ? { watchedAt: new Date().toISOString() } : {}), source: "user" as const };
      }) :
        [...state.progress, { localShowId: show.id, tvmazeEpisodeId: episodeId, season: metadata.season, episode: metadata.number, watched,
          ...(watched ? { watchedAt: new Date().toISOString() } : {}), source: "user" as const }];
      const userState = watched && show.userState === "not_started" ? "watching" : !watched && ["caught_up", "completed"].includes(show.userState) ? "watching" : show.userState;
      const afterEpisodes = changed.filter((p) => p.localShowId === show.id);
      const snapshot = (episodes: typeof beforeEpisodes, stateName = show.userState): ActionSnapshot => ({ episodes, userState: stateName });
      const action: WatchedAction = { id: crypto.randomUUID(), showId: show.id, episodeKeys: [String(episodeId)], action: watched ? "watched" : "unwatched",
        before: snapshot(beforeEpisodes), after: snapshot(afterEpisodes, userState), occurredAt: new Date().toISOString() };
      return { ...state, progress: changed, shows: state.shows.map((s) => s.id === show.id ? { ...s, userState, userStateSource: "user" as const, userStateUpdatedAt: action.occurredAt, progressUpdatedAt: action.occurredAt, updatedAt: action.occurredAt } : s), history: [action, ...state.history].slice(0, 500) };
    });
    await reload();
    setStatus(watched ? "Episode marked watched." : "Episode marked unwatched.");
  };
  const undo = async (action: WatchedAction) => {
    await updateLocalState((state) => ({ ...state,
      progress: [...state.progress.filter((p) => p.localShowId !== action.showId), ...action.before.episodes],
      shows: state.shows.map((s) => s.id === action.showId ? { ...s, userState: action.before.userState, updatedAt: new Date().toISOString() } : s),
      history: state.history.filter((item) => item.id !== action.id),
    })); await reload();
  };
  const setShowState = async (showId: string, userState: TrackedShow["userState"]) => {
    await updateLocalState((state) => {
      const show = state.shows.find((item) => item.id === showId); if (!show) return state;
      const now = new Date().toISOString(), beforeEpisodes = state.progress.filter((item) => item.localShowId === showId);
      const progress = userState === "not_started" ? state.progress.filter((item) => item.localShowId !== showId) : state.progress;
      const action: WatchedAction = { id: crypto.randomUUID(), showId, episodeKeys: [], action: "state_changed",
        before: { episodes: beforeEpisodes, userState: show.userState }, after: { episodes: progress.filter((item) => item.localShowId === showId), userState }, occurredAt: now };
      return { ...state, progress, shows: state.shows.map((item) => item.id === showId ? { ...item, userState, userStateSource: "user" as const,
        userStateUpdatedAt: now, ...(userState === "not_started" ? { progressUpdatedAt: now } : {}), updatedAt: now } : item),
        history: [action, ...state.history].slice(0, 500) };
    });
    await reload();
    setStatus(`Show set to ${userState.replace("_", " ")}.`);
  };
  const setEpisodesWatched = async (show: TrackedShow, episodeIds: number[], watched: boolean, finalState?: TrackedShow["userState"]) => {
    const eligible = (domain?.episodes ?? []).filter((episode) => episodeIds.includes(episode.id) &&
      getEpisodeAvailability(episode, now, domain?.settings.timezone ?? "UTC", domain?.settings.dateOnlyReleaseHour ?? "09:00") === "available");
    if (!eligible.length && finalState === undefined) return;
    await updateLocalState((state) => {
      const occurredAt = new Date().toISOString();
      const currentShow = state.shows.find((item) => item.id === show.id); if (!currentShow) return state;
      const beforeEpisodes = state.progress.filter((item) => item.localShowId === show.id);
      const currentById = new Map(beforeEpisodes.flatMap((item) => item.tvmazeEpisodeId === undefined ? [] : [[item.tvmazeEpisodeId, item] as const]));
      const changed = eligible.filter((episode) => currentById.get(episode.id)?.watched !== watched);
      const changedIds = new Set(changed.map((episode) => episode.id));
      const updated = state.progress.map((item) => {
        if (item.localShowId !== show.id || !changedIds.has(item.tvmazeEpisodeId ?? -1)) return item;
        const { watchedAt: _watchedAt, ...base } = item;
        return { ...base, watched, ...(watched ? { watchedAt: occurredAt } : {}), source: "user" as const };
      });
      const added = changed.filter((episode) => !currentById.has(episode.id)).map((episode) => ({ localShowId: show.id,
        tvmazeEpisodeId: episode.id, season: episode.season, episode: episode.number, watched,
        ...(watched ? { watchedAt: occurredAt } : {}), source: "user" as const }));
      const progress = [...updated, ...added];
      const userState = finalState ?? (watched && ["not_started", "progress_unknown"].includes(currentShow.userState)
        ? "watching" : !watched && ["caught_up", "completed"].includes(currentShow.userState) ? "watching" : currentShow.userState);
      if (changed.length === 0 && userState === currentShow.userState) return state;
      const action: WatchedAction = { id: crypto.randomUUID(), showId: show.id, episodeKeys: changed.map((episode) => String(episode.id)),
        action: changed.length === 0 ? "state_changed" : watched ? "bulk_watched" : "bulk_unwatched",
        before: { episodes: beforeEpisodes, userState: currentShow.userState },
        after: { episodes: progress.filter((item) => item.localShowId === show.id), userState }, occurredAt };
      return { ...state, progress, shows: state.shows.map((item) => item.id === show.id ? { ...item, userState,
        userStateSource: "user" as const, userStateUpdatedAt: occurredAt, progressUpdatedAt: occurredAt, updatedAt: occurredAt } : item),
        history: [action, ...state.history].slice(0, 500) };
    });
    await reload();
    setStatus(finalState ? "Show marked caught up." : `${eligible.length} aired episode${eligible.length === 1 ? "" : "s"} marked ${watched ? "watched" : "unwatched"}.`);
  };
  const markEpisodes = (show: TrackedShow, episodeIds: number[]) => setEpisodesWatched(show, episodeIds, true);
  const markCaughtUp = (show: TrackedShow, episodeIds: number[], finalState: TrackedShow["userState"]) =>
    setEpisodesWatched(show, episodeIds, true, finalState);
  const removeShow = async (showId: string) => {
    await updateLocalState((state) => ({ ...state, shows: state.shows.filter((show) => show.id !== showId),
      progress: state.progress.filter((item) => item.localShowId !== showId), history: state.history.filter((item) => item.showId !== showId) }));
    await reload();
    setStatus("Show removed from tracker.");
  };
  const addShow = async (provider: ProviderShow, episodes: ProviderEpisode[]) => {
    const existing = local?.shows.find((show) => show.externalIds.tvmazeShow === provider.id);
    if (existing) return existing.id;
    await db.transaction("rw", db.providerShows, db.episodes, async () => {
      await db.providerShows.put(provider);
      await db.episodes.bulkPut(episodes);
    });
    const now = new Date().toISOString(), id = crypto.randomUUID();
    await updateLocalState((state) => ({ ...state, shows: [...state.shows, { id, externalIds: provider.externalIds, titleSnapshot: provider.name,
      userState: "watching", userStateSource: "user", userStateUpdatedAt: now, importSources: ["manual"], providerUpdatedAt: provider.updatedAt, createdAt: now, updatedAt: now }] }));
    await reload();
    setStatus(`${provider.name} added to your tracker.`);
    return id;
  };
  const refreshMetadata = async (redownload = false) => {
    setMetadataAction(redownload ? "redownload" : "refresh");
    setMetadataError("");
    try {
      if (redownload) await resetMetadataCache();
      const result = await chrome.runtime.sendMessage({ type: "SYNC_NOW" }) as { ok?: boolean; error?: string } | undefined;
      if (!result?.ok) throw new Error(result?.error ?? "TVMaze metadata could not be refreshed.");
      await reload();
      setStatus(redownload ? "Metadata rebuilt." : "Updates checked.");
    } catch (cause) {
      setMetadataError(cause instanceof Error ? cause.message : "TVMaze metadata could not be refreshed.");
      throw cause;
    } finally {
      setMetadataAction(undefined);
    }
  };
  return { local, domain, error, status, now, metadataAction, metadataError, reload, refreshMetadata, markEpisode, markEpisodes, setEpisodesWatched, markCaughtUp, setShowState, removeShow, addShow, undo };
}
