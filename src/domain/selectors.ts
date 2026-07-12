import { episodeReleaseInstant, getEpisodeAvailability } from "./availability";
import type { ProviderEpisode, ProviderShow, Settings, TrackedShow, WatchedEpisodeState } from "./models";

export interface DomainState {
  shows: TrackedShow[];
  providerShows: ProviderShow[];
  episodes: ProviderEpisode[];
  progress: WatchedEpisodeState[];
  settings: Settings;
}

const ordered = (a: ProviderEpisode, b: ProviderEpisode) =>
  a.season - b.season || a.number - b.number || a.id - b.id;

export function airedUnwatched(state: DomainState, show: TrackedShow, now = new Date()) {
  const watched = new Set(state.progress.filter((p) => p.localShowId === show.id && p.watched)
    .map((p) => p.tvmazeEpisodeId));
  return state.episodes.filter((episode) =>
    episode.showId === show.externalIds.tvmazeShow && episode.kind === "regular" &&
    !watched.has(episode.id) &&
    getEpisodeAvailability(episode, now, state.settings.timezone, state.settings.dateOnlyReleaseHour) === "available"
  ).sort(ordered);
}

export function nextFuture(state: DomainState, show: TrackedShow, now = new Date()) {
  return state.episodes.filter((episode) => episode.showId === show.externalIds.tvmazeShow &&
    episode.kind === "regular" &&
    getEpisodeAvailability(episode, now, state.settings.timezone, state.settings.dateOnlyReleaseHour) === "future")
    .sort((a, b) => (episodeReleaseInstant(a, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity) -
      (episodeReleaseInstant(b, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity))[0];
}

export interface WatchListItem { show: TrackedShow; episode: ProviderEpisode; additional: number; activity: number }
export function selectWatchListShows(state: DomainState, now = new Date()): WatchListItem[] {
  return state.shows.filter((s) => !["paused", "not_started", "completed", "progress_unknown"].includes(s.userState))
    .flatMap((show) => {
      const backlog = airedUnwatched(state, show, now);
      if (!backlog[0]) return [];
      const activity = Math.max(...backlog.map((e) => episodeReleaseInstant(e, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? 0));
      return [{ show, episode: backlog[0], additional: backlog.length - 1, activity }];
    }).sort((a, b) => b.activity - a.activity || a.show.titleSnapshot.localeCompare(b.show.titleSnapshot) || a.show.id.localeCompare(b.show.id));
}

export function selectUpcomingShows(state: DomainState, now = new Date()) {
  return state.shows.flatMap((show) => {
    const episode = nextFuture(state, show, now);
    if (!episode) return [];
    const later = state.episodes.filter((candidate) =>
      candidate.showId === show.externalIds.tvmazeShow && candidate.kind === "regular" && candidate.id !== episode.id &&
      getEpisodeAvailability(candidate, now, state.settings.timezone, state.settings.dateOnlyReleaseHour) === "future" &&
      (episodeReleaseInstant(candidate, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity) >
        (episodeReleaseInstant(episode, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity)
    ).length;
    return [{ show, episode, later }];
  }).sort((a, b) => (episodeReleaseInstant(a.episode, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity) -
    (episodeReleaseInstant(b.episode, state.settings.timezone, state.settings.dateOnlyReleaseHour)?.getTime() ?? Infinity));
}
