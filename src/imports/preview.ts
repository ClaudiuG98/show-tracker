import { getEpisodeAvailability } from "../domain/availability";
import type { ProviderEpisode, ProviderShow, TrackedShow, UserShowState, WatchedEpisodeState } from "../domain/models";
import type { LocalState } from "../storage/local-state";
import {
  applyActiveProgressChoice,
  applyFinishedMixture,
  applyFinishedWatchedEverything,
  classifyOnboardingShow,
  type ActiveProgressChoice,
  type OnboardingDecision,
  type OnboardingShow,
  type OnboardingTiming,
} from "./onboarding";
import type { ImportedEpisodeState } from "./reconcile";
import type { ImportAnalysis, ImportShowRecord } from "./session";

type FinishedListMode = "watched_everything" | "mixture";

export interface ImportDecisions {
  includeTvTimeOnlyRecordIds: string[];
  tvTimeOnlyReviewed: boolean;
  unresolvedReviewed: boolean;
  excludedConflictRecordIds: string[];
  finishedMode?: FinishedListMode;
  finishedNotStartedRecordIds: string[];
  progressChoices: Record<string, ActiveProgressChoice>;
  replaceLocalProgressKeys: string[];
}

export const emptyImportDecisions = (): ImportDecisions => ({
  includeTvTimeOnlyRecordIds: [],
  tvTimeOnlyReviewed: false,
  unresolvedReviewed: false,
  excludedConflictRecordIds: [],
  finishedNotStartedRecordIds: [],
  progressChoices: {},
  replaceLocalProgressKeys: [],
});

export interface ImportShowPlan {
  recordId: string;
  provider: ProviderShow;
  episodes: ProviderEpisode[];
  title: string;
  imdbId?: string;
  imdbAddedAt?: string;
  tvTimeAddedAt?: string;
  tvTimeRating?: number;
  tvtimeShowId?: string;
  desiredState: UserShowState;
  progress: ImportedEpisodeState[];
  sources: Array<"imdb" | "tvtime">;
}

interface LocalProgressConflict {
  key: string;
  recordId: string;
  showName: string;
  episodeName: string;
  existing: WatchedEpisodeState;
  incoming: ImportedEpisodeState;
  replaceApproved: boolean;
}

interface LocalShowStateConflict {
  key: string;
  recordId: string;
  showName: string;
  existing: UserShowState;
  incoming: UserShowState;
  replaceApproved: boolean;
}

export interface ImportPreview {
  sessionId: string;
  ready: boolean;
  missingDecisions: string[];
  plans: ImportShowPlan[];
  localProgressConflicts: LocalProgressConflict[];
  localShowStateConflicts: LocalShowStateConflict[];
  operationByRecordId: Record<string, "new" | "update">;
  committedShows: number;
  newShows: number;
  updatedShows: number;
  watchedStates: number;
  explicitUnwatchedStates: number;
}

function timing(analysis: ImportAnalysis, local: LocalState): OnboardingTiming {
  return {
    importInstant: new Date(analysis.importedAt),
    timezone: local.settings.timezone,
    dateOnlyReleaseHour: local.settings.dateOnlyReleaseHour,
  };
}

function onboardingShow(record: ImportShowRecord): OnboardingShow {
  return { id: record.id, providerStatus: record.provider!.status, episodes: record.episodes };
}

function toAssumptionProgress(decision: OnboardingDecision, importedAt: string): ImportedEpisodeState[] {
  return decision.episodeDecisions.map((episode) => ({
    tvmazeEpisodeId: episode.tvmazeEpisodeId,
    season: episode.season,
    episode: episode.episode,
    watched: episode.watched,
    ...(episode.watched ? { watchedAt: importedAt } : {}),
    source: "assumption",
  }));
}

