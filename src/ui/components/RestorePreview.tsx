import type { TrackerBackup } from "../../backup/backup";
import { AsyncButton } from "./AsyncButton";

export function RestorePreview({ backup, onCancel, onConfirm }: {
  backup: TrackerBackup;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return <div className="restore-preview"><h3>Review backup before replacing local data</h3><dl>
    <div><dt>Exported</dt><dd>{new Date(backup.exportedAt).toLocaleString()}</dd></div>
    <div><dt>Shows</dt><dd>{backup.state.shows.length}</dd></div>
    <div><dt>Progress records</dt><dd>{backup.state.progress.length}</dd></div>
    <div><dt>History actions</dt><dd>{backup.state.history.length}</dd></div>
  </dl><p>This replaces the current local tracker state. It does not merge the two libraries.</p>
    <div className="show-actions"><button onClick={onCancel}>Cancel</button><AsyncButton className="danger" busyLabel="Replacing…" onAction={onConfirm}>Replace local data</AsyncButton></div>
  </div>;
}
