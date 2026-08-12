import { z } from "zod";

export const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("OPEN_DASHBOARD"), route: z.string().max(200).default("/watch-list") }),
  z.object({ type: z.literal("GET_IMDB_STATUS"), imdbId: z.string().regex(/^tt\d+$/) }),
  z.object({ type: z.literal("GET_TRACKER_SUMMARY") }),
  z.object({ type: z.literal("TRACK_IMDB_SHOW"), imdbId: z.string().regex(/^tt\d+$/) }),
  z.object({ type: z.literal("SYNC_NOW") }),
]);
