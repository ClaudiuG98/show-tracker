import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchedAction, WatchedEpisodeState } from "../../src/domain/models";
import { undoConfirmation, undoHistoryAction } from "../../src/domain/undo";
import { emptyLocalState, type LocalState } from "../../src/storage/local-state";
import { useTracker } from "../../src/ui/useTracker";

const occurredAt = "2026-01-01T12:00:00.000Z";
const later = "2026-01-02T12:00:00.000Z";
const episode = (number: number, watched = true): WatchedEpisodeState => ({
  localShowId: "show", tvmazeEpisodeId: number, season: 1, episode: number, watched, source: "user",
});
const action = (before: WatchedEpisodeState[], after: WatchedEpisodeState[]): WatchedAction => ({
  id: "action", showId: "show", episodeKeys: after.map((item) => String(item.tvmazeEpisodeId)),
  action: "watched", occurredAt,
  before: { episodes: before, userState: "watching" }, after: { episodes: after, userState: "watching" },
});
const stateFor = (selected: WatchedAction): LocalState => ({
  ...emptyLocalState(), history: [selected], progress: [...selected.after.episodes],
  shows: [{ id: "show", titleSnapshot: "Silo", externalIds: { tvmazeShow: 1 }, userState: selected.after.userState,
    createdAt: occurredAt, updatedAt: occurredAt, userStateUpdatedAt: occurredAt, progressUpdatedAt: occurredAt, importSources: ["manual"] }],
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("safe history undo", () => {
  it("undoes only the selected episode and preserves later episodes and other shows", () => {
    const selected = action([], [episode(1)]);
    const state = stateFor(selected);
    const newer = { ...action([episode(1)], [episode(1), episode(2)]), id: "newer", occurredAt: later };
    const otherShow = { ...episode(3), localShowId: "other" };
    state.history.unshift(newer);
    state.progress = [episode(1), episode(2), otherShow];
    const result = undoHistoryAction(state, selected.id);
    expect(result.progress).toEqual([episode(2), otherShow]);
    expect(result.history).toEqual([newer]);
    expect(state.progress).toHaveLength(3);
  });

  it("restores both watched and unwatched values from a bulk action without touching unchanged episodes", () => {
    const selected = action([episode(1, false), episode(2), episode(3)], [episode(1), episode(2, false), episode(3)]);
    selected.action = "bulk_watched";
    const state = stateFor(selected);
    state.progress.push(episode(4));
    expect(undoHistoryAction(state, selected.id).progress).toEqual([episode(3), episode(4), episode(1, false), episode(2)]);
  });

  it("blocks the whole undo when one affected episode has newer progress", () => {
    const selected = action([], [episode(1), episode(2)]);
    const state = stateFor(selected);
    state.progress = [episode(1), { ...episode(2), rewatchCount: 1 }];
    expect(() => undoHistoryAction(state, selected.id)).toThrow(/affected episodes have changed/);
    expect(state.progress).toEqual([episode(1), { ...episode(2), rewatchCount: 1 }]);
    expect(state.history).toEqual([selected]);
  });

  it("protects a later edit even if the current value returned to the same value", () => {
    const selected = action([], [episode(1)]);
    const state = stateFor(selected);
    state.history.unshift({ ...action([episode(1, false)], [episode(1)]), id: "newer", occurredAt: later });
    expect(() => undoHistoryAction(state, selected.id)).toThrow(/affected episodes have changed/);
  });

  it("does not mistake import provenance or timestamp changes for changed watch progress", () => {
    const selected = action([], [episode(1)]);
    const state = stateFor(selected);
    state.progress = [{ ...episode(1), source: "tvtime", watchedAt: later }];
    expect(undoHistoryAction(state, selected.id).progress).toEqual([]);
  });

  it("retires already-undone history without changing newer unwatched progress", () => {
    const selected = action([], [episode(1)]);
    const state = stateFor(selected);
    state.progress = [episode(1, false), episode(2)];
    const result = undoHistoryAction(state, selected.id);
    expect(result.progress).toEqual(state.progress);
    expect(result.history).toEqual([]);
  });

  it("does not unwatch episodes that were already watched before the selected action", () => {
    const selected = action([episode(1)], [{ ...episode(1), watchedAt: later }]);
    const state = stateFor(selected);
    const result = undoHistoryAction(state, selected.id);
    expect(result.progress).toEqual(state.progress);
    expect(result.history).toEqual([]);
  });

  it("undoes the remaining bulk changes while preserving episodes already reverted", () => {
    const selected = { ...action([], [episode(1), episode(2)]), action: "bulk_watched" as const };
    const state = stateFor(selected);
    state.progress = [episode(1), episode(2, false), episode(3)];
    expect(undoHistoryAction(state, selected.id).progress).toEqual([episode(2, false), episode(3)]);
  });

  it("preserves a newer show status when undoing an older episode", () => {
    const selected = action([], [episode(1)]);
    selected.before.userState = "not_started";
    const state = stateFor(selected);
    state.shows[0] = { ...state.shows[0]!, userState: "paused", userStateUpdatedAt: later };
    expect(undoHistoryAction(state, selected.id).shows[0]?.userState).toBe("paused");
  });

  it("does not put a show back to not-started when later episodes have been watched", () => {
    const selected = action([], [episode(1)]);
    selected.before.userState = "not_started";
    const state = stateFor(selected);
    state.progress.push(episode(2));
    state.shows[0] = { ...state.shows[0]!, progressUpdatedAt: later };
    expect(undoHistoryAction(state, selected.id).shows[0]?.userState).toBe("watching");
  });

  it("restores an untouched status action and its cleared progress", () => {
    const selected = action([episode(1), episode(2)], []);
    selected.action = "state_changed";
    selected.after.userState = "not_started";
    const state = stateFor(selected);
    const restored = undoHistoryAction(state, selected.id);
    expect(restored.progress).toEqual(selected.before.episodes);
    expect(restored.shows[0]?.userState).toBe("watching");
    state.shows[0] = { ...state.shows[0]!, userState: "paused", userStateUpdatedAt: later };
    expect(() => undoHistoryAction(state, selected.id)).toThrow(/status or progress has changed/);
  });

  it("does nothing when the entry was already removed", () => {
    const state = stateFor(action([], [episode(1)]));
    expect(undoHistoryAction(state, "missing")).toBe(state);
  });

  it("confirms only bulk changes with the actual affected count and direction", () => {
    expect(undoConfirmation(action([], [episode(1)]))).toBeUndefined();
    const bulk = { ...action([episode(3)], [episode(1), episode(2), episode(3)]), action: "bulk_watched" as const };
    expect(undoConfirmation(bulk)).toBe("Mark these 2 episodes unwatched? Your other progress will stay unchanged.");
    expect(undoConfirmation({ ...bulk, before: bulk.after, after: bulk.before, action: "bulk_unwatched" })).toBe("Mark these 2 episodes watched? Your other progress will stay unchanged.");
  });

  it("respects bulk cancellation and rechecks current progress after confirmation", async () => {
    const selected = { ...action([], [episode(1), episode(2)]), action: "bulk_watched" as const };
    let stored = stateFor(selected);
    vi.stubGlobal("chrome", { storage: { local: {
      get: vi.fn(async () => ({ trackerState: stored })),
      set: vi.fn(async (value: { trackerState: LocalState }) => { stored = value.trackerState; }),
    } } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useTracker());
    await waitFor(() => expect(result.current.local).toBeDefined());
    await act(async () => { await result.current.undo(selected); });
    expect(stored.history).toEqual([selected]);
    expect(stored.progress).toEqual(selected.after.episodes);

    confirm.mockImplementation(() => {
      stored = { ...stored, progress: [episode(1), { ...episode(2), rewatchCount: 1 }] };
      return true;
    });
    await act(async () => { await expect(result.current.undo(selected)).rejects.toThrow(/affected episodes have changed/); });
    expect(stored.history).toEqual([selected]);

    stored = { ...stored, progress: selected.after.episodes };
    confirm.mockReturnValue(true);
    await act(async () => { await result.current.undo(selected); });
    expect(stored.progress).toEqual([]);
    expect(stored.history).toEqual([]);
  });
});
