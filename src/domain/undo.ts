import type { WatchedAction, WatchedEpisodeState } from "./models";
import type { LocalState } from "../storage/local-state";

const episodeKey = (episode: WatchedEpisodeState) => episode.tvmazeEpisodeId !== undefined
  ? `tvmaze:${episode.tvmazeEpisodeId}` : `number:${episode.season}:${episode.episode}`;

function equalEpisode(first: WatchedEpisodeState | undefined, second: WatchedEpisodeState | undefined) {
  return (first?.watched ?? false) === (second?.watched ?? false) &&
    (first?.rewatchCount ?? 0) === (second?.rewatchCount ?? 0);
}

function changesFor(action: WatchedAction) {
  const before = new Map(action.before.episodes.map((episode) => [episodeKey(episode), episode]));
  const after = new Map(action.after.episodes.map((episode) => [episodeKey(episode), episode]));
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => !equalEpisode(before.get(key), after.get(key)))
    .map((key) => ({ key, before: before.get(key), after: after.get(key) }));
}

export function undoConfirmation(action: WatchedAction) {
  const changes = changesFor(action);
  if (changes.length <= 1 && !action.action.startsWith("bulk_")) return undefined;
  const watched = changes.filter((change) => change.before?.watched).length;
  const direction = watched === changes.length ? "watched" : watched === 0 ? "unwatched" : undefined;
  const description = changes.length > 0 && direction
    ? `Mark ${changes.length === 1 ? "this episode" : `these ${changes.length} episodes`} ${direction}?`
    : `Undo this action affecting ${changes.length} episodes?`;
  return `${description} Your other progress will stay unchanged.${action.before.userState !== action.after.userState ? " The show's previous status will also be restored if it has not changed since." : ""}`;
}

export function undoHistoryAction(state: LocalState, actionId: string, now = new Date().toISOString()): LocalState {
  const index = state.history.findIndex((action) => action.id === actionId);
  if (index < 0) return state;
  const action = state.history[index]!;
  const show = state.shows.find((item) => item.id === action.showId);
  if (!show) throw new Error("This show is no longer tracked. Nothing was changed.");
  const current = new Map(state.progress.filter((episode) => episode.localShowId === action.showId).map((episode) => [episodeKey(episode), episode]));
  const changes = changesFor(action).filter((change) => !equalEpisode(current.get(change.key), change.before));
  const keys = new Set(changes.map((change) => change.key));
  const newer = state.history.slice(0, index).filter((item) => item.showId === action.showId);
  if (changes.some((change) => !equalEpisode(current.get(change.key), change.after)) ||
    newer.some((item) => changesFor(item).some((change) => keys.has(change.key)))) {
    throw new Error("Cannot undo: some affected episodes have changed since this action. Your newer progress was kept; edit those episodes on the show page instead.");
  }
  const statusChanged = action.before.userState !== action.after.userState;
  const newerActivity = newer.length > 0 || (show.progressUpdatedAt ?? "") > action.occurredAt || (show.userStateUpdatedAt ?? "") > action.occurredAt;
  const restoreStatus = statusChanged && show.userState === action.after.userState && !newerActivity;
  if (action.action === "state_changed" && statusChanged && !restoreStatus) {
    throw new Error("Cannot undo: this show's status or progress has changed since this action. Nothing was changed; edit the show on its detail page instead.");
  }
  return {
    ...state,
    progress: [
      ...state.progress.filter((episode) => episode.localShowId !== action.showId || !keys.has(episodeKey(episode))),
      ...changes.flatMap((change) => change.before ? [change.before] : []),
    ],
    shows: state.shows.map((item) => item.id !== show.id ? item : {
      ...item, updatedAt: now,
      ...(changes.length > 0 ? { progressUpdatedAt: now } : {}),
      ...(restoreStatus ? { userState: action.before.userState, userStateSource: "user" as const, userStateUpdatedAt: now } : {}),
    }),
    history: state.history.filter((item) => item.id !== action.id),
  };
}
