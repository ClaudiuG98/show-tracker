import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyLocalState, readLocalState, type LocalState } from "../../src/storage/local-state";

let stored: unknown;

beforeEach(() => {
  stored = undefined;
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => (stored ? { trackerState: stored } : {})) } },
  });
});

describe("readLocalState legacy repair", () => {
  it("drops a non-positive tvdbEpisodeId instead of failing the whole load", async () => {
    const base = emptyLocalState();
    stored = {
      ...base,
      progress: [
        { localShowId: "s1", tvdbEpisodeId: -1, season: 1, episode: 1, watched: true, source: "tvtime" },
        { localShowId: "s1", tvmazeEpisodeId: 50, tvdbEpisodeId: 500, season: 1, episode: 2, watched: true, source: "tvtime" },
      ],
    };

    const state = await readLocalState();

    expect(state.progress).toMatchObject([
      { localShowId: "s1", season: 1, episode: 1, watched: true },
      { localShowId: "s1", tvdbEpisodeId: 500, season: 1, episode: 2, watched: true },
    ]);
    expect(state.progress[0]!.tvdbEpisodeId).toBeUndefined();
  });

  it("leaves already-valid state untouched", async () => {
    stored = { ...emptyLocalState(), progress: [] } satisfies LocalState;

    const state = await readLocalState();

    expect(state.progress).toEqual([]);
  });
});
