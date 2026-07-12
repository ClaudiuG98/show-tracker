import { describe,expect,it } from "vitest";
import { selectUpcomingShows, selectWatchListShows } from "../../src/domain/selectors";
import type { DomainState } from "../../src/domain/selectors";
const state:DomainState={settings:{timezone:"UTC",dateOnlyReleaseHour:"09:00"},providerShows:[],progress:[],shows:[{id:"s",externalIds:{tvmazeShow:1},titleSnapshot:"Show",userState:"watching",importSources:["manual"],createdAt:"",updatedAt:""}],episodes:[{id:1,showId:1,season:1,number:1,kind:"regular",airstamp:"2024-01-01T00:00:00Z"},{id:2,showId:1,season:1,number:2,kind:"regular",airstamp:"2024-01-02T00:00:00Z"},{id:3,showId:1,season:1,number:3,kind:"regular",airstamp:"2099-01-01T00:00:00Z"}]};
describe("watch list",()=>it("shows the earliest backlog episode and additional aired count",()=>{const item=selectWatchListShows(state,new Date("2025-01-01"))[0];expect(item?.episode.id).toBe(1);expect(item?.additional).toBe(1);}));

describe("watch list advancement", () => {
  it("advances locally, disappears when caught up, and leaves future episodes in Upcoming", () => {
    const oneWatched = { ...state, progress: [{ localShowId: "s", tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true, source: "user" as const }] };
    expect(selectWatchListShows(oneWatched, new Date("2025-01-01"))[0]).toMatchObject({ episode: { id: 2 }, additional: 0 });
    const caughtUp = { ...oneWatched, progress: [...oneWatched.progress, { localShowId: "s", tvmazeEpisodeId: 2, season: 1, episode: 2, watched: true, source: "user" as const }] };
    expect(selectWatchListShows(caughtUp, new Date("2025-01-01"))).toHaveLength(0);
    expect(selectUpcomingShows(caughtUp, new Date("2025-01-01"))[0]?.episode.id).toBe(3);
  });

  it.each(["not_started", "paused"] as const)("does not flood Watch List for %s shows", (userState) => {
    expect(selectWatchListShows({ ...state, shows: [{ ...state.shows[0]!, userState }] }, new Date("2025-01-01"))).toHaveLength(0);
  });
});
