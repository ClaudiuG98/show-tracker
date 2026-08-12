import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { TrackerBackup } from "../backup/backup";
import { chromeSessionStorage } from "./chromeSessionStorage";

export interface RestoreSyncProgress { completed: number; total: number }
export interface RestoreMessage { kind: "error" | "success" | "pending"; text: string }

export interface BackupRestoreState {
  pendingBackup: TrackerBackup | undefined;
  restoreMessage: RestoreMessage | undefined;
  // Not persisted -- a live background watcher drives this (see useBackupRestore), and that
  // watcher dies with a closed tab. Mirrors how the CSV/TV Time wizard's own stageProgress is
  // deliberately excluded from persistence for the same reason.
  syncProgress: RestoreSyncProgress | undefined;
}

const initialState: BackupRestoreState = { pendingBackup: undefined, restoreMessage: undefined, syncProgress: undefined };

const PERSISTED_KEYS = ["pendingBackup", "restoreMessage"] as const;
type PersistedSlice = Pick<BackupRestoreState, (typeof PERSISTED_KEYS)[number]>;

// A module-level store (not component useState) so a restore in progress -- and its live
// progress bar -- survives navigating to another page in the dashboard and back, the same way
// the CSV/TV Time import wizard's own state already does.
export const useBackupRestoreStore = create<BackupRestoreState>()(
  persist(
    () => initialState,
    {
      name: "backup-restore-state",
      storage: createJSONStorage(() => chromeSessionStorage),
      partialize: (state): PersistedSlice => {
        const slice = {} as PersistedSlice;
        for (const key of PERSISTED_KEYS) (slice as Record<string, unknown>)[key] = state[key];
        return slice;
      },
    },
  ),
);

export function resetBackupRestoreStore() {
  useBackupRestoreStore.setState(initialState, true);
}
