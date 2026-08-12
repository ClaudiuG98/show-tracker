import { getEpisodeAvailability } from "../domain/availability";
import type {
  ProviderEpisode,
  ProviderStatus,
  UserShowState,
} from "../domain/models";

export interface OnboardingTiming {
  importInstant: Date;
  timezone: string;
  dateOnlyReleaseHour: string;
}

export interface OnboardingShow {
  id: string;
  providerStatus: ProviderStatus;
  episodes: readonly ProviderEpisode[];
}

export type OnboardingClassification = "finished" | "active_or_uncertain";

interface OnboardingEpisodeDecision {
  tvmazeEpisodeId: number;
  season: number;
  episode: number;
  watched: boolean;
}

export interface OnboardingDecision {
  showId: string;
  userState: UserShowState;
  episodeDecisions: OnboardingEpisodeDecision[];
}

export type ActiveProgressChoice =
  | { kind: "caught_up" }
  | { kind: "not_started" }
  | { kind: "last_watched"; tvmazeEpisodeId: number }
  | { kind: "manual"; watchedTvmazeEpisodeIds: readonly number[] };

function compareEpisodes(a: ProviderEpisode, b: ProviderEpisode) {
  return a.season - b.season || a.number - b.number || a.id - b.id;
}

function regularEpisodes(show: Pick<OnboardingShow, "episodes">) {
  return show.episodes.filter((episode) => episode.kind === "regular");
}

export function getAvailableRegularEpisodes(
  show: Pick<OnboardingShow, "episodes">,
  timing: OnboardingTiming,
): ProviderEpisode[] {
  return regularEpisodes(show)
    .filter((episode) => getEpisodeAvailability(
      episode,
      timing.importInstant,
      timing.timezone,
      timing.dateOnlyReleaseHour,
    ) === "available")
    .sort(compareEpisodes);
}

export function classifyOnboardingShow(
  show: OnboardingShow,
  timing: OnboardingTiming,
): OnboardingClassification {
  if (show.providerStatus !== "ended") return "active_or_uncertain";

  const episodes = regularEpisodes(show);
  if (episodes.length === 0) return "active_or_uncertain";

  const allRegularEpisodesAreAvailable = episodes.every((episode) =>
    getEpisodeAvailability(
      episode,
      timing.importInstant,
      timing.timezone,
      timing.dateOnlyReleaseHour,
    ) === "available",
  );

  return allRegularEpisodesAreAvailable ? "finished" : "active_or_uncertain";
}

function episodeDecisions(
  show: OnboardingShow,
  timing: OnboardingTiming,
  isWatched: (episode: ProviderEpisode, index: number) => boolean,
): OnboardingEpisodeDecision[] {
  return getAvailableRegularEpisodes(show, timing).map((episode, index) => ({
    tvmazeEpisodeId: episode.id,
    season: episode.season,
    episode: episode.number,
    watched: isWatched(episode, index),
  }));
}

function requireFinished(show: OnboardingShow, timing: OnboardingTiming) {
  if (classifyOnboardingShow(show, timing) !== "finished") {
    throw new Error(`Show ${show.id} is not confidently finished.`);
  }
}

export function applyFinishedWatchedEverything(
  show: OnboardingShow,
  timing: OnboardingTiming,
): OnboardingDecision {
  requireFinished(show, timing);
  return {
    showId: show.id,
    userState: "completed",
    episodeDecisions: episodeDecisions(show, timing, () => true),
  };
}

export function applyFinishedMixture(
  shows: readonly OnboardingShow[],
  notStartedShowIds: readonly string[],
  timing: OnboardingTiming,
): OnboardingDecision[] {
  const showIds = new Set(shows.map((show) => show.id));
  const unknownId = notStartedShowIds.find((showId) => !showIds.has(showId));
  if (unknownId) throw new Error(`Unknown finished show selection: ${unknownId}.`);

  const notStarted = new Set(notStartedShowIds);
  return shows.map((show) => {
    requireFinished(show, timing);
    const selected = notStarted.has(show.id);
    return {
      showId: show.id,
      userState: selected ? "not_started" : "completed",
      episodeDecisions: episodeDecisions(show, timing, () => !selected),
    };
  });
}

function progressState(decisions: readonly OnboardingEpisodeDecision[]): UserShowState {
  if (!decisions.some((episode) => episode.watched)) return "not_started";
  if (decisions.every((episode) => episode.watched)) return "caught_up";
  return "watching";
}

export function applyActiveProgressChoice(
  show: OnboardingShow,
  choice: ActiveProgressChoice,
  timing: OnboardingTiming,
): OnboardingDecision {
  if (choice.kind === "caught_up") {
    return {
      showId: show.id,
      userState: "caught_up",
      episodeDecisions: episodeDecisions(show, timing, () => true),
    };
  }

  if (choice.kind === "not_started") {
    return {
      showId: show.id,
      userState: "not_started",
      episodeDecisions: episodeDecisions(show, timing, () => false),
    };
  }

  if (choice.kind === "last_watched") {
    const available = getAvailableRegularEpisodes(show, timing);
    const lastWatchedIndex = available.findIndex(
      (episode) => episode.id === choice.tvmazeEpisodeId,
    );
    if (lastWatchedIndex < 0) {
      throw new Error("The last watched episode must be an available regular episode.");
    }
    const decisions = available.map((episode, index) => ({
      tvmazeEpisodeId: episode.id,
      season: episode.season,
      episode: episode.number,
      watched: index <= lastWatchedIndex,
    }));
    return {
      showId: show.id,
      userState: progressState(decisions),
      episodeDecisions: decisions,
    };
  }

  const watchedIds = new Set(choice.watchedTvmazeEpisodeIds);
  const decisions = episodeDecisions(show, timing, (episode) => watchedIds.has(episode.id));
  return {
    showId: show.id,
    userState: progressState(decisions),
    episodeDecisions: decisions,
  };
}
