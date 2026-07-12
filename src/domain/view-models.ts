import { getEpisodeAvailability } from "./availability";
import type { ProviderEpisode, ProviderShow, TrackedShow } from "./models";
import { airedUnwatched, nextFuture, type DomainState } from "./selectors";

export const providerFor = (state: DomainState, show: TrackedShow) =>
  state.providerShows.find((candidate) => candidate.id === show.externalIds.tvmazeShow);

export const posterUrls = (show?: ProviderShow) => ({
  medium: show?.image?.medium ?? show?.imageUrl,
  original: show?.image?.original ?? show?.image?.medium ?? show?.imageUrl,
});

export interface SeasonGroup {
  season: number;
  episodes: ProviderEpisode[];
  watched: number;
  available: number;
  total: number;
}

export function groupRegularEpisodesBySeason(state: DomainState, show: TrackedShow, now = new Date()): SeasonGroup[] {
  const watchedIds = new Set(state.progress.filter((item) => item.localShowId === show.id && item.watched)
    .map((item) => item.tvmazeEpisodeId));
  const groups = new Map<number, ProviderEpisode[]>();
  state.episodes.filter((episode) => episode.showId === show.externalIds.tvmazeShow && episode.kind === "regular")
    .sort((a, b) => a.season - b.season || a.number - b.number || a.id - b.id)
    .forEach((episode) => groups.set(episode.season, [...(groups.get(episode.season) ?? []), episode]));
  return [...groups].map(([season, episodes]) => ({
    season,
    episodes,
    watched: episodes.filter((episode) => watchedIds.has(episode.id)).length,
    available: episodes.filter((episode) => getEpisodeAvailability(episode, now, state.settings.timezone, state.settings.dateOnlyReleaseHour) === "available").length,
    total: episodes.length,
  }));
}

export const librarySummary = (state: DomainState, show: TrackedShow, now = new Date()) => {
  const provider = providerFor(state, show);
  const regular = state.episodes.filter((episode) => episode.showId === show.externalIds.tvmazeShow && episode.kind === "regular");
  const watchedIds = new Set(state.progress.filter((item) => item.localShowId === show.id && item.watched)
    .map((item) => item.tvmazeEpisodeId));
  const available = regular.filter((episode) => getEpisodeAvailability(episode, now, state.settings.timezone, state.settings.dateOnlyReleaseHour) === "available");
  return {
    provider,
    watched: available.filter((episode) => watchedIds.has(episode.id)).length,
    available: available.length,
    nextAired: airedUnwatched(state, show, now)[0],
    nextFuture: nextFuture(state, show, now),
  };
};