function tvTimeState(record: ImportShowRecord, analysis: ImportAnalysis, local: LocalState): UserShowState {
  const tvtime = record.tvtime!;
  if (tvtime.status === "stopped") return "paused";
  const watched = new Set(record.progress?.states.filter((state) => state.watched).map((state) => state.tvmazeEpisodeId));
  if (tvtime.status === "not_started_yet" && watched.size === 0) return "not_started";
  const hasAvailableUnwatched = record.episodes.some((episode) => episode.kind === "regular"
    && !watched.has(episode.id)
    && getEpisodeAvailability(episode, new Date(analysis.importedAt), local.settings.timezone, local.settings.dateOnlyReleaseHour) === "available");
  if (hasAvailableUnwatched) return "watching";
  const hasFuture = record.episodes.some((episode) => episode.kind === "regular"
    && getEpisodeAvailability(episode, new Date(analysis.importedAt), local.settings.timezone, local.settings.dateOnlyReleaseHour) === "future");
  if (record.provider?.status === "ended" && !hasFuture) return "completed";
  return "caught_up";
}

function createPlan(
  record: ImportShowRecord,
  desiredState: UserShowState,
  progress: ImportedEpisodeState[],
): ImportShowPlan {
  return {
    recordId: record.id,
    provider: record.provider!,
    episodes: record.episodes,
    title: record.provider?.name ?? record.imdb?.title ?? record.tvtime?.title ?? record.id,
    ...(record.imdb?.imdbId ? { imdbId: record.imdb.imdbId } : {}),
    ...(record.imdb?.created ? { imdbAddedAt: record.imdb.created } : {}),
    ...(record.tvtime?.createdAt ? { tvTimeAddedAt: record.tvtime.createdAt } : {}),
    ...(record.tvtime?.rating !== undefined ? { tvTimeRating: record.tvtime.rating } : {}),
    ...(record.tvtime?.uuid ? { tvtimeShowId: record.tvtime.uuid } : {}),
    desiredState,
    progress,
    sources: [...new Set([
      ...(record.imdb ? ["imdb" as const] : []),
      ...(record.tvtime ? ["tvtime" as const] : []),
    ])],
  };
}

function existingShowForPlan(local: LocalState, plan: ImportShowPlan): TrackedShow | undefined {
  return local.shows.find((show) => show.externalIds.tvmazeShow === plan.provider.id)
    ?? (plan.imdbId ? local.shows.find((show) => show.externalIds.imdb === plan.imdbId) : undefined);
}

function sameEpisode(existing: WatchedEpisodeState, incoming: ImportedEpisodeState) {
  if (existing.tvmazeEpisodeId !== undefined && incoming.tvmazeEpisodeId !== undefined) {
    return existing.tvmazeEpisodeId === incoming.tvmazeEpisodeId;
  }
  if (existing.tvdbEpisodeId !== undefined && incoming.tvdbEpisodeId !== undefined) {
    return existing.tvdbEpisodeId === incoming.tvdbEpisodeId;
  }
  return existing.season === incoming.season && existing.episode === incoming.episode;
}

