import type { TrackedShow, WatchedEpisodeState } from "../domain/models";
import { db } from "../storage/database";
import { updateLocalState } from "../storage/local-state";
import type { ImportDecisions, ImportPreview, ImportShowPlan } from "./preview";
import type { ImportedEpisodeState } from "./reconcile";
import type { ImportAnalysis } from "./session";

export class ImportCommitError extends Error {
  readonly code = "commit_failed";
  constructor(message = "Commit failed. Existing tracker state was not changed.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ImportCommitError";
  }
}

export interface ImportCommitResult {
  committed: number;
  newShows: number;
  updatedShows: number;
  watchedMapped: number;
  explicitUnwatchedMapped: number;
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

function episodeConflictKey(plan: ImportShowPlan, incoming: ImportedEpisodeState) {
  return `${plan.recordId}:episode:${incoming.tvmazeEpisodeId ?? `${incoming.season}:${incoming.episode}`}`;
}

function findTrackedShow(shows: TrackedShow[], plan: ImportShowPlan) {
  return shows.find((show) => show.externalIds.tvmazeShow === plan.provider.id)
    ?? (plan.imdbId ? shows.find((show) => show.externalIds.imdb === plan.imdbId) : undefined);
}

/**
 * Commits one fully prepared preview. Provider metadata is replaceable cache and
 * is written first; user-owned tracker state changes in one storage.local write.
 */
export async function commitImport(
  analysis: ImportAnalysis,
  preview: ImportPreview,
  decisions: ImportDecisions,
): Promise<ImportCommitResult> {
  if (analysis.report.providerErrors.length > 0) {
    throw new ImportCommitError("Commit failed: required provider requests must be retried first.");
  }
  if (analysis.sessionId !== preview.sessionId || !preview.ready) {
    throw new ImportCommitError("Commit failed: the import preview is incomplete or stale.");
  }

  const providerShows = new Map(preview.plans.map((plan) => [plan.provider.id, plan.provider]));
  const episodesByShow = new Map(preview.plans.map((plan) => [plan.provider.id, plan.episodes]));
  const providerIds = [...providerShows.keys()];
  let previousProviderShows = [] as typeof analysis.providerShows;
  let previousEpisodes = [] as ImportShowPlan["episodes"];
  try {
    if (providerIds.length > 0) {
      const [showSnapshots, episodeSnapshots] = await Promise.all([
        db.providerShows.bulkGet(providerIds),
        db.episodes.where("showId").anyOf(providerIds).toArray(),
      ]);
      previousProviderShows = showSnapshots.filter((show): show is NonNullable<typeof show> => Boolean(show));
      previousEpisodes = episodeSnapshots;
    }
    await db.transaction("rw", db.providerShows, db.episodes, async () => {
      await db.providerShows.bulkPut([...providerShows.values()]);
      for (const [showId, episodes] of episodesByShow) {
        await db.episodes.where("showId").equals(showId).delete();
        await db.episodes.bulkPut(episodes);
      }
    });
  } catch (cause) {
    throw new ImportCommitError("Commit failed while saving episode metadata. Existing tracker state was not changed.", { cause });
  }

  const replacements = new Set(decisions.replaceLocalProgressKeys);
  const now = new Date().toISOString();
  try {
    await updateLocalState((state) => {
      const shows = [...state.shows];
      let progress = [...state.progress];
      for (const plan of preview.plans) {
        let tracked = findTrackedShow(shows, plan);
        const stateMayBeAnOlderLocalDecision = Boolean(tracked && (tracked.userStateSource === "user"
          || (tracked.userStateSource === undefined && tracked.userState !== "progress_unknown")));
        const existingStateIsProtected = Boolean(tracked
          && stateMayBeAnOlderLocalDecision
          && (tracked.userState === plan.desiredState || !replacements.has(`${plan.recordId}:state`)));
        if (!tracked) {
          tracked = {
            id: crypto.randomUUID(),
            externalIds: { ...plan.provider.externalIds, ...(plan.imdbId ? { imdb: plan.imdbId } : {}) },
            titleSnapshot: plan.title,
            ...(plan.imdbAddedAt ? { imdbAddedAt: plan.imdbAddedAt } : {}),
            userState: plan.desiredState,
            userStateSource: "import",
            userStateUpdatedAt: now,
            importSources: plan.sources,
            providerUpdatedAt: plan.provider.updatedAt,
            ...(plan.progress.length > 0 ? { progressUpdatedAt: now } : {}),
            createdAt: now,
            updatedAt: now,
          };
          shows.push(tracked);
        } else {
          const existingTracked = tracked;
          const index = shows.findIndex((show) => show.id === existingTracked.id);
          const nextStateSource = existingStateIsProtected ? existingTracked.userStateSource : "import";
          const nextStateUpdatedAt = existingStateIsProtected ? existingTracked.userStateUpdatedAt : now;
          const nextTracked: TrackedShow = {
            ...existingTracked,
            externalIds: { ...existingTracked.externalIds, ...plan.provider.externalIds, ...(plan.imdbId ? { imdb: plan.imdbId } : {}) },
            titleSnapshot: plan.title,
            ...(plan.imdbAddedAt ? { imdbAddedAt: plan.imdbAddedAt } : {}),
            userState: existingStateIsProtected ? existingTracked.userState : plan.desiredState,
            ...(nextStateSource ? { userStateSource: nextStateSource } : {}),
            ...(nextStateUpdatedAt ? { userStateUpdatedAt: nextStateUpdatedAt } : {}),
            importSources: [...new Set([...existingTracked.importSources, ...plan.sources])],
            providerUpdatedAt: plan.provider.updatedAt,
            ...(plan.progress.length > 0 ? { progressUpdatedAt: now } : {}),
            updatedAt: now,
          };
          tracked = nextTracked;
          shows[index] = nextTracked;
        }

        const committedShow = tracked;

        if (!plan.sources.includes("tvtime")) {
          const regularIds = new Set(plan.episodes.filter((episode) => episode.kind === "regular").map((episode) => episode.id));
          progress = progress.filter((existing) => existing.localShowId !== committedShow.id
            || existing.source !== "assumption"
            || existing.tvmazeEpisodeId === undefined
            || !regularIds.has(existing.tvmazeEpisodeId));
        }
        for (const incoming of plan.progress) {
          const existing = progress.find((state) => state.localShowId === committedShow.id && sameEpisode(state, incoming));
          if (incoming.source === "assumption" && existing && !["assumption", "user"].includes(existing.source)) continue;
          if (existing?.source === "user"
            && (existing.watched === incoming.watched || !replacements.has(episodeConflictKey(plan, incoming)))) continue;
          progress = progress.filter((state) => state.localShowId !== committedShow.id || !sameEpisode(state, incoming));
          progress.push({ localShowId: committedShow.id, ...incoming });
        }
      }
      return {
        ...state,
        shows,
        progress,
        importCommit: { sessionId: analysis.sessionId, marker: "complete" },
      };
    });
  } catch (cause) {
    try {
      if (providerIds.length > 0) {
        await db.transaction("rw", db.providerShows, db.episodes, async () => {
          await db.providerShows.bulkDelete(providerIds);
          await db.episodes.where("showId").anyOf(providerIds).delete();
          await db.providerShows.bulkPut(previousProviderShows);
          await db.episodes.bulkPut(previousEpisodes);
        });
      }
    } catch (rollbackCause) {
      throw new ImportCommitError("Commit failed and cached metadata could not be rolled back. User progress was not replaced; Retry is safe.", { cause: rollbackCause });
    }
    throw new ImportCommitError("Commit failed while saving tracker state. Existing tracker state and metadata were restored.", { cause });
  }

  return {
    committed: preview.committedShows,
    newShows: preview.newShows,
    updatedShows: preview.updatedShows,
    watchedMapped: preview.watchedStates,
    explicitUnwatchedMapped: preview.explicitUnwatchedStates,
  };
}
