import type { TvTimeShow } from "./tvtime";

interface SplitShowRoute {
  sourceTvdbShowId: number;
  seasons: Array<{
    sourceSeason: number;
    targetTvmazeShowId: number;
    targetSeason?: number;
    targetEpisodeOffset?: number;
  }>;
  sourceSpecialEpisodes?: Array<{ season: number; number: number }>;
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
  {
    sourceTvdbShowId: 424941,
    seasons: [
      { sourceSeason: 1, targetTvmazeShowId: 66547, targetSeason: 1 },
      { sourceSeason: 2, targetTvmazeShowId: 66547, targetSeason: 2 },
      { sourceSeason: 3, targetTvmazeShowId: 87808, targetSeason: 1 },
    ],
  },
  {
    sourceTvdbShowId: 345246,
    seasons: [
      { sourceSeason: 1, targetTvmazeShowId: 29191, targetSeason: 1 },
      { sourceSeason: 2, targetTvmazeShowId: 49673, targetSeason: 1 },
    ],
  },
  {
    sourceTvdbShowId: 327417,
    seasons: [
      { sourceSeason: 1, targetTvmazeShowId: 27436, targetSeason: 1 },
      { sourceSeason: 2, targetTvmazeShowId: 27436, targetSeason: 1, targetEpisodeOffset: 9 },
      { sourceSeason: 3, targetTvmazeShowId: 27436, targetSeason: 3 },
      { sourceSeason: 4, targetTvmazeShowId: 27436, targetSeason: 4 },
      { sourceSeason: 5, targetTvmazeShowId: 27436, targetSeason: 5 },
    ],
  },
  {
    sourceTvdbShowId: 268156,
    seasons: [
      { sourceSeason: 1, targetTvmazeShowId: 1367, targetSeason: 1 },
      { sourceSeason: 2, targetTvmazeShowId: 1367, targetSeason: 2 },
    ],
    // TV Time numbers these narrative specials as S02E11/E12, while TVMaze
    // classifies both outside the regular episode list used by the tracker.
    sourceSpecialEpisodes: [{ season: 2, number: 11 }, { season: 2, number: 12 }],
  },
];

export function expandSplitTvTimeShows(shows: readonly TvTimeShow[]) {
  return shows.flatMap((show) => {
    const route = SPLIT_SHOW_ROUTES.find((candidate) => candidate.sourceTvdbShowId === show.tvdbShowId);
    if (!route) return [show];
    const groups = new Map<number, { sourceSeasons: number[]; episodes: TvTimeShow["episodes"] }>();
    for (const { sourceSeason, targetTvmazeShowId, targetSeason = 1, targetEpisodeOffset = 0 } of route.seasons) {
      const episodes = show.episodes.filter((episode) => episode.season === sourceSeason).map((episode) => ({
        ...episode,
        season: targetSeason,
        number: episode.number + targetEpisodeOffset,
        special: episode.special || Boolean(route.sourceSpecialEpisodes?.some((special) => (
          special.season === episode.season && special.number === episode.number
        ))),
      }));
      if (episodes.length === 0) continue;
      const group = groups.get(targetTvmazeShowId) ?? { sourceSeasons: [], episodes: [] };
      group.sourceSeasons.push(sourceSeason);
      group.episodes.push(...episodes);
      groups.set(targetTvmazeShowId, group);
    }
    const routedSeasons = new Set(route.seasons.map((season) => season.sourceSeason));
    const unroutedEpisodes = show.episodes.filter((episode) => !routedSeasons.has(episode.season));
    const fallbackTarget = route.seasons[0]?.targetTvmazeShowId;
    if (unroutedEpisodes.length > 0 && fallbackTarget !== undefined) {
      const group = groups.get(fallbackTarget) ?? { sourceSeasons: [], episodes: [] };
      for (const season of new Set(unroutedEpisodes.map((episode) => episode.season))) {
        if (!group.sourceSeasons.includes(season)) group.sourceSeasons.push(season);
      }
      group.episodes.push(...unroutedEpisodes);
      groups.set(fallbackTarget, group);
    }
    const isSplit = groups.size > 1;
    return [...groups].flatMap(([targetTvmazeShowId, group], index) => {
      const { tvdbShowId: _tvdbShowId, imdbId: _imdbId, ...withoutExternalIds } = show;
      const seasonLabel = group.sourceSeasons.length === 1
        ? `season ${group.sourceSeasons[0]}`
        : `seasons ${group.sourceSeasons.join("–")}`;
      return [{ ...(index === 0 ? show : withoutExternalIds),
        uuid: isSplit ? `${show.uuid}:seasons:${group.sourceSeasons.join(",")}` : show.uuid,
        title: isSplit ? `${show.title} · ${seasonLabel}` : show.title,
        providerShowId: targetTvmazeShowId, episodes: group.episodes }];
    });
  });
}