export function buildImportPreview(
  analysis: ImportAnalysis,
  decisions: ImportDecisions,
  local: LocalState,
): ImportPreview {
  const missingDecisions: string[] = analysis.report.providerErrors.map((error) => `${error.recordName}: ${error.message}`);
  if (analysis.report.unresolvedEpisodes > 0 && !decisions.unresolvedReviewed) {
    missingDecisions.push(`Review ${analysis.report.unresolvedEpisodes} unresolved TV Time episode record${analysis.report.unresolvedEpisodes === 1 ? "" : "s"}.`);
  }
  const plans: ImportShowPlan[] = [];
  const onboardingTiming = timing(analysis, local);
  const imdbOnly = analysis.records.filter((record) => record.kind === "imdb_only" && record.provider);
  const finished = imdbOnly.filter((record) => classifyOnboardingShow(onboardingShow(record), onboardingTiming) === "finished");
  const active = imdbOnly.filter((record) => !finished.includes(record));
  for (const record of analysis.records.filter((item) => item.kind === "conflict")) {
    if (!decisions.excludedConflictRecordIds.includes(record.id)) {
      missingDecisions.push(`Choose to exclude the unresolved ID conflict for ${record.imdb?.title ?? record.tvtime?.title ?? record.id}.`);
    }
  }

  const tvTimeOnly = analysis.records.filter((record) => record.kind === "tvtime_only" && record.provider);

  for (const record of analysis.records.filter((item) => item.kind === "matched" && item.provider && item.tvtime)) {
    plans.push(createPlan(record, tvTimeState(record, analysis, local), record.progress?.states ?? []));
  }
  for (const record of tvTimeOnly) {
    plans.push(createPlan(record, tvTimeState(record, analysis, local), record.progress?.states ?? []));
  }

  const finishedWithoutOverride = finished.filter((record) => !decisions.progressChoices[record.id]);
  if (finishedWithoutOverride.length > 0 && !decisions.finishedMode) {
    missingDecisions.push("Answer what the finished IMDb list contains.");
  }
  let mixtureDecisions = new Map<string, OnboardingDecision>();
  if (decisions.finishedMode === "mixture") {
    const results = applyFinishedMixture(
      finishedWithoutOverride.map(onboardingShow),
      decisions.finishedNotStartedRecordIds.filter((id) => finishedWithoutOverride.some((record) => record.id === id)),
      onboardingTiming,
    );
    mixtureDecisions = new Map(results.map((decision) => [decision.showId, decision]));
  }
  for (const record of finished) {
    const override = decisions.progressChoices[record.id];
    let decision: OnboardingDecision | undefined;
    if (override) decision = applyActiveProgressChoice(onboardingShow(record), override, onboardingTiming);
    else if (decisions.finishedMode === "watched_everything") decision = applyFinishedWatchedEverything(onboardingShow(record), onboardingTiming);
    else decision = mixtureDecisions.get(record.id);
    if (decision) plans.push(createPlan(record, decision.userState, toAssumptionProgress(decision, analysis.importedAt)));
  }

  for (const record of active) {
    const choice = decisions.progressChoices[record.id];
    if (!choice) {
      missingDecisions.push(`Set progress for ${record.imdb?.title ?? record.provider?.name ?? record.id}.`);
      continue;
    }
    const decision = applyActiveProgressChoice(onboardingShow(record), choice, onboardingTiming);
    plans.push(createPlan(record, decision.userState, toAssumptionProgress(decision, analysis.importedAt)));
  }

  const approved = new Set(decisions.replaceLocalProgressKeys);
  const localProgressConflicts: LocalProgressConflict[] = [];
  const localShowStateConflicts: LocalShowStateConflict[] = [];
  for (const plan of plans) {
    const existingShow = existingShowForPlan(local, plan);
    if (!existingShow) continue;
    const stateMayBeAnOlderLocalDecision = existingShow.userStateSource === "user"
      || (existingShow.userStateSource === undefined && existingShow.userState !== "progress_unknown");
    if (stateMayBeAnOlderLocalDecision && existingShow.userState !== plan.desiredState) {
      const key = `${plan.recordId}:state`;
      localShowStateConflicts.push({
        key,
        recordId: plan.recordId,
        showName: plan.title,
        existing: existingShow.userState,
        incoming: plan.desiredState,
        replaceApproved: approved.has(key),
      });
    }
    const existingProgress = local.progress.filter((state) => state.localShowId === existingShow.id && state.source === "user");
    for (const incoming of plan.progress) {
      const existing = existingProgress.find((state) => sameEpisode(state, incoming));
      if (!existing || existing.watched === incoming.watched) continue;
      const episode = plan.episodes.find((candidate) => candidate.id === incoming.tvmazeEpisodeId);
      const key = `${plan.recordId}:episode:${incoming.tvmazeEpisodeId ?? `${incoming.season}:${incoming.episode}`}`;
      localProgressConflicts.push({
        key,
        recordId: plan.recordId,
        showName: plan.title,
        episodeName: episode?.name ?? `S${incoming.season}E${incoming.episode}`,
        existing,
        incoming,
        replaceApproved: approved.has(key),
      });
    }
  }

  const existingCount = plans.filter((plan) => existingShowForPlan(local, plan)).length;
  const operationByRecordId = Object.fromEntries(plans.map((plan) => [plan.recordId, existingShowForPlan(local, plan) ? "update" : "new"])) as Record<string, "new" | "update">;
  return {
    sessionId: analysis.sessionId,
    ready: missingDecisions.length === 0,
    missingDecisions,
    plans,
    localProgressConflicts,
    localShowStateConflicts,
    operationByRecordId,
    committedShows: plans.length,
    newShows: plans.length - existingCount,
    updatedShows: existingCount,
    watchedStates: plans.reduce((total, plan) => total + plan.progress.filter((state) => state.watched).length, 0),
    explicitUnwatchedStates: plans.reduce((total, plan) => total + plan.progress.filter((state) => !state.watched).length, 0),
  };
}
