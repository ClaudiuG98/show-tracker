export type ProviderName = "tvmaze";
export type UserShowState =
  | "watching" | "caught_up" | "not_started" | "paused"
  | "completed" | "progress_unknown";
export type ProviderStatus = "running" | "ended" | "in_development" | "tbd" | "unknown";

export interface ExternalIds {
  imdb?: string;
  tvdbShow?: number;
  tvmazeShow?: number;
}

export interface TrackedShow {
  id: string;
  externalIds: ExternalIds;
  titleSnapshot: string;
  imdbAddedAt?: string;
  tvTimeAddedAt?: string;
  userState: UserShowState;
  userStateSource?: "import" | "user";
  userStateUpdatedAt?: string;
  importSources: Array<"imdb" | "tvtime" | "manual">;
  providerUpdatedAt?: number;
  progressUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchedEpisodeState {
  localShowId: string;
  tvmazeEpisodeId?: number;
  tvdbEpisodeId?: number;
  season: number;
  episode: number;
  watched: boolean;
  watchedAt?: string;
  source: "tvtime" | "user" | "assumption" | "restore";
  rewatchCount?: number;
}

export interface ProviderShow {
  provider: ProviderName;
  id: number;
  name: string;
  status: ProviderStatus;
  externalIds: ExternalIds;
  /** Kept for backwards compatibility with provider records cached before image variants were stored. */
  imageUrl?: string;
  image?: {
    medium?: string;
    original?: string;
  };
  premiered?: string;
  ended?: string;
  rating?: number;
  genres?: string[];
  runtimeMinutes?: number;
  language?: string;
  showType?: string;
  networkName?: string;
  webChannelName?: string;
  /** True once the extended show-detail fields have been requested from TVMaze. */
  detailsLoaded?: boolean;
  metadataVersion?: number;
  providerUrl?: string;
  updatedAt: number;
}

export interface ProviderEpisode {
  id: number;
  showId: number;
  tvdbEpisodeId?: number;
  season: number;
  number: number;
  name?: string;
  kind: "regular" | "special";
  airdate?: string;
  airtime?: string;
  airstamp?: string;
  runtimeMinutes?: number;
  summary?: string;
  rating?: number;
  image?: {
    medium?: string;
    original?: string;
  };
}

export interface ProviderAlternateEpisodeMapping {
  season: number;
  number: number;
  name?: string;
  primaryEpisodeIds: number[];
}

export interface ActionSnapshot {
  episodes: WatchedEpisodeState[];
  userState: UserShowState;
}

export interface WatchedAction {
  id: string;
  showId: string;
  episodeKeys: string[];
  action: "watched" | "unwatched" | "bulk_watched" | "bulk_unwatched" | "state_changed";
  before: ActionSnapshot;
  after: ActionSnapshot;
  occurredAt: string;
}

export interface Settings {
  dateOnlyReleaseHour: string;
  timezone: string;
}

export const DEFAULT_SETTINGS: Settings = {
  dateOnlyReleaseHour: "09:00",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export interface TelevisionProvider {
  lookupByImdbId(id: string): Promise<ProviderShow | null>;
  lookupByTvdbId(id: number): Promise<ProviderShow | null>;
  getShow(id: number): Promise<ProviderShow | null>;
  getEpisodes(id: number): Promise<ProviderEpisode[]>;
  getAlternateEpisodeMappings?(id: number): Promise<ProviderAlternateEpisodeMapping[]>;
  getChangedShows(since: "day" | "week" | "month" | "all"): Promise<Map<number, number>>;
}

export const episodeKey = (episode: Pick<ProviderEpisode, "id">) => String(episode.id);
