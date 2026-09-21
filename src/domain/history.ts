import type { WatchedAction } from "./models";

export function groupHistoryByShow(history: WatchedAction[]) {
  const groups = new Map<string, { showId: string; actions: WatchedAction[]; watchedEpisodes: Set<string> }>();
  const ordered = [...history].sort((first, second) => (Date.parse(second.occurredAt) || 0) - (Date.parse(first.occurredAt) || 0));
  for (const action of ordered) {
    let group = groups.get(action.showId);
    if (!group) {
      group = { showId: action.showId, actions: [], watchedEpisodes: new Set() };
      groups.set(action.showId, group);
    }
    group.actions.push(action);
    if (action.action === "watched" || action.action === "bulk_watched") {
      for (const key of action.episodeKeys) group.watchedEpisodes.add(key);
    }
  }
  return [...groups.values()];
}
