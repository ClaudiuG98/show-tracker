import { z } from "zod";

const imageSchema = z.object({ medium: z.string().url().nullable(), original: z.string().url().nullable() }).nullable();
export const tvMazeShowSchema = z.object({
  id: z.number().int().positive(), name: z.string(), status: z.string().nullable(), updated: z.number().int(),
  url: z.string().url().optional(), image: imageSchema.optional(),
  externals: z.object({ tvrage: z.number().nullable().optional(), thetvdb: z.number().nullable().optional(), imdb: z.string().nullable().optional() }),
});
export const tvMazeEpisodeSchema = z.object({
  id: z.number().int().positive(), name: z.string().nullable(), season: z.number().int().nonnegative(), number: z.number().int().nullable(),
  type: z.string().nullable().optional(), airdate: z.string().nullable(), airtime: z.string().nullable(), airstamp: z.string().nullable(),
});
export type TvMazeShowDto = z.infer<typeof tvMazeShowSchema>;
export type TvMazeEpisodeDto = z.infer<typeof tvMazeEpisodeSchema>;
