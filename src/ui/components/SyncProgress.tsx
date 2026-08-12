import type { RestoreSyncProgress } from "../backup-restore-store";

export function SyncProgress({ progress }: { progress: RestoreSyncProgress }) {
  const message = `${progress.completed} of ${progress.total} shows synced so far.`;
  return <section className="report" aria-live="polite">
    <h2>Fetching show artwork and episodes</h2>
    <p>{message}</p>
    <progress aria-label={message} value={progress.completed} max={Math.max(1, progress.total)}/>
    <div className="import-skeleton" aria-hidden="true"><span/><span/><span/></div>
  </section>;
}
