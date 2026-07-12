import { describe, expect, it, vi } from "vitest";
import { TvMazeProvider } from "../../src/providers/tvmaze/provider";

describe("TVMaze image metadata", () => {
  it("preserves medium and original image variants through provider normalization", async () => {
    const provider = new TvMazeProvider({ cache: null, request: vi.fn(async () => ({ id: 1, name: "Silo", status: "Running", updated: 2,
      url: "https://www.tvmaze.com/shows/1", externals: { imdb: "tt1", thetvdb: 99 }, image: { medium: "https://static.tvmaze.com/medium.jpg", original: "https://static.tvmaze.com/original.jpg" } })) });
    await expect(provider.lookupByImdbId("tt1")).resolves.toMatchObject({ imageUrl: "https://static.tvmaze.com/medium.jpg", image: { medium: "https://static.tvmaze.com/medium.jpg", original: "https://static.tvmaze.com/original.jpg" } });
  });

  it("does not expose artwork outside TVMaze's approved static image host", async () => {
    const provider = new TvMazeProvider({ cache: null, request: vi.fn(async () => ({ id: 2, name: "Show", status: "Running", updated: 2,
      url: "https://www.tvmaze.com/shows/2", externals: { imdb: "tt2", thetvdb: null }, image: { medium: "https://example.com/image.jpg", original: null } })) });
    await expect(provider.lookupByImdbId("tt2")).resolves.not.toHaveProperty("image");
  });
});
