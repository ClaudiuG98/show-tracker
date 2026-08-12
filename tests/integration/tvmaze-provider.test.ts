import { beforeEach, describe, expect, it, vi } from "vitest";
import { TvMazeProvider, TvMazeProviderError } from "../../src/providers/tvmaze/provider";
import type { TvMazeRequest } from "../../src/providers/tvmaze/client";
import { db } from "../../src/storage/database";

const showDto = {
  id: 101,
  name: "Silo",
  status: "Running",
  updated: 1_700_000_000,
  url: "https://www.tvmaze.com/shows/101/silo",
  image: null,
  externals: { tvrage: null, thetvdb: 403245, imdb: "tt14688458" },
};

const episodeDtos = [{
  id: 1001,
  name: "Freedom Day",
  season: 1,
  number: 1,
  type: "regular",
  airdate: "2023-05-05",
  airtime: "00:00",
  airstamp: "2023-05-05T00:00:00Z",
}];

describe("TVMaze provider cache", () => {
  beforeEach(async () => {
    await db.cache.clear();
  });

  it("uses the exact TVDB lookup endpoint", async () => {
    const request = vi.fn<TvMazeRequest>(async () => showDto);
    const provider = new TvMazeProvider({ request, now: () => 1_000 });

    const show = await provider.lookupByTvdbId(403245);

    expect(request).toHaveBeenCalledWith("/lookup/shows?thetvdb=403245");
    expect(show).toMatchObject({
      id: 101,
      externalIds: { imdb: "tt14688458", tvdbShow: 403245, tvmazeShow: 101 },
    });
  });

  it("reuses successful exact lookups and episodes across provider instances", async () => {
    const request = vi.fn<TvMazeRequest>(async (path) => path.endsWith("/episodes") ? episodeDtos : showDto);
    const first = new TvMazeProvider({ request, now: () => 1_000 });

    await expect(first.lookupByImdbId("tt14688458")).resolves.toMatchObject({ id: 101 });
    await expect(first.lookupByTvdbId(403245)).resolves.toMatchObject({ id: 101 });
    await expect(first.getEpisodes(101)).resolves.toMatchObject([{ id: 1001, showId: 101 }]);

    const second = new TvMazeProvider({ request, now: () => 2_000 });
    await second.lookupByImdbId("tt14688458");
    await second.lookupByTvdbId(403245);
    await second.getEpisodes(101);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/lookup/shows?imdb=tt14688458",
      "/shows/101/episodes",
    ]);
    expect(await db.cache.count()).toBe(3);
  });

  it("does not cache a missing exact lookup", async () => {
    const request = vi.fn<TvMazeRequest>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(showDto);
    const provider = new TvMazeProvider({ request, now: () => 1_000 });

    await expect(provider.lookupByTvdbId(403245)).resolves.toBeNull();
    await expect(provider.lookupByTvdbId(403245)).resolves.toMatchObject({ id: 101 });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces a missing episode response as a stage-detectable provider error", async () => {
    const provider = new TvMazeProvider({ request: async () => null, now: () => 1_000 });

    const error = await provider.getEpisodes(101).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TvMazeProviderError);
    expect(error).toMatchObject({ kind: "episode_metadata" });
  });

  it("classifies TVMaze significant and insignificant specials outside season zero", async () => {
    const request = vi.fn<TvMazeRequest>(async () => [
      { ...episodeDtos[0], id: 1001, season: 2, type: "regular" },
      { ...episodeDtos[0], id: 1002, season: 2, number: 2, type: "significant_special" },
      { ...episodeDtos[0], id: 1003, season: 2, number: 3, type: "insignificant_special" },
    ]);
    const provider = new TvMazeProvider({ request, cache: null });
    await expect(provider.getEpisodes(101)).resolves.toMatchObject([
      { id: 1001, kind: "regular" }, { id: 1002, kind: "special" }, { id: 1003, kind: "special" },
    ]);
  });

  it("searches shows by title and normalizes each result", async () => {
    const request = vi.fn<TvMazeRequest>(async () => [{ score: 0.9, show: showDto }]);
    const provider = new TvMazeProvider({ request, cache: null });

    const results = await provider.searchShows("Silo");

    expect(request).toHaveBeenCalledWith("/search/shows?q=Silo");
    expect(results).toMatchObject([{ id: 101, name: "Silo" }]);
  });

  it("skips malformed search entries instead of throwing", async () => {
    const request = vi.fn<TvMazeRequest>(async () => [{ score: 0.9, show: { id: "not-a-number" } }, { score: 0.5, show: showDto }]);
    const provider = new TvMazeProvider({ request, cache: null });

    const results = await provider.searchShows("Silo");

    expect(results).toMatchObject([{ id: 101 }]);
  });

  it("returns no results for a blank query without making a request", async () => {
    const request = vi.fn<TvMazeRequest>(async () => []);
    const provider = new TvMazeProvider({ request, cache: null });

    await expect(provider.searchShows("   ")).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
