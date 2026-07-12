import { describe, expect, it } from "vitest";
import { parseImdbCsv } from "../../src/imports/imdb";
describe("IMDb CSV", () => {
  it("normalizes, filters, deduplicates and sorts", () => { const result=parseImdbCsv("Title Type,Title,Const,Created,Position\nTV Series,Old,tt1,2020-01-01,1\nMovie,No,tt2,2024-01-01,2\nTV Mini Series,New,tt3,2024-02-01,3\nTV Series,Again,tt1,2025-01-01,4"); expect(result.rows.map((x)=>x.imdbId)).toEqual(["tt3","tt1"]);expect(result.unsupported).toHaveLength(1);expect(result.duplicates).toEqual(["tt1"]); });
  it("accepts a BOM and header aliases",()=>expect(parseImdbCsv("\uFEFFIMDb ID,Title,Type,Date Added\ntt42,Show,TV Miniseries,2024-01-01").rows[0]?.titleType).toBe("miniseries"));
});
