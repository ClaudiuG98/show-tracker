import { create } from "zustand";
import type { ImportCommitResult } from "../../imports/commit";
import type { ImdbParseResult } from "../../imports/imdb";
import { emptyImportDecisions, type ImportDecisions, type ImportPreview } from "../../imports/preview";
import type { ImportAnalysis, ImportStageProgress } from "../../imports/session";
import type { TvTimeParseResult } from "../../imports/tvtime";

export type ImportPhase = "select" | "parsed" | "analyzing" | "report" | "decisions" | "preview" | "committing" | "complete";

export interface SelectedImportFile {
  key: string;
  name: string;
  kind: "imdb" | "tvtime";
}

export interface ImportUiState {
  phase: ImportPhase;
  imdb: ImdbParseResult | undefined;
  tvtime: TvTimeParseResult | undefined;
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
  selectedFiles: [],
  analysis: undefined,
  decisions: emptyImportDecisions(),
  preview: undefined,
  stageProgress: undefined,
  error: undefined,
  commitResult: undefined,
  operationId,
});

export const useImportStore = create<ImportUiState>(() => initialState());

export function resetImportStore() {
  useImportStore.setState(initialState(useImportStore.getState().operationId + 1), true);
}
