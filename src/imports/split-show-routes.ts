import type { TvTimeShow } from "./tvtime";

interface SplitShowRoute {
  sourceTvdbShowId: number;
  seasons: Array<{ sourceSeason: number; targetTvmazeShowId: number }>;
}

/**
 * Stable-ID overrides for providers that model one TV Time anthology as
 * multiple independent shows. Keeping these routes centralized prevents
 * title matching from leaking into production reconciliation.
 */
const SPLIT_SHOW_ROUTES: SplitShowRoute[] = [
  {
    sourceTvdbShowId: 389492,
    seasons: [
      { sourceSeason: 1, targetTvmazeShowId: 50907 },
      { sourceSeason: 2, targetTvmazeShowId: 68626 },
      { sourceSeason: 3, targetTvmazeShowId: 86754 },
    ],
  },
];

export function expandSplitTvTimeShows(shows: readonly TvTimeShow[]) {
  return shows.flatMap((show) => {
    const route = SPLIT_SHOW_ROUTES.find((candidate) => candidate.sourceTvdbShowId === show.tvdbShowId);
    if (!route) return [show];
    return route.seasons.flatMap(({ sourceSeason, targetTvmazeShowId }) => {
      const episodes = show.episodes.filter((episode) => episode.season === sourceSeason).map((episode) => ({ ...episode, season: 1 }));
      if (episodes.length === 0) return [];
      const { tvdbShowId: _tvdbShowId, imdbId: _imdbId, ...withoutExternalIds } = show;
      return [{ ...(sourceSeason === 1 ? show : withoutExternalIds), uuid: `${show.uuid}:season:${sourceSeason}`,
        title: `${show.title} · season ${sourceSeason}`, providerShowId: targetTvmazeShowId, episodes }];
    });
  });
}
