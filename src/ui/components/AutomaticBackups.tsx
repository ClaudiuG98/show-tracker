import { useEffect, useState } from "react";
import { configureBackups, readBackupDestination, readBackupSettings, type BackupDirectory, type BackupFrequency, type BackupSettings } from "../../backup/automatic-store";

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options: { mode: "readwrite"; id: string }) => Promise<BackupDirectory>;
}

export function AutomaticBackups() {
  const canChooseFolder = typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
  const [settings, setSettings] = useState<BackupSettings>();
  const [folder, setFolder] = useState("Downloads/Show Tracker Backups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedFrequency, setSelectedFrequency] = useState<BackupFrequency>();
  async function reload() {
    const current = await readBackupSettings();
    setSettings(current);
    setFolder((await readBackupDestination(current.destinationId))?.name ?? "Folder unavailable");
  }
  useEffect(() => {
    const refresh = () => void reload().catch(() => setError("Could not read backup settings."));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);
  async function act(operation: () => Promise<void>) {
    setBusy(true); setError("");
    try { await operation(); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Could not update backup settings."); }
    finally { await reload().catch(() => undefined); setBusy(false); }
  }
  async function tick(force = false) {
    const response = await chrome.runtime.sendMessage({ type: "AUTO_BACKUP_RUN", force });
    if (!response?.ok) throw new Error(response?.error ?? "Could not start backup. Reload the extension and try again.");
  }
  async function changeFrequency(frequency: BackupFrequency) {
    if (frequency !== "off" && settings?.destinationId === "downloads" && !await chrome.permissions.request({ permissions: ["downloads"] })) {
      throw new Error("Downloads permission was not granted. Automatic backups were not enabled.");
    }
    await configureBackups(frequency);
    await tick();
  }
  async function chooseFolder() {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) throw new Error("Folder selection is unavailable in this browser. Use the Downloads folder instead.");
    const selected = await picker.call(window, { mode: "readwrite", id: "show-tracker-backups" });
    if (await selected.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Write access to the selected folder was not granted.");
    await configureBackups(settings?.frequency ?? "off", selected);
    await tick();
  }
  async function reconnect() {
    const destination = await readBackupDestination(settings!.destinationId);
    if (!destination?.handle) throw new Error("Choose your backup folder again.");
    if (await destination.handle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("Folder access was not granted.");
    await configureBackups(settings!.frequency);
    await tick();
  }
  async function useDownloads() {
    if (settings?.frequency !== "off" && !await chrome.permissions.request({ permissions: ["downloads"] })) throw new Error("Downloads permission was not granted.");
    await configureBackups(settings?.frequency ?? "off", "downloads");
    await tick();
  }
  return <section className="automatic-backups" aria-labelledby="automatic-backups-title">
    <h3 id="automatic-backups-title">Automatic backups</h3>
    <p>Keep the latest five automatic backups. Older automatic files are removed only after a new backup succeeds; manual exports are left alone.</p>
    <div className="backup-frequency"><label htmlFor="backup-frequency">Frequency</label><select id="backup-frequency" value={selectedFrequency ?? settings?.frequency ?? "off"} disabled={busy || !settings} onChange={(event) => {
      const frequency = event.target.value as BackupFrequency;
      if (import.meta.env.FIREFOX) setSelectedFrequency(frequency);
      else void act(() => changeFrequency(frequency));
    }}>
      <option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly (recommended)</option><option value="monthly">Monthly</option>
    </select></div>
    {import.meta.env.FIREFOX && <button disabled={busy || !settings || selectedFrequency === undefined || selectedFrequency === settings.frequency} onClick={() => void act(async () => {
      await changeFrequency(selectedFrequency!);
      setSelectedFrequency(undefined);
    })}>Apply schedule</button>}
    <p className="backup-location"><strong>Folder:</strong> {folder}</p>
    <div className="show-actions">
      <button disabled={busy || !settings || !canChooseFolder} aria-describedby={!canChooseFolder ? "backup-folder-support" : undefined} onClick={() => void act(chooseFolder)}>Choose folder…</button>
      {settings?.destinationId !== "downloads" && settings && <><button disabled={busy} onClick={() => void act(reconnect)}>Reconnect folder</button><button disabled={busy} onClick={() => void act(useDownloads)}>Use Downloads folder</button></>}
      <button disabled={busy || !settings || settings.frequency === "off"} onClick={() => void act(() => tick(true))}>Back up now</button>
    </div>
    {!canChooseFolder && <p id="backup-folder-support" className="settings-help">Custom folder selection is disabled or unavailable in this browser. Automatic backups can still use Downloads/Show Tracker Backups. Firefox does not support the folder-picker API, and Brave disables it by default; Downloads backups do not require changing that setting.</p>}
    <p className="settings-help">Enabling a schedule makes the first backup now, then checks for changes at that interval while your browser is running. Missed backups run when the browser next starts. Unchanged and empty libraries are skipped. “Back up now” also saves unchanged data.</p>
    <p className="settings-help">Choose a dedicated backup folder outside the extension installation folder. Folder access may need reconnecting. Schedule and folder preferences stay on this browser and are not restored from a backup.</p>
    <p role="status">Last successful automatic backup: {settings?.lastSuccessAt ? new Date(settings.lastSuccessAt).toLocaleString() : "Not yet"}{settings?.message && <><br/>{settings.message}</>}</p>
    {(error || settings?.error) && <p className="error" role="alert">{error || settings?.error}</p>}
  </section>;
}
