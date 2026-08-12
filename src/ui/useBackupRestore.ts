import { parseBackup, type TrackerBackup } from "../backup/backup";
import { useBackupRestoreStore, type RestoreMessage, type RestoreSyncProgress } from "./backup-restore-store";
import { db } from "../storage/database";
import { writeLocalState } from "../storage/local-state";
import type { useTracker } from "./useTracker";

type Tracker = ReturnType<typeof useTracker>;

export function useBackupRestore(tracker: Tracker) {
  const { pendingBackup, restoreMessage, syncProgress } = useBackupRestoreStore();
  const setPendingBackup = (value: TrackerBackup | undefined) => useBackupRestoreStore.setState({ pendingBackup: value });
  const setRestoreMessage = (value: RestoreMessage | undefined) => useBackupRestoreStore.setState({ restoreMessage: value });
  const setSyncProgress = (value: RestoreSyncProgress | undefined) => useBackupRestoreStore.setState({ syncProgress: value });

  async function inspectFile(file: File) {
    try {
      setPendingBackup(parseBackup(await file.text()));
      setRestoreMessage(undefined);
      return true;
    } catch {
      setPendingBackup(undefined);
      setRestoreMessage({ kind: "error", text: "This is not a valid Tracker backup, or it was created by an unsupported version." });
      return false;
    }
  }

  function cancel() {
    setPendingBackup(undefined);
  }

  async function applyRestore() {
    if (!pendingBackup || !window.confirm(`Replace the current ${tracker.local?.shows.length ?? 0} shows with ${pendingBackup.state.shows.length} shows from this backup?`)) return;
    try {
      await writeLocalState(pendingBackup.state);
    } catch {
      setRestoreMessage({ kind: "error", text: "Restore failed before the replacement could be saved." });
      return;
    }
    const tvmazeIds = [...new Set(pendingBackup.state.shows.flatMap((show) => show.externalIds.tvmazeShow ? [show.externalIds.tvmazeShow] : []))];
    setPendingBackup(undefined);
    await tracker.reload();
    // Backups don't carry TVMaze artwork/episode data (that's intentionally re-fetched, not
    // stored), so surface that as an honest, non-blocking status instead of making the whole
    // restore action wait on a sync that can take minutes for a large library.
    setRestoreMessage({ kind: "pending", text: "Backup restored. Fetching show artwork and episode data now — this can take a few minutes for a large library." });
    setSyncProgress({ completed: 0, total: tvmazeIds.length });
    void (async () => {
      // Poll Dexie directly (not tracker.domain, which only updates via reload) and reload
      // periodically while the sync is in flight, since it writes show by show -- without
      // this, the UI would only pick up the newly-synced data all at once at the very end.
      // This runs as a plain background task independent of any component's lifecycle, so it
      // (and the shared store it updates) keeps going even if the user navigates elsewhere.
      const pollTimer = window.setInterval(async () => {
        const rows = await db.providerShows.bulkGet(tvmazeIds);
        setSyncProgress({ completed: rows.filter(Boolean).length, total: tvmazeIds.length });
        await tracker.reload();
      }, 1_500);
      try {
        const result = await chrome.runtime.sendMessage({ type: "SYNC_NOW" }) as { ok?: boolean; error?: string } | undefined;
        if (!result?.ok) throw new Error(result?.error ?? "Metadata refresh failed.");
        setRestoreMessage({ kind: "success", text: "Backup restored and TVMaze metadata refreshed." });
      } catch {
        setRestoreMessage({ kind: "error", text: "Backup restored, but metadata refresh didn’t finish. Some shows may be missing artwork or episodes — use Check for updates in Settings to retry." });
      } finally {
        window.clearInterval(pollTimer);
        setSyncProgress(undefined);
        await tracker.reload();
      }
    })();
  }

  return { pendingBackup, restoreMessage, syncProgress, inspectFile, cancel, applyRestore };
}
