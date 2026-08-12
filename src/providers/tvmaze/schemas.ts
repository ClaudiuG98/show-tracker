import { z } from "zod";

const imageSchema = z.object({ medium: z.string().url().nullable(), original: z.string().url().nullable() }).nullable();
export const tvMazeShowSchema = z.object({
  id: z.number().int().positive(), name: z.string(), status: z.string().nullable(), updated: z.number().int(),
  url: z.string().url().optional(), image: imageSchema.optional(),
  premiered: z.string().nullable().optional(), ended: z.string().nullable().optional(),
  rating: z.object({ average: z.number().nullable() }).optional(), genres: z.array(z.string()).optional(),
  runtime: z.number().nullable().optional(), averageRuntime: z.number().nullable().optional(),
  language: z.string().nullable().optional(), type: z.string().nullable().optional(),
  network: z.object({ name: z.string(), country: z.object({ code: z.string() }).nullable().optional() }).nullable().optional(),
  webChannel: z.object({ name: z.string(), country: z.object({ code: z.string() }).nullable().optional() }).nullable().optional(),
  externals: z.object({ tvrage: z.number().nullable().optional(), thetvdb: z.number().nullable().optional(), imdb: z.string().nullable().optional() }),
});
export const tvMazeEpisodeSchema = z.object({
  id: z.number().int().positive(), name: z.string().nullable(), season: z.number().int().nonnegative(), number: z.number().int().nullable(),
  type: z.string().nullable().optional(), airdate: z.string().nullable(), airtime: z.string().nullable(), airstamp: z.string().nullable(),
  runtime: z.number().nullable().optional(), summary: z.string().nullable().optional(), image: imageSchema.optional(),
  rating: z.object({ average: z.number().nullable() }).optional(),
});
export const tvMazeSearchResultSchema = z.object({ score: z.number(), show: z.unknown() });
export const tvMazeAlternateListSchema = z.object({ id: z.number().int().positive() });
export const tvMazeAlternateEpisodeSchema = z.object({
  season: z.number().int().nonnegative(), number: z.number().int().positive(), name: z.string().nullable().optional(),
  _embedded: z.object({ episodes: z.array(z.object({ id: z.number().int().positive() })) }).optional(),
});
