import { fromZonedTime } from "date-fns-tz";
import type { ProviderEpisode } from "./models";

export type EpisodeAvailability = "available" | "future" | "unknown";

export function episodeReleaseInstant(
  episode: ProviderEpisode,
  timezone: string,
  dateOnlyReleaseHour: string,
): Date | null {
  if (episode.airstamp) {
    const instant = new Date(episode.airstamp);
    if (!Number.isNaN(instant.getTime())) return instant;
  }
  if (!episode.airdate || !/^\d{4}-\d{2}-\d{2}$/.test(episode.airdate)) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dateOnlyReleaseHour)) return null;
  const instant = fromZonedTime(`${episode.airdate}T${dateOnlyReleaseHour}:00`, timezone);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

export function getEpisodeAvailability(
  episode: ProviderEpisode,
  nowInstant: Date,
  timezone: string,
  dateOnlyReleaseHour: string,
): EpisodeAvailability {
  const release = episodeReleaseInstant(episode, timezone, dateOnlyReleaseHour);
  if (!release) return "unknown";
  return release.getTime() <= nowInstant.getTime() ? "available" : "future";
}
