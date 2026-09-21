import { describe, expect, it } from "vitest";
import { groupHistoryByShow } from "../../src/domain/history";
import type { WatchedAction } from "../../src/domain/models";

function action(id: string, showId: string, day: number, episodeKeys: string[], kind: WatchedAction["action"] = "watched"): WatchedAction {
  return { id, showId, episodeKeys, action: kind, occurredAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
    before: { episodes: [], userState: "watching" }, after: { episodes: [], userState: "watching" } };
}

describe("history groups", () => {
  it("stacks interleaved shows with newest shows and actions first without mutating history", () => {
    const history = [action("old", "bodies", 1, ["1"]), action("other", "silo", 2, ["3"]), action("new", "bodies", 3, ["2"])];
    const groups = groupHistoryByShow(history);
    expect(groups.map((group) => group.showId)).toEqual(["bodies", "silo"]);
    expect(groups[0]?.actions.map((entry) => entry.id)).toEqual(["new", "old"]);
    expect(history.map((entry) => entry.id)).toEqual(["old", "other", "new"]);
  });

  it("deduplicates episodes across single and bulk actions without counting unwatched or status changes", () => {
    const groups = groupHistoryByShow([
      action("single", "bodies", 1, ["1"]), action("bulk", "bodies", 2, ["1", "2", "3"], "bulk_watched"),
      action("repeat", "bodies", 3, ["2"]), action("unwatched", "bodies", 4, ["4"], "unwatched"),
      action("status", "bodies", 5, [], "state_changed"),
    ]);
    expect(groups[0]?.watchedEpisodes.size).toBe(3);
    expect(groups[0]?.actions).toHaveLength(5);
    expect(groupHistoryByShow([action("status", "silo", 1, [], "state_changed")])[0]?.watchedEpisodes.size).toBe(0);
    expect(groupHistoryByShow([])).toEqual([]);
  });
});
