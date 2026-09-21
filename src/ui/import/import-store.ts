import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ImportCommitResult } from "../../imports/commit";
import type { ImdbParseResult } from "../../imports/imdb";
import { emptyImportDecisions, type ImportDecisions, type ImportPreview } from "../../imports/preview";
import type { RefractParseResult } from "../../imports/refract";
import type { BingersParseResult } from "../../imports/bingers";
import type { ImportAnalysis, ImportStageProgress } from "../../imports/session";
import type { TvTimeParseResult } from "../../imports/tvtime";
import { chromeSessionStorage } from "../chromeSessionStorage";

export type ImportPhase = "select" | "parsed" | "analyzing" | "report" | "decisions" | "preview" | "committing" | "complete";

export interface SelectedImportFile {
  key: string;
  name: string;
  kind: "imdb" | "tvtime" | "refract" | "bingers";
}

export interface ImportUiState {
  phase: ImportPhase;
  imdb: ImdbParseResult | undefined;
  tvtime: TvTimeParseResult | undefined;
  bingers: BingersParseResult | undefined;
  // Not persisted to chrome.storage.session -- it carries a Map, which JSON.stringify would
  // silently flatten to {} and lose entirely. Surviving in-dashboard navigation (the common
  // case) already works via this being a module-level store; only a fully closed and reopened
  // tab loses a selected Refract file, same tradeoff already accepted for stageProgress/error.
  refract: RefractParseResult | undefined;
  selectedFiles: SelectedImportFile[];
  analysis: ImportAnalysis | undefined;
  decisions: ImportDecisions;
  preview: ImportPreview | undefined;
  stageProgress: ImportStageProgress | undefined;
  error: { title: string; message: string } | undefined;
  commitResult: ImportCommitResult | undefined;
  operationId: number;
}

const initialState = (operationId = 0): ImportUiState => ({
  phase: "select",
  imdb: undefined,
  tvtime: undefined,
  bingers: undefined,
  refract: undefined,
  selectedFiles: [],
  analysis: undefined,
  decisions: emptyImportDecisions(),
  preview: undefined,
  stageProgress: undefined,
  error: undefined,
  commitResult: undefined,
  operationId,
});

const PERSISTED_KEYS = ["phase", "imdb", "tvtime", "bingers", "selectedFiles", "analysis", "decisions", "preview", "commitResult"] as const;
type PersistedSlice = Pick<ImportUiState, (typeof PERSISTED_KEYS)[number]>;

export const useImportStore = create<ImportUiState>()(
  persist(
    () => initialState(),
    {
      name: "import-wizard-state",
      storage: createJSONStorage(() => chromeSessionStorage),
      partialize: (state): PersistedSlice => {
        const slice = {} as PersistedSlice;
        for (const key of PERSISTED_KEYS) (slice as Record<string, unknown>)[key] = state[key];
        return slice;
      },
      merge: (persisted, current) => {
        const restored = persisted as Partial<PersistedSlice> | undefined;
        if (!restored?.phase || restored.phase === "select" || restored.phase === "committing" || restored.phase === "complete") return current;
        return { ...current, ...restored, phase: restored.phase === "analyzing" ? "parsed" : restored.phase };
      },
    },
  ),
);

export function resetImportStore() {
  useImportStore.setState(initialState(useImportStore.getState().operationId + 1), true);
}
