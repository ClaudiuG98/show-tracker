import Papa from "papaparse";

export interface ImdbImportRow {
  imdbId: string;
  title: string;
  originalTitle?: string;
  titleType: "series" | "miniseries";
  year?: number;
  created?: string;
  position?: number;
  userRating?: number;
}
export interface ImportIssue { row: number; reason: string }
export interface ImdbParseResult {
  rows: ImdbImportRow[];
  malformed: ImportIssue[];
  unsupported: ImportIssue[];
  duplicates: string[];
  totalRows: number;
  schemaErrors: string[];
}

const aliases: Record<string, string[]> = {
  imdbId: ["const", "imdb id", "imdb title id"], title: ["title"], originalTitle: ["original title"],
  titleType: ["title type", "type"], year: ["year"], created: ["created", "date added"],
  position: ["position"], userRating: ["your rating", "user rating"],
};
const normalizeHeader = (value: string) => value.replace(/^\uFEFF/, "").trim().toLowerCase();
function find(record: Record<string, string>, field: keyof typeof aliases) {
  const key = Object.keys(record).find((candidate) => aliases[field]!.includes(normalizeHeader(candidate)));
  return key ? record[key]?.trim() : undefined;
}
function calendarDate(value?: string) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d ? value : undefined;
}

export function parseImdbCsv(csv: string): ImdbParseResult {
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.replace(/^\uFEFF/, "") });
  const rows: ImdbImportRow[] = [], malformed: ImportIssue[] = [], unsupported: ImportIssue[] = [], duplicates: string[] = [];
  const fields = parsed.meta.fields ?? [];
  const hasField = (field: keyof typeof aliases) => fields.some((candidate) => aliases[field]!.includes(normalizeHeader(candidate)));
  const schemaErrors = [
    ...(!hasField("imdbId") ? ["IMDb ID column is missing."] : []),
    ...(!hasField("title") ? ["Title column is missing."] : []),
    ...(!hasField("titleType") ? ["Title Type column is missing."] : []),
  ];
  const seen = new Set<string>();
  parsed.data.forEach((record, index) => {
    const row = index + 2, imdbId = find(record, "imdbId"), title = find(record, "title"), type = find(record, "titleType")?.toLowerCase();
    if (!imdbId || !/^tt\d+$/.test(imdbId) || !title) { malformed.push({ row, reason: "Missing or invalid IMDb ID/title" }); return; }
    const normalizedType = type?.replace(/\s+/g, " ");
    if (normalizedType !== "tv series" && normalizedType !== "tv mini series" && normalizedType !== "tv miniseries") {
      unsupported.push({ row, reason: `Unsupported title type: ${type ?? "missing"}` }); return;
    }
    if (seen.has(imdbId)) { duplicates.push(imdbId); return; }
    seen.add(imdbId);
    const number = (value?: string) => value?.trim() ? Number(value) : undefined;
    const year = number(find(record, "year")), position = number(find(record, "position")), rating = number(find(record, "userRating"));
    const originalTitle = find(record, "originalTitle"), created = calendarDate(find(record, "created"));
    rows.push({ imdbId, title, titleType: normalizedType === "tv series" ? "series" : "miniseries",
      ...(originalTitle ? { originalTitle } : {}), ...(year !== undefined && Number.isInteger(year) ? { year } : {}), ...(created ? { created } : {}),
      ...(position !== undefined && Number.isInteger(position) ? { position } : {}), ...(rating !== undefined && rating >= 1 && rating <= 10 ? { userRating: rating } : {}) });
  });
  parsed.errors.forEach((error) => malformed.push({ row: error.row === undefined ? 1 : error.row + 2, reason: error.message }));
  rows.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "") || (a.position ?? Infinity) - (b.position ?? Infinity));
  return { rows, malformed, unsupported, duplicates, totalRows: parsed.data.length, schemaErrors };
}

export function diffImdbImports(previous: ImdbImportRow[], next: ImdbImportRow[]) {
  const before = new Map(previous.map((row) => [row.imdbId, row]));
  const after = new Map(next.map((row) => [row.imdbId, row]));
  return {
    added: next.filter((row) => !before.has(row.imdbId)),
    unchanged: next.filter((row) => before.has(row.imdbId)),
    missing: previous.filter((row) => !after.has(row.imdbId)),
  };
}
