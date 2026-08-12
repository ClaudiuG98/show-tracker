import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ProviderShow } from "../../src/domain/models";
import { parseRefractZip, resolveRefractShows, RefractImportError, type RefractResolver } from "../../src/imports/refract";

function mediaCsv(rows: string[]) {
  return ["Title,OriginalTitle,Year,Type,Country,Status,Rating,WatchedDate,Review,Source", ...rows].join("\n");
}
function episodesCsv(rows: string[]) {
  return ["ShowTitle,ShowOriginalTitle,ShowType,ShowCountry,Season,Episode,WatchedAt,Rating", ...rows].join("\n");
}

describe("Refract ZIP parsing", () => {
  it("parses shows and groups watched episodes by show title", () => {
    const archive = zipSync({
      "media.csv": strToU8(mediaCsv([
        "Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract",
        "Attack on Titan,進撃の巨人,2013,Anime,JP,completed,,2023-11-18,,refract",
      ])),
      "episodes.csv": strToU8(episodesCsv([
        "Silo,Silo,TV Show,US,1,1,2023-05-01,",
        "Silo,Silo,TV Show,US,1,2,2023-05-08,",
        ",進撃の巨人,Anime,JP,1,1,2020-01-01,",
      ])),
    });

    const result = parseRefractZip(archive);

    expect(result.shows).toHaveLength(2);
    expect(result.shows[0]).toMatchObject({ title: "Silo", year: 2023, status: "completed", watchedDate: "2024-01-10" });
    const silo = result.episodesByShow.get(result.shows[0]!.key);
    expect(silo).toEqual([{ season: 1, number: 1, watchedAt: "2023-05-01" }, { season: 1, number: 2, watchedAt: "2023-05-08" }]);
    const aot = result.episodesByShow.get(result.shows[1]!.key);
    expect(aot).toEqual([{ season: 1, number: 1, watchedAt: "2020-01-01" }]);
  });

  it("falls back to OriginalTitle when Title is blank", () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([",The 8 Show,2024,TV Show,KR,completed,,2025-02-07,,refract"])) });

    const result = parseRefractZip(archive);

    expect(result.shows).toMatchObject([{ title: "The 8 Show" }]);
  });

  it("skips unsupported media types instead of importing movies", () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([
      "Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract",
      "Oppenheimer,Oppenheimer,2023,Movie,US,completed,,2024-01-10,,refract",
    ])) });

    const result = parseRefractZip(archive);

    expect(result.shows).toMatchObject([{ title: "Silo" }]);
    expect(result.unsupported).toHaveLength(1);
  });

  it("keeps same-title remakes apart by country instead of merging their episodes", () => {
    const archive = zipSync({
      "media.csv": strToU8(mediaCsv([
        "Dracula,Dracula,2013,TV Show,US,completed,,2024-01-10,,refract",
        "Dracula,Dracula,2020,TV Show,GB,completed,,2024-02-10,,refract",
      ])),
      "episodes.csv": strToU8(episodesCsv([
        "Dracula,Dracula,TV Show,US,1,1,2023-05-01,",
        "Dracula,Dracula,TV Show,GB,1,1,2023-06-01,",
        "Dracula,Dracula,TV Show,GB,1,2,2023-06-02,",
      ])),
    });

    const result = parseRefractZip(archive);

    expect(result.shows).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
    expect(result.episodesByShow.get(result.shows[0]!.key)).toEqual([{ season: 1, number: 1, watchedAt: "2023-05-01" }]);
    expect(result.episodesByShow.get(result.shows[1]!.key)).toEqual([
      { season: 1, number: 1, watchedAt: "2023-06-01" }, { season: 1, number: 2, watchedAt: "2023-06-02" },
    ]);
  });

  it("reports a duplicate when title and country both collide instead of dropping it silently", () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([
      "The Stand,The Stand,2020,TV Show,US,completed,,2024-01-10,,refract",
      "The Stand,The Stand,1994,TV Show,US,completed,,2024-01-11,,refract",
    ])) });

    const result = parseRefractZip(archive);

    expect(result.shows).toHaveLength(1);
    expect(result.duplicates).toMatchObject([{ row: 3, reason: expect.stringContaining("The Stand (1994), US") }]);
  });

  it("still joins episodes when the episode row's country is blank", () => {
    const archive = zipSync({
      "media.csv": strToU8(mediaCsv(["Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract"])),
      "episodes.csv": strToU8(episodesCsv(["Silo,Silo,TV Show,,1,1,2023-05-01,"])),
    });

    const result = parseRefractZip(archive);

    expect(result.episodesByShow.get(result.shows[0]!.key)).toEqual([{ season: 1, number: 1, watchedAt: "2023-05-01" }]);
  });

  it("throws a not_refract error for a ZIP that isn't a Refract export", () => {
    const archive = zipSync({ "followed_tv_show.csv": strToU8("tv_show_id,tv_show_name\n1,Silo") });

    const error = (() => { try { parseRefractZip(archive); } catch (cause) { return cause; } })();

    expect(error).toBeInstanceOf(RefractImportError);
    expect((error as RefractImportError).code).toBe("not_refract");
  });

  it("rejects a ZIP with no supported shows", () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Oppenheimer,Oppenheimer,2023,Movie,US,completed,,2024-01-10,,refract"])) });

    expect(() => parseRefractZip(archive)).toThrow(RefractImportError);
  });
});

