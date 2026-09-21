import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { BingersImportError, parseBingersZip, resolveBingersShows } from "../../src/imports/bingers";
import { bingersZip } from "../fixtures/bingers";

describe("Bingers export", () => {
  it("preserves exact show IDs, latest watch dates and repeat watches", () => {
    const result = parseBingersZip(bingersZip());
    expect(result.shows).toHaveLength(1);
    expect(result.shows[0]).toMatchObject({ tvdbShowId: 10, title: "Silo", createdAt: "2024-01-01T00:00:00.000Z", coverage: "watched_through",
      episodes: [{ season: 1, number: 2, watched: true, watchedAt: "2025-01-04T00:00:00.000Z", rewatchCount: 1 }] });
  });

  it("joins by ID rather than translated title, deduplicates episodes, and keeps same-name shows separate", () => {
    const result = parseBingersZip(bingersZip("show,Persona,Şahsiyet,2018,10,100,watching,\nshow,Persona,Persona,2019,11,101,stopped,",
      "episode,Şahsiyet,10,100,1,1,,,1\nepisode,Persona,10,100,1,1,,,3\nepisode,Persona,11,101,1,1,,,1"));
    expect(result.shows).toHaveLength(2);
    expect(result.shows[0]?.episodes).toHaveLength(1);
    expect(result.shows[0]?.episodes[0]?.rewatchCount).toBe(2);
    expect(result.shows[1]?.status).toBe("stopped");
  });

  it("keeps watch-later shows, recovers history-only shows and excludes movies", () => {
    const result = parseBingersZip(bingersZip("show,Silo,Silo,2023,10,100,for_later,\nmovie,A movie,,2023,20,200,watching,",
      "episode,Other show,30,300,1,1,,,1\nmovie,A movie,20,200,,,,,1"));
    expect(result.shows.map((show) => [show.title, show.status])).toEqual([["Silo", "not_started_yet"], ["Other show", "continuing"]]);
    expect(result.ignoredEntries).toHaveLength(2);
  });

  it("counts specials and ignores invalid episode rows and zero plays", () => {
    const result = parseBingersZip(bingersZip(undefined, "episode,Silo,10,100,0,1,,,1\nepisode,Silo,10,100,-1,2,,,1\nepisode,Silo,10,100,1,2,,,0"));
    expect(result.specials).toBe(1);
    expect(result.shows[0]?.episodes).toHaveLength(1);
    expect(result.ignoredEntries).toHaveLength(1);
  });

  it("uses title fallback only for TMDB-only shows", async () => {
    const parsed = parseBingersZip(bingersZip("show,Persona,Şahsiyet,2018,,100,watching,", "episode,Persona,,100,1,1,,,1"));
    const searchShows = vi.fn(async () => [{ provider: "tvmaze" as const, id: 200, name: "Şahsiyet", premiered: "2018-01-01",
      status: "running" as const, externalIds: { tvmazeShow: 200 }, updatedAt: 1 }]);
    expect((await resolveBingersShows(parsed, { searchShows })).shows[0]?.providerShowId).toBe(200);
    searchShows.mockClear();
    await resolveBingersShows(parseBingersZip(bingersZip()), { searchShows });
    expect(searchShows).not.toHaveBeenCalled();
  });

  it("leaves failed title matches unresolved instead of assigning a different show", async () => {
    const parsed = parseBingersZip(bingersZip("show,Persona,Şahsiyet,2018,,100,watching,", ""));
    expect((await resolveBingersShows(parsed, { searchShows: async () => [] })).shows[0]?.providerShowId).toBeUndefined();
  });

  it("distinguishes a non-Bingers ZIP from an incomplete Bingers export", () => {
    expect(() => parseBingersZip(zipSync({ "media.csv": strToU8("Title") }))).toThrow(expect.objectContaining({ code: "not_bingers" }));
    expect(() => parseBingersZip(zipSync({ "library.csv": strToU8("type,title") }))).toThrow(expect.objectContaining({ code: "schema" }));
    expect(() => parseBingersZip(zipSync({ "library.csv": strToU8("wrong\nvalue"), "watches.csv": strToU8("wrong\nvalue") }))).toThrow(BingersImportError);
  });

  it("rejects unsafe ZIP paths and oversized archives", () => {
    expect(() => parseBingersZip(zipSync({ "../library.csv": strToU8("bad") }))).toThrow(/Unsafe ZIP path/);
    expect(() => parseBingersZip(new Uint8Array(25 * 1024 * 1024 + 1))).toThrow(/25 MB/);
  });
});
