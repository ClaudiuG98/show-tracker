import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseTvTimeZip } from "../../src/imports/tvtime";

describe("TV Time ZIP formats", () => {
  it("parses the official GDPR CSV export with ratings and watched episodes", () => {
    const archive = zipSync({
      "followed_tv_show.csv": strToU8([
        "tv_show_id,created_at,updated_at,active,archived,tv_show_name",
        "403245,2022-10-11 12:30:00,2022-10-11 12:30:00,1,0,Silo",
        "81189,2018-05-12 11:42:22,2018-05-12 11:42:22,0,1,Breaking Bad",
      ].join("\n")),
      "user_tv_show_data.csv": strToU8([
        "tv_show_id,is_followed,is_favorited,nb_episodes_seen,tv_show_name",
        "403245,1,0,0,Silo",
        "81189,1,0,0,Breaking Bad",
      ].join("\n")),
      "tv_show_rate.csv": strToU8([
        "tv_show_id,tv_show_name,rating,created_at,updated_at",
        "403245,Silo,4,2023-01-01 00:00:00,2023-01-01 00:00:00",
      ].join("\n")),
      "tracking-prod-records-v2.csv": strToU8([
        "s_id,ep_id,created_at,updated_at,series_name,s_no,ep_no,season_number,episode_number,ep_watch_count,is_special",
        "403245,9001,2023-01-02 10:00:00,2023-01-02 10:00:00,Silo,1,1,8,10,1,false",
        "403245,9002,2023-01-03 10:00:00,2023-01-03 10:00:00,Silo,1,2,8,11,2,false",
      ].join("\n")),
    });

    const result = parseTvTimeZip(archive);

    expect(result.shows).toHaveLength(2);
    expect(result.shows[0]).toMatchObject({
      uuid: "gdpr-tvdb-403245",
      tvdbShowId: 403245,
      title: "Silo",
      createdAt: "2022-10-11T12:30:00.000Z",
      rating: 4,
      status: "continuing",
      episodes: [
        { tvdbEpisodeId: 9001, season: 1, number: 1, watched: true, rewatchCount: 0 },
        { tvdbEpisodeId: 9002, season: 1, number: 2, watched: true, rewatchCount: 1 },
      ],
    });
    expect(result.shows[1]).toMatchObject({ tvdbShowId: 81189, status: "stopped", episodes: [] });
  });

  it("keeps watch history for a show that is no longer in the followed list", () => {
    const archive = zipSync({
      "followed_tv_show.csv": strToU8([
        "tv_show_id,created_at,updated_at,active,archived,tv_show_name",
        "403245,2022-10-11 12:30:00,2022-10-11 12:30:00,1,0,Silo",
      ].join("\n")),
      // Severance is absent from the followed list but still named by the summary.
      "user_tv_show_data.csv": strToU8([
        "tv_show_id,is_followed,is_favorited,nb_episodes_seen,tv_show_name",
        "403245,1,0,1,Silo",
        "371980,0,0,2,Severance",
      ].join("\n")),
      "tracking-prod-records-v2.csv": strToU8([
        "s_id,ep_id,created_at,updated_at,series_name,s_no,ep_no,ep_watch_count,is_special",
        "403245,9001,2023-01-02 10:00:00,2023-01-02 10:00:00,Silo,1,1,1,false",
        "371980,8001,2022-02-18 10:00:00,2022-02-18 10:00:00,Severance,1,1,1,false",
        "371980,8002,2022-02-25 10:00:00,2022-02-25 10:00:00,Severance,1,2,1,false",
        // Named only by the tracking rows, never by the summary.
        "356202,7001,2019-11-01 10:00:00,2019-11-01 10:00:00,For All Mankind,1,1,1,false",
      ].join("\n")),
    });

    const result = parseTvTimeZip(archive);

    expect(result.shows.map((show) => show.title)).toEqual(["Silo", "Severance", "For All Mankind"]);
    expect(result.shows[1]).toMatchObject({
      uuid: "gdpr-tvdb-371980", tvdbShowId: 371980, status: "continuing", coverage: "watched_through",
      createdAt: "2022-02-18T10:00:00.000Z",
      episodes: [{ tvdbEpisodeId: 8001, season: 1, number: 1, watched: true }, { tvdbEpisodeId: 8002, season: 1, number: 2, watched: true }],
    });
    expect(result.shows[2]).toMatchObject({ tvdbShowId: 356202, title: "For All Mankind" });
  });

  it("continues to parse the extension-generated JSON export", () => {
    const raw = [{
      uuid: "only", id: { tvdb: 403245, imdb: "tt14688458" }, created_at: "2024-01-01T00:00:00Z", title: "Silo",
      status: "continuing", is_favorite: false, _noEpisodeData: false,
      seasons: [{ number: 1, is_specials: false, episodes: [{ id: { tvdb: 9001, imdb: null }, number: 1, name: "One", special: false,
        is_watched: true, watched_at: "2025-01-03T00:00:00Z", rewatch_count: 0, watched_count: 1 }] }],
    }];

    const result = parseTvTimeZip(zipSync({ "export/tvtime-series-test.json": strToU8(JSON.stringify(raw)) }));

    expect(result.shows).toMatchObject([{ tvdbShowId: 403245, imdbId: "tt14688458", title: "Silo", episodes: [{ tvdbEpisodeId: 9001, watched: true }] }]);
  });
});