describe("Refract show resolution", () => {
  const providerShow = (id: number, name: string, premiered: string): ProviderShow => ({
    provider: "tvmaze", id, name, status: "running", externalIds: {}, premiered, updatedAt: 0,
  });

  function resolverFor(byQuery: Record<string, ProviderShow[]>): RefractResolver {
    return { searchShows: async (query) => byQuery[query] ?? [] };
  }

  it("resolves a show to the best year-matched search result", async () => {
    const archive = zipSync({
      "media.csv": strToU8(mediaCsv(["Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract"])),
      "episodes.csv": strToU8(episodesCsv(["Silo,Silo,TV Show,US,1,1,2023-05-01,", "Silo,Silo,TV Show,US,1,2,2023-05-08,"])),
    });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Silo: [providerShow(1, "Silo (Wrong Year)", "1999-01-01"), providerShow(2, "Silo", "2023-05-04")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show).toMatchObject({
      providerShowId: 2,
      title: "Silo",
      status: "continuing",
      episodes: [
        { tvdbEpisodeId: -1, season: 1, number: 1, watched: true, watchedAt: "2023-05-01T00:00:00.000Z" },
        { tvdbEpisodeId: -2, season: 1, number: 2, watched: true, watchedAt: "2023-05-08T00:00:00.000Z" },
      ],
    });
  });

  it("leaves a show unresolved instead of guessing when no search result's year is close", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Old Show,Old Show,1975,TV Show,US,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ "Old Show": [providerShow(1, "Old Show", "2023-01-01")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBeUndefined();
  });

  it("leaves a show unresolved when the search returns nothing", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Obscure Show,Obscure Show,2023,TV Show,US,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({});

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBeUndefined();
  });

  it("maps a dropped show to the stopped status", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Silo,Silo,2023,TV Show,US,dropped,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Silo: [providerShow(2, "Silo", "2023-05-04")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.status).toBe("stopped");
  });

  it.each([
    ["completed", "all_aired"],
    ["up_to_date", "all_aired"],
    ["in_progress", "watched_through"],
    ["dropped", "watched_through"],
    ["unknown", "watched_through"],
  ])("maps the %s status to %s coverage", async (status, coverage) => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([`Silo,Silo,2023,TV Show,US,${status},,2024-01-10,,refract`])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Silo: [providerShow(2, "Silo", "2023-05-04")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.coverage).toBe(coverage);
  });

  it("retries the title without its subtitle when neither title finds anything", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([
      "Demon Slayer: Kimetsu no Yaiba,鬼滅の刃,2019,Anime,JP,completed,,2024-01-10,,refract",
    ])) });
    const parsed = parseRefractZip(archive);
    const queries: string[] = [];
    const resolver: RefractResolver = { searchShows: async (query) => {
      queries.push(query);
      return query === "Demon Slayer" ? [providerShow(7, "Demon Slayer", "2019-04-06")] : [];
    } };

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(queries).toEqual(["Demon Slayer: Kimetsu no Yaiba", "鬼滅の刃", "Demon Slayer"]);
    expect(show?.providerShowId).toBe(7);
  });

  it("finds a show TVMaze only indexes under its native title", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Trapped,Ófærð,2015,TV Show,IS,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({
      Trapped: [{ ...providerShow(1, "Cash Trapped", "2016-01-01"), country: "GB" }],
      "Ófærð": [{ ...providerShow(2, "Ófærð", "2015-01-01"), country: "IS" }],
    });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBe(2);
  });

  it("refuses a same-year near-miss from the wrong country instead of guessing", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Safe,Safe,2018,TV Show,GB,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Safe: [{ ...providerShow(1, "Safe Harbour", "2018-01-01"), country: "AU" }] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBeUndefined();
  });

  it("prefers the native-title match over a same-named show from elsewhere", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Persona,Şahsiyet,2018,TV Show,TR,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({
      Persona: [{ ...providerShow(1, "Persona", "2019-01-01"), country: "KR" }],
      "Şahsiyet": [{ ...providerShow(2, "Şahsiyet", "2018-01-01"), country: "TR" }],
    });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBe(2);
  });

  it("does not let a local same-named show outrank a global streamer that lists no country", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Kingdom,킹덤,2019,TV Show,KR,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({
      // The real show is on a global streamer, so TVMaze reports no country for it.
      Kingdom: [{ ...providerShow(1, "Kingdom", "2014-10-08"), country: "US" }, providerShow(2, "Kingdom", "2019-01-25")],
      "킹덤": [providerShow(2, "Kingdom", "2019-01-25"), { ...providerShow(3, "Kingdom", "2020-04-01"), country: "KR" }],
    });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBe(2);
  });

  it("keeps a co-production whose TVMaze country differs from the export's", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Mars,Mars,2016,TV Show,US,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Mars: [{ ...providerShow(1, "Mars", "2016-11-14"), country: "GB" }] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBe(1);
  });

  it("still accepts a subtitled TVMaze name when the year and country agree", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv(["Arcane,Arcane,2021,TV Show,US,completed,,2024-01-10,,refract"])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Arcane: [providerShow(9, "Arcane: League of Legends", "2021-11-06")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.providerShowId).toBe(9);
  });

  it("treats season 0 rows as specials so they are excluded rather than unmappable", async () => {
    const archive = zipSync({
      "media.csv": strToU8(mediaCsv(["Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract"])),
      "episodes.csv": strToU8(episodesCsv(["Silo,Silo,TV Show,US,0,1,2023-05-01,", "Silo,Silo,TV Show,US,1,1,2023-05-02,"])),
    });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Silo: [providerShow(2, "Silo", "2023-05-04")] });

    const [show] = await resolveRefractShows(parsed, resolver);

    expect(show?.episodes).toMatchObject([{ season: 0, number: 1, special: true }, { season: 1, number: 1, special: false }]);
  });

  it("reports resolution progress as it goes", async () => {
    const archive = zipSync({ "media.csv": strToU8(mediaCsv([
      "Silo,Silo,2023,TV Show,US,completed,,2024-01-10,,refract",
      "Severance,Severance,2022,TV Show,US,completed,,2024-01-10,,refract",
    ])) });
    const parsed = parseRefractZip(archive);
    const resolver = resolverFor({ Silo: [providerShow(1, "Silo", "2023-01-01")], Severance: [providerShow(2, "Severance", "2022-01-01")] });
    const ticks: Array<[number, number]> = [];

    await resolveRefractShows(parsed, resolver, (completed, total) => ticks.push([completed, total]));

    expect(ticks[0]).toEqual([0, 2]);
    expect(ticks.at(-1)).toEqual([2, 2]);
  });
});
