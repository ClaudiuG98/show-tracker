import { strToU8, zipSync } from "fflate";

export const bingersLibraryHeader = "type,title,original_title,year,tvdb_id,tmdb_id,list_status,added_at";
export const bingersWatchesHeader = "type,title,tvdb_id,tmdb_id,season_number,episode_number,first_watched_at,last_watched_at,plays";
export function bingersZip(library = "show,Silo,Silo,2023,10,100,watching,2024-01-01T00:00:00Z", watches = "episode,Silo,10,100,1,2,2025-01-03T00:00:00Z,2025-01-04T00:00:00Z,2") {
  return zipSync({ "library.csv": strToU8(`${bingersLibraryHeader}\n${library}`), "watches.csv": strToU8(`${bingersWatchesHeader}\n${watches}`) });
}
