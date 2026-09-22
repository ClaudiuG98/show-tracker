import { useState } from "react";
import type { ProviderEpisode } from "../../domain/models";
import { parseImdbCsv, type ImdbParseResult } from "../../imports/imdb";
import { commitImport } from "../../imports/commit";
import {
  classifyOnboardingShow,
  getAvailableRegularEpisodes,
  type ActiveProgressChoice,
  type OnboardingTiming,
} from "../../imports/onboarding";
import {
  buildImportPreview,
  emptyImportDecisions,
  type ImportDecisions,
  type ImportPreview,
} from "../../imports/preview";
import {
  analyzeImport,
  selectFullImportSources,
  type ImportAnalysis,
  type ImportProviderError,
  type ImportShowRecord,
} from "../../imports/session";
import { parseRefractZip, resolveRefractShows, RefractImportError } from "../../imports/refract";
import { BingersImportError, parseBingersZip, resolveBingersShows } from "../../imports/bingers";
import { parseTvTimeZip, TvTimeImportError } from "../../imports/tvtime";
import { TvMazeProvider } from "../../providers/tvmaze/provider";
import type { useTracker } from "../useTracker";
import { useBackupRestore } from "../useBackupRestore";
import { posterUrls } from "../../domain/view-models";
import { Poster } from "../components/Poster";
import { RestorePreview } from "../components/RestorePreview";
import { SyncProgress } from "../components/SyncProgress";
import { TvMazeAttribution } from "../components/Attribution";
import { resetImportStore, useImportStore, type ImportPhase, type SelectedImportFile } from "./import-store";

type Tracker = ReturnType<typeof useTracker>;
type Phase = ImportPhase;
const importProvider = new TvMazeProvider();

function providerErrorLabel(error: ImportProviderError) {
  switch (error.code) {
    case "tvdb_lookup_failed": return "TVDB lookup failed";
    case "rate_limit": return "TVMaze rate limit reached";
    case "episode_metadata_failed": return "Episode metadata could not be loaded";
    default: return "Provider/network error";
  }
}

function ErrorPanel({ title, message, retry }: { title: string; message: string; retry: (() => void) | undefined }) {
  return <section className="error-panel" role="alert"><h2>{title}</h2><p>{message}</p>
    {retry && <button type="button" onClick={retry}>Retry</button>}</section>;
}

function RecordNames({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  return <details className="record-list"><summary>{title} ({names.length})</summary><ul>{names.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}</ul></details>;
}

/**
 * Everything an import can tell you, kept out of the way.
 *
 * These counters exist to explain a surprising result -- a show that matched the wrong TVMaze
 * entry, progress that did not carry over -- and are meaningless the rest of the time, so the
 * summary above stays to what actually needs acting on.
 */
function TechnicalDetails({ analysis }: { analysis: ImportAnalysis }) {
  const report = analysis.report;
  const values: Array<[string, number]> = [
    ["IMDb rows parsed", report.imdbRowsParsed],
    ["TV Time shows parsed", report.tvTimeShowsParsed],
    ["Exact IMDb matches", report.exactImdbMatches],
    ["Exact TVDB matches", report.exactTvdbMatches],
    ["Successfully merged records", report.successfullyMerged],
    ["IMDb-only records", report.imdbOnly],
    ["TV Time-only records", report.tvTimeOnly],
    ["Conflicts", report.conflicts],
    ["Unmatched shows", report.unmatchedShows],
    ["TV Time episodes parsed", report.tvTimeEpisodesParsed],
    ["Watched episodes mapped", report.watchedEpisodesMapped],
    ["Explicit unwatched episodes mapped", report.explicitUnwatchedEpisodesMapped],
    ["Future episodes excluded from backlog", report.futureEpisodesExcludedFromBacklog],
    ["Specials excluded", report.specialsExcluded],
    ["Unresolved episodes", report.unresolvedEpisodes],
    ["Episodes filled from watched-only exports", report.episodesBackfilled],
    ["Provider/network errors", report.providerNetworkErrors],
  ];
  return <details className="technical-details"><summary>Technical details</summary>
    <dl className="report-metrics">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <RecordNames title="Conflicting records" names={report.conflictNames}/>
    <RecordNames title="TV Time-only shows" names={report.tvTimeOnlyNames}/>
    {report.unresolvedEpisodeRecords.length > 0 && <details className="record-list"><summary>Progress could not be mapped ({report.unresolvedEpisodeRecords.length})</summary><ul>
      {report.unresolvedEpisodeRecords.map((episode, index) => <li key={`${episode.show}:${episode.tvdbEpisodeId}:${index}`}>{episode.show} — S{episode.season}E{episode.episode} {episode.name}</li>)}
    </ul></details>}
    {report.numberingConflicts.length > 0 && <details className="record-list"><summary>Season/episode numbering conflicts ({report.numberingConflicts.length})</summary><ul>
      {report.numberingConflicts.map((conflict, index) => <li key={`${conflict.show}:${index}`}>{conflict.show} — {conflict.episode}: {conflict.sourceNumber} → {conflict.providerNumber}</li>)}
    </ul></details>}
    {report.backfilledShows.length > 0 && <details className="record-list"><summary>Episodes filled from watched-only exports ({report.backfilledShows.length} shows)</summary>
      <p className="record-list-note">Refract and the TV Time GDPR export only record episodes you watched, so gaps were filled from each show’s status. A count far larger than the show’s real length usually means it matched the wrong TVMaze show.</p><ul>
      {report.backfilledShows.map((entry, index) => <li key={`${entry.show}:${index}`}>{entry.show} — {entry.count} episode{entry.count === 1 ? "" : "s"}</li>)}
    </ul></details>}
  </details>;
}

/**
 * Whether this import actually has something to ask about. IMDb rows carry no watch history, so
 * their progress has to be chosen; an exact-ID conflict has to be resolved explicitly. Anything
 * else is fully determined by the export and never needs a screen.
 */
function needsDecisions(analysis: ImportAnalysis) {
  return analysis.records.some((record) => (record.kind === "imdb_only" && record.provider) || record.kind === "conflict");
}

/** The one thing worth acting on after an import: shows that were skipped. */
function SkippedShows({ analysis }: { analysis: ImportAnalysis }) {
  const names = analysis.report.unmatchedNames;
  if (names.length === 0) return null;
  return <details className="record-list skipped-shows"><summary>{names.length} show{names.length === 1 ? "" : "s"} couldn’t be matched and {names.length === 1 ? "was" : "were"} skipped</summary>
    <p className="record-list-note">TVMaze has no entry matching these. You can add them by hand from the Library.</p>
    <ul>{names.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}</ul></details>;
}


function recordTiming(analysis: ImportAnalysis, tracker: Tracker): OnboardingTiming {
  return {
    importInstant: new Date(analysis.importedAt),
    timezone: tracker.local!.settings.timezone,
    dateOnlyReleaseHour: tracker.local!.settings.dateOnlyReleaseHour,
  };
}

function availableEpisodes(record: ImportShowRecord, analysis: ImportAnalysis, tracker: Tracker) {
  return getAvailableRegularEpisodes({ episodes: record.episodes }, recordTiming(analysis, tracker));
}

function episodeLabel(episode: ProviderEpisode) {
  return `S${episode.season}E${episode.number}${episode.name ? ` — ${episode.name}` : ""}`;
}

function FinishedShowChoice({ record, analysis, tracker, checked, value, uncheckedLabel = "Treat as fully watched", onToggle, onChange }: {
  record: ImportShowRecord;
  analysis: ImportAnalysis;
  tracker: Tracker;
  checked: boolean;
  value: ActiveProgressChoice | undefined;
  uncheckedLabel?: string;
  onToggle: (checked: boolean) => void;
  onChange: (choice: ActiveProgressChoice | undefined) => void;
}) {
  const title = record.imdb?.title ?? record.provider?.name ?? "Untitled show", episodes = availableEpisodes(record, analysis, tracker);
  const selectValue = value?.kind === "last_watched" ? String(value.tvmazeEpisodeId) : value?.kind === "manual" ? "manual" : "";
  const manualIds = value?.kind === "manual" ? value.watchedTvmazeEpisodeIds : [];
  return <article className={`onboarding-show-choice ${checked ? "selected" : ""}`}>
    <label className="choice-heading"><input type="checkbox" checked={checked} onChange={(event) => onToggle(event.target.checked)}/><Poster title={title} {...posterUrls(record.provider)}/><span><strong>{title}</strong><small>{checked ? "Progress needed" : uncheckedLabel}</small></span></label>
    {checked && <div className="quick-progress"><label>Latest episode watched<select value={selectValue} onChange={(event) => {
      if (!event.target.value) onChange(undefined);
      else if (event.target.value !== "manual") onChange({ kind: "last_watched", tvmazeEpisodeId: Number(event.target.value) });
    }}><option value="">None — not started</option>{selectValue === "manual" && <option value="manual" disabled>Manual episode selection</option>}{episodes.map((episode) => <option key={episode.id} value={episode.id}>{episodeLabel(episode)}</option>)}</select></label>
      <small>Selecting an episode marks it and every earlier aired regular episode watched.</small>
      <details className="manual-progress"><summary>Select individual episodes instead</summary><fieldset className="episode-choice"><legend className="sr-only">Watched episodes for {title}</legend>{episodes.map((episode) => { const episodeChecked = manualIds.includes(episode.id); return <label key={episode.id}><input type="checkbox" checked={episodeChecked} onChange={(event) => onChange({ kind: "manual", watchedTvmazeEpisodeIds: event.target.checked ? [...manualIds, episode.id] : manualIds.filter((id) => id !== episode.id) })}/>{episodeLabel(episode)}</label>; })}</fieldset></details>
    </div>}
  </article>;
}

function DecisionsView({ analysis, tracker, decisions, setDecisions }: {
  analysis: ImportAnalysis;
  tracker: Tracker;
  decisions: ImportDecisions;
  setDecisions: (value: ImportDecisions) => void;
}) {
  const [setupSearch, setSetupSearch] = useState(""), [setupFilter, setSetupFilter] = useState<"all" | "selected" | "unselected">("all");
  const timing = recordTiming(analysis, tracker);
  const imdbOnly = analysis.records.filter((record) => record.kind === "imdb_only" && record.provider);
  const finished = imdbOnly.filter((record) => classifyOnboardingShow({ id: record.id, providerStatus: record.provider!.status, episodes: record.episodes }, timing) === "finished")
    .sort((a, b) => (b.imdb?.created ?? "").localeCompare(a.imdb?.created ?? ""));
  const orderedImdbOnly = [...imdbOnly].sort((a, b) => (b.imdb?.created ?? "").localeCompare(a.imdb?.created ?? ""));
  const finishedIds = new Set(finished.map((record) => record.id));
  const conflicts = analysis.records.filter((record) => record.kind === "conflict");
  const updateChoice = (id: string, choice: ActiveProgressChoice | undefined) => setDecisions({ ...decisions, progressChoices: {
    ...decisions.progressChoices,
    ...(choice ? { [id]: choice } : {}),
  }});
  const toggleFinished = (id: string, checked: boolean) => {
    const progressChoices = { ...decisions.progressChoices };
    if (!checked) delete progressChoices[id];
    setDecisions({ ...decisions, progressChoices, finishedNotStartedRecordIds: checked
      ? [...new Set([...decisions.finishedNotStartedRecordIds, id])]
      : decisions.finishedNotStartedRecordIds.filter((candidate) => candidate !== id) });
  };
  const setFinishedChoice = (id: string, choice: ActiveProgressChoice | undefined) => {
    const progressChoices = { ...decisions.progressChoices };
    if (choice) progressChoices[id] = choice; else delete progressChoices[id];
    setDecisions({ ...decisions, progressChoices, finishedNotStartedRecordIds: [...new Set([...decisions.finishedNotStartedRecordIds, id])] });
  };
  const isSelected = (record: ImportShowRecord) => finishedIds.has(record.id)
    ? decisions.finishedNotStartedRecordIds.includes(record.id)
    : Boolean(decisions.progressChoices[record.id] && decisions.progressChoices[record.id]?.kind !== "caught_up");
  const toggleImdbShow = (record: ImportShowRecord, checked: boolean) => finishedIds.has(record.id)
    ? toggleFinished(record.id, checked)
    : updateChoice(record.id, { kind: checked ? "not_started" : "caught_up" });
  const setImdbProgress = (record: ImportShowRecord, choice: ActiveProgressChoice | undefined) => finishedIds.has(record.id)
    ? setFinishedChoice(record.id, choice)
    : updateChoice(record.id, choice ?? { kind: "not_started" });
  const visibleImdbOnly = orderedImdbOnly.filter((record) => {
    const selected = isSelected(record), title = (record.imdb?.title ?? record.provider?.name ?? "").toLowerCase();
    return title.includes(setupSearch.trim().toLowerCase()) && (setupFilter === "all" || (setupFilter === "selected" ? selected : !selected));
  });
  return <>
    {conflicts.length > 0 && <section className="report"><h2>Exact ID conflicts</h2><p>Conflicting records cannot be merged silently. Explicitly exclude them from this commit.</p>
      {conflicts.map((record) => <label className="decision-row" key={record.id}><input type="checkbox" checked={decisions.excludedConflictRecordIds.includes(record.id)} onChange={(event) => setDecisions({ ...decisions,
        excludedConflictRecordIds: event.target.checked ? [...decisions.excludedConflictRecordIds, record.id] : decisions.excludedConflictRecordIds.filter((id) => id !== record.id) })}/>
        Exclude {record.imdb?.title ?? record.tvtime?.title ?? record.id}: {record.conflict?.reason}</label>)}</section>}
    {orderedImdbOnly.length > 0 && <section className="report"><div className="setup-heading"><div><h2>IMDb shows without TV Time history</h2><p>Leave shows you watched through the import date unselected. Select only shows you have not fully watched, then optionally choose the latest episode watched.</p></div><span className="count">{orderedImdbOnly.filter(isSelected).length}</span></div><div className="setup-toolbar"><label className="search"><span aria-hidden="true">⌕</span><span className="sr-only">Search IMDb shows without TV Time history</span><input value={setupSearch} onChange={(event) => setSetupSearch(event.target.value)} placeholder="Search shows"/></label><div className="filter-tabs" role="group" aria-label="Filter IMDb shows without TV Time history">{(["all", "selected", "unselected"] as const).map((filter) => <button type="button" className={setupFilter === filter ? "active" : ""} aria-pressed={setupFilter === filter} key={filter} onClick={() => setSetupFilter(filter)}>{filter === "all" ? "All" : filter === "selected" ? "Selected" : "Not selected"}</button>)}</div></div><div className="onboarding-show-grid">
      {visibleImdbOnly.map((record) => { const selected = isSelected(record); return <FinishedShowChoice key={record.id} record={record} analysis={analysis} tracker={tracker} checked={selected} value={selected ? decisions.progressChoices[record.id] : undefined} uncheckedLabel="Watched through import date" onToggle={(checked) => toggleImdbShow(record, checked)} onChange={(choice) => setImdbProgress(record, choice)}/>; })}</div>{visibleImdbOnly.length === 0 && <p className="empty-inline">No shows match this search and filter.</p>}</section>}
  </>;
}

function FinalPreviewView({ preview, decisions, updateDecisions }: {
  preview: ImportPreview;
  decisions: ImportDecisions;
  updateDecisions: (next: ImportDecisions) => void;
}) {
  const conflictGroups = new Map<string, { showName: string; state?: ImportPreview["localShowStateConflicts"][number]; episodes: ImportPreview["localProgressConflicts"] }>();
  for (const conflict of preview.localShowStateConflicts) conflictGroups.set(conflict.recordId, { showName: conflict.showName, state: conflict, episodes: [] });
  for (const conflict of preview.localProgressConflicts) {
    const group = conflictGroups.get(conflict.recordId) ?? { showName: conflict.showName, episodes: [] };
    group.episodes.push(conflict); conflictGroups.set(conflict.recordId, group);
  }
  const setReplacement = (keys: string[], replace: boolean) => {
    const selected = new Set(decisions.replaceLocalProgressKeys); keys.forEach((key) => replace ? selected.add(key) : selected.delete(key));
    updateDecisions({ ...decisions, replaceLocalProgressKeys: [...selected] });
  };
  const fullyWatched = preview.plans.filter((plan) => plan.desiredState === "completed" || plan.desiredState === "caught_up");
  const exceptions = preview.plans.filter((plan) => !fullyWatched.includes(plan));
  const completed = fullyWatched.filter((plan) => plan.desiredState === "completed").length, caughtUp = fullyWatched.length - completed;
  return <section className="report final-preview"><h2>Ready to import</h2>
    <p className="import-done-line"><strong>{preview.committedShows}</strong> show{preview.committedShows === 1 ? "" : "s"} · {preview.newShows} new · {preview.updatedShows} updated{conflictGroups.size > 0 ? ` · ${conflictGroups.size} need a choice below` : ""}</p>
    {fullyWatched.length > 0 && <div className="fully-watched-summary"><span className="summary-check" aria-hidden="true">✓</span><div><strong>{fullyWatched.length} show{fullyWatched.length === 1 ? "" : "s"} watched through the import date</strong><p>{completed > 0 && `${completed} ended show${completed === 1 ? "" : "s"} marked completed`}{completed > 0 && caughtUp > 0 ? " · " : ""}{caughtUp > 0 && `${caughtUp} ongoing show${caughtUp === 1 ? "" : "s"} marked caught up`}.</p></div></div>}
    {exceptions.length > 0 && <div className="preview-exceptions"><h3>Shows with different progress</h3><div className="preview-exception-grid">{exceptions.map((plan) => { const watched = plan.progress.filter((state) => state.watched).length, unwatched = plan.progress.filter((state) => !state.watched).length; return <article key={plan.recordId}><div><strong>{plan.title}</strong><span className="badge">{preview.operationByRecordId[plan.recordId]}</span></div><p><span className="badge accent">{plan.desiredState.replaceAll("_", " ")}</span>{watched > 0 && <span>{watched} watched</span>}{unwatched > 0 && <span>{unwatched} unwatched</span>}{plan.progress.length === 0 && <span>No aired progress records</span>}</p></article>; })}</div></div>}
    {preview.missingDecisions.length > 0 && <div className="error" role="alert"><strong>More decisions are required:</strong><ul>{preview.missingDecisions.map((message) => <li key={message}>{message}</li>)}</ul></div>}
    {conflictGroups.size > 0 && <div className="reimport-conflicts"><h3>Reimport conflicts with later local decisions</h3><p><strong>Your local choices are preserved by default.</strong> Use imported values only where the source should replace a decision you made later in Tracker.</p>{[...conflictGroups.entries()].map(([recordId, group]) => {
      const keys = [...(group.state ? [group.state.key] : []), ...group.episodes.map((episode) => episode.key)], allImported = keys.every((key) => decisions.replaceLocalProgressKeys.includes(key));
      return <article className="conflict-card" key={recordId}><div className="conflict-card-header"><div><h4>{group.showName}</h4><span>{keys.length} conflict{keys.length === 1 ? "" : "s"}</span></div><div className="conflict-group-actions"><button aria-pressed={!allImported} onClick={() => setReplacement(keys, false)}>Keep all local</button><button className={allImported ? "primary" : ""} aria-pressed={allImported} onClick={() => setReplacement(keys, true)}>Use all imported</button></div></div>
        {group.state && <div className="conflict-row"><div><strong>Show status</strong><small>Local: {group.state.existing.replace("_", " ")} · Import: {group.state.incoming.replace("_", " ")}</small></div><div className="conflict-choice"><button aria-pressed={!group.state.replaceApproved} onClick={() => setReplacement([group.state!.key], false)}>Keep local</button><button className={group.state.replaceApproved ? "primary" : ""} aria-pressed={group.state.replaceApproved} onClick={() => setReplacement([group.state!.key], true)}>Use import</button></div></div>}
        {group.episodes.map((episode) => <div className="conflict-row" key={episode.key}><div><strong>S{String(episode.existing.season).padStart(2, "0")} · E{String(episode.existing.episode).padStart(2, "0")} · {episode.episodeName}</strong><small>Local: {episode.existing.watched ? "watched" : "unwatched"}{episode.existing.watchedAt ? ` on ${new Date(episode.existing.watchedAt).toLocaleString()}` : ""} · Import: {episode.incoming.watched ? "watched" : "unwatched"}</small></div><div className="conflict-choice"><button aria-pressed={!episode.replaceApproved} onClick={() => setReplacement([episode.key], false)}>Keep local</button><button className={episode.replaceApproved ? "primary" : ""} aria-pressed={episode.replaceApproved} onClick={() => setReplacement([episode.key], true)}>Use import</button></div></div>)}
      </article>;
    })}</div>}
  </section>;
}

export function ImportPage({ tracker }: { tracker: Tracker }) {
  const { phase, tvtime, refract, bingers, selectedFiles, analysis, decisions, preview, stageProgress, error, commitResult } = useImportStore();
  const backupRestore = useBackupRestore(tracker);
  const setPhase = (value: Phase) => useImportStore.setState({ phase: value });
  const setDecisions = (value: ImportDecisions) => useImportStore.setState({ decisions: value });
  const setPreview = (value: ImportPreview) => useImportStore.setState({ preview: value });

  function reset() {
    resetImportStore();
  }

  function mergeImdb(previous: ImdbParseResult | undefined, incoming: ImdbParseResult): ImdbParseResult {
    if (!previous) return incoming;
    const rows = new Map(previous.rows.map((row) => [row.imdbId, row]));
    const duplicates = new Set([...previous.duplicates, ...incoming.duplicates]);
    for (const row of incoming.rows) {
      const existing = rows.get(row.imdbId);
      if (existing) duplicates.add(row.imdbId);
      rows.set(row.imdbId, existing ? { ...existing, ...row } : row);
    }
    return {
      rows: [...rows.values()].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "") || (a.position ?? Infinity) - (b.position ?? Infinity)),
      malformed: [...previous.malformed, ...incoming.malformed],
      unsupported: [...previous.unsupported, ...incoming.unsupported],
      duplicates: [...duplicates],
      totalRows: previous.totalRows + incoming.totalRows,
      schemaErrors: [...new Set([...previous.schemaErrors, ...incoming.schemaErrors])],
    };
  }

  const fileKey = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

  async function processFiles(files: File[]) {
    if (files.length === 0) return;
    const backupFile = files.find((file) => file.name.toLowerCase().endsWith(".json"));
    if (backupFile) { await backupRestore.inspectFile(backupFile); return; }
    const current = useImportStore.getState();
    const existingKeys = new Set(current.selectedFiles.map((file) => file.key));
    const additions = files.filter((file) => !existingKeys.has(fileKey(file)));
    if (additions.length === 0) {
      useImportStore.setState({ error: { title: "Files already selected", message: "Those files are already included in this import." } });
      return;
    }
    const currentOperation = current.operationId + 1;
    useImportStore.setState({
      operationId: currentOperation,
      error: undefined,
      phase: "parsed",
      stageProgress: { stage: "validate_parse", completed: 0, total: additions.length, message: "Validating selected files." },
    });
    let nextImdb = current.imdb;
    let nextTvtime = current.tvtime;
    let nextBingers = current.bingers;
    let nextRefract = current.refract;
    let nextFiles = current.selectedFiles;
    try {
      for (let index = 0; index < additions.length; index++) {
        const file = additions[index]!;
        let selected: SelectedImportFile;
        if (file.name.toLowerCase().endsWith(".csv")) {
          const parsed = parseImdbCsv(await file.text());
          if (parsed.schemaErrors.length > 0) throw new Error(`IMDb CSV schema validation failed: ${parsed.schemaErrors.join(" ")}`);
          if (parsed.rows.length === 0) throw new Error("IMDb CSV contained no supported TV series or miniseries.");
          nextImdb = mergeImdb(nextImdb, parsed);
          selected = { key: fileKey(file), name: file.name, kind: "imdb" };
        } else if (file.name.toLowerCase().endsWith(".zip")) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          try {
            nextBingers = parseBingersZip(bytes);
            nextFiles = nextFiles.filter((selectedFile) => selectedFile.kind !== "bingers");
            selected = { key: fileKey(file), name: file.name, kind: "bingers" };
          } catch (cause) {
            if (!(cause instanceof BingersImportError) || cause.code !== "not_bingers") throw cause;
            try {
              nextRefract = parseRefractZip(bytes);
              nextFiles = nextFiles.filter((selectedFile) => selectedFile.kind !== "refract");
              selected = { key: fileKey(file), name: file.name, kind: "refract" };
            } catch (cause) {
              if (!(cause instanceof RefractImportError) || cause.code !== "not_refract") throw cause;
              nextTvtime = parseTvTimeZip(bytes);
              nextFiles = nextFiles.filter((selectedFile) => selectedFile.kind !== "tvtime");
              selected = { key: fileKey(file), name: file.name, kind: "tvtime" };
            }
          }
        } else throw new Error(`Unsupported file: ${file.name}`);
        nextFiles = [...nextFiles, selected];
        if (currentOperation !== useImportStore.getState().operationId) return;
        useImportStore.setState({ stageProgress: { stage: "validate_parse", completed: index + 1, total: additions.length, message: `Validated ${index + 1} of ${additions.length} files.` } });
      }
      if (currentOperation !== useImportStore.getState().operationId) return;
      useImportStore.setState({ imdb: nextImdb, tvtime: nextTvtime, refract: nextRefract, bingers: nextBingers, selectedFiles: nextFiles, analysis: undefined, decisions: emptyImportDecisions(), preview: undefined, commitResult: undefined, phase: "parsed", stageProgress: undefined });
      // Two exports that both carry watch history describe the same shows twice, which
      // reconciliation can only read as a conflict. Stop and say so instead of running an
      // analysis whose every record needs excluding.
      if ([nextTvtime, nextRefract, nextBingers].filter(Boolean).length < 2) await runAnalysis();
    } catch (cause) {
      if (currentOperation !== useImportStore.getState().operationId) return;
      const title = cause instanceof BingersImportError ? "Bingers import could not be parsed" : cause instanceof TvTimeImportError
        ? cause.code === "zip_validation" ? "ZIP validation failed" : cause.code === "schema" ? "TV Time schema could not be parsed" : "No TV Time shows were found"
        : cause instanceof RefractImportError
          ? cause.code === "zip_validation" ? "ZIP validation failed" : cause.code === "schema" ? "Refract schema could not be parsed" : "No Refract shows were found"
          : "Import validation failed";
      useImportStore.setState({ phase: current.phase, error: { title, message: cause instanceof Error ? cause.message : "The selected import could not be parsed." }, stageProgress: undefined });
    }
  }

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = ""; await processFiles(files);
  }

  async function runAnalysis() {
    // Read through the store rather than the render closure: this runs immediately after
    // processFiles commits the parsed sources, when the closure still holds the old values.
    const { imdb, tvtime, refract, bingers } = useImportStore.getState();
    if (!imdb && !tvtime && !refract && !bingers) return;
    const currentOperation = useImportStore.getState().operationId + 1;
    useImportStore.setState({ operationId: currentOperation, error: undefined, analysis: undefined, preview: undefined, commitResult: undefined, phase: "analyzing" });
    try {
      let combinedTvtime = tvtime;
      if (bingers) {
        useImportStore.setState({ stageProgress: { stage: "resolve_ids", completed: 0, total: bingers.shows.length, message: "Preparing Bingers shows for matching." } });
        const resolved = await resolveBingersShows(bingers, importProvider);
        if (currentOperation !== useImportStore.getState().operationId) return;
        combinedTvtime = { shows: [...(tvtime?.shows ?? []), ...resolved.shows], specials: (tvtime?.specials ?? 0) + resolved.specials,
          specialFlagMismatches: tvtime?.specialFlagMismatches ?? 0, ignoredEntries: [...(tvtime?.ignoredEntries ?? []), ...resolved.ignoredEntries] };
      }
      if (refract) {
        // Refract shows have no stable external ID, so resolving each one to a TVMaze show via
        // search happens here, up front -- once resolved (or not), they're just TvTimeShow
        // records and flow through the exact same reconciliation as a real TV Time export.
        const resolved = await resolveRefractShows(refract, importProvider, (completed, total) => {
          if (currentOperation === useImportStore.getState().operationId) {
            useImportStore.setState({ stageProgress: { stage: "resolve_ids", completed, total, message: `Matched ${completed} of ${total} Refract shows to TVMaze.` } });
          }
        });
        if (currentOperation !== useImportStore.getState().operationId) return;
        combinedTvtime = {
          shows: [...(combinedTvtime?.shows ?? []), ...resolved],
          specials: combinedTvtime?.specials ?? 0,
          specialFlagMismatches: combinedTvtime?.specialFlagMismatches ?? 0,
          ignoredEntries: combinedTvtime?.ignoredEntries ?? [],
        };
      }
      const result = await analyzeImport({ selected: selectFullImportSources(imdb, combinedTvtime), provider: importProvider, settings: tracker.local!.settings,
        onProgress: (progress) => { if (currentOperation === useImportStore.getState().operationId) useImportStore.setState({ stageProgress: progress }); } });
      if (currentOperation !== useImportStore.getState().operationId) return;
      useImportStore.setState({ analysis: result, decisions: emptyImportDecisions(), phase: "report", stageProgress: undefined });
      if (result.report.providerErrors.length > 0) {
        const first = result.report.providerErrors[0]!;
        useImportStore.setState({ error: { title: providerErrorLabel(first), message: `${first.recordName}: ${first.message}` } });
        return;
      }
      if (needsDecisions(result)) openDecisions(result);
      else openPreview(emptyImportDecisions(), result);
    } catch (cause) {
      if (currentOperation !== useImportStore.getState().operationId) return;
      useImportStore.setState({ phase: "parsed", stageProgress: undefined,
        error: { title: "Import analysis failed", message: cause instanceof Error ? cause.message : "The import could not be analyzed." } });
    }
  }

  function openDecisions(source = analysis) {
    if (!source || !tracker.local) return;
    const timing = recordTiming(source, tracker), progressChoices = { ...decisions.progressChoices };
    for (const record of source.records.filter((candidate) => candidate.kind === "imdb_only" && candidate.provider)) {
      if (classifyOnboardingShow({ id: record.id, providerStatus: record.provider!.status, episodes: record.episodes }, timing) !== "finished" && !progressChoices[record.id]) {
        progressChoices[record.id] = { kind: "caught_up" };
      }
    }
    setDecisions({ ...decisions, finishedMode: "mixture", progressChoices }); setPhase("decisions");
  }

  function openPreview(choices = decisions, source = analysis) {
    if (!source || !tracker.local) return;
    setPreview(buildImportPreview(source, choices, tracker.local)); setPhase("preview");
  }

  function updatePreviewDecisions(next: ImportDecisions) {
    setDecisions(next);
    if (analysis && tracker.local) setPreview(buildImportPreview(analysis, next, tracker.local));
  }

  async function commit() {
    if (!analysis || !preview || !preview.ready) return;
    useImportStore.setState({ error: undefined, phase: "committing" });
    try {
      const result = await commitImport(analysis, preview, decisions);
      useImportStore.setState({ commitResult: result }); await tracker.reload(); setPhase("complete");
    } catch (cause) {
      useImportStore.setState({ phase: "preview", error: { title: "Commit failed", message: cause instanceof Error ? cause.message : "Commit failed. Existing tracker state was not changed." } });
    }
  }

  const operationBusy = Boolean(stageProgress) || phase === "analyzing" || phase === "committing";
  const busy = !backupRestore.pendingBackup && !backupRestore.syncProgress && !backupRestore.restoreMessage;
  return <><h1>Import</h1><p>Bring your existing show lists and watch history into the tracker. Your files are read locally and nothing is saved until you confirm.</p>
    {phase === "select" && <section className="import-guide" aria-labelledby="import-guide-title"><div className="import-guide-heading"><p className="eyebrow">Start here</p><h2 id="import-guide-title">Get your export files</h2><p>You can add files together or choose them one at a time from different folders. Each new selection stays in this import.</p></div><div className="import-guide-grid">
      <article><span className="guide-source" aria-hidden="true">IMDb</span><h3>Export an IMDb list</h3><ol><li>Sign in to IMDb on a desktop browser and open your Watchlist or another title list.</li><li>Click the 3 dots and select <strong>Export</strong> from the list.</li><li>Keep the downloaded <strong>CSV</strong> file. You may add multiple IMDb list CSVs.</li></ol><a href="https://www.imdb.com/profile/lists" target="_blank" rel="noreferrer">Open your IMDb lists <span aria-hidden="true">↗</span></a></article>
      <article><span className="guide-source" aria-hidden="true">TV</span><h3>Import from Refract, Bingers, or TV Time</h3><p>Upload your Refract or Bingers export ZIP, or a TV Time export you already have, and leave it zipped.</p><p>TV Time data exports are no longer available to request or download. You can still import a previously saved GDPR or legacy extension-export ZIP.</p></article>
    </div></section>}
    <section className="report source-picker"><h2>Select files</h2><p>Choose one or several files. TV Time, Refract, and Bingers ZIP exports are accepted and auto-detected. Keep Bingers exports zipped; library.csv and watches.csv are read together. You can also drop a previously exported <strong>show-tracker-*.json</strong> backup here to restore it directly. Older tracker backups remain compatible.</p><label className={`file-drop ${operationBusy ? "disabled" : ""}`} htmlFor="import-files" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!operationBusy) void processFiles(Array.from(event.dataTransfer.files)); }}><span aria-hidden="true">⇧</span><strong>{selectedFiles.length ? "Add more IMDb CSV or TV Time/Refract/Bingers ZIP files" : "Drop IMDb CSV, TV Time/Refract/Bingers ZIP, or a tracker backup JSON here"}</strong><small>or choose files from your computer</small><input id="import-files" type="file" multiple accept=".csv,.zip,.json" disabled={operationBusy} onChange={(event) => void choose(event)}/></label>
      {selectedFiles.length > 0 && <div className="selected-files" aria-label="Selected files">{selectedFiles.map((file) => <span className="badge" key={file.key}><small>{file.kind === "imdb" ? "IMDb" : file.kind === "refract" ? "Refract" : file.kind === "bingers" ? "Bingers" : "TV Time"}</small>{file.name}</span>)}</div>}{(phase !== "select" || operationBusy) && <button type="button" onClick={reset}>{operationBusy ? "Cancel current operation" : "Clear selected files"}</button>}
    </section>
    {backupRestore.pendingBackup && <RestorePreview backup={backupRestore.pendingBackup} onCancel={backupRestore.cancel} onConfirm={backupRestore.applyRestore}/>}
    {backupRestore.syncProgress ? <SyncProgress progress={backupRestore.syncProgress}/> : backupRestore.restoreMessage && <p className={backupRestore.restoreMessage.kind === "error" ? "error" : "success-message"} role="status">{backupRestore.restoreMessage.text}</p>}
    {busy && <>
    {error && <ErrorPanel title={error.title} message={error.message} retry={phase === "report" && analysis?.report.providerErrors.length ? () => void runAnalysis() : phase === "preview" ? () => void commit() : undefined}/>}
    {phase === "parsed" && [tvtime, refract, bingers].filter(Boolean).length > 1 && <section className="report warning-panel" role="alert">
      <h2>Import these one at a time</h2>
      <p>These exports each contain watch history. Shows appearing in more than one export may need conflict decisions. Importing one history source at a time is simpler; an IMDb list can be included alongside it.</p>
      <p className="muted">Clear one file above and import it on its own, then come back and import the other. Progress from the second import merges into the first.</p>
      <div className="import-actions"><button type="button" onClick={() => void runAnalysis()}>Import both anyway</button></div>
    </section>}
    {stageProgress && <section className="report import-progress" aria-live="polite"><p>{stageProgress.message}</p><progress aria-label={stageProgress.message} value={stageProgress.completed} max={Math.max(1, stageProgress.total)}/><div className="import-skeleton" aria-hidden="true"><span/><span/><span/></div></section>}
    {phase === "report" && analysis && analysis.report.providerErrors.length > 0 && <div className="import-actions">
      <button className="primary" type="button" onClick={() => void runAnalysis()}>Retry failed requests</button></div>}
    {phase === "decisions" && analysis && <><DecisionsView analysis={analysis} tracker={tracker} decisions={decisions} setDecisions={setDecisions}/><div className="import-actions">
      <button className="primary" type="button" onClick={() => openPreview()}>Continue</button>
    </div></>}
    {(phase === "preview" || phase === "committing") && preview && analysis && <><FinalPreviewView preview={preview} decisions={decisions} updateDecisions={updatePreviewDecisions}/>
      <SkippedShows analysis={analysis}/>
      <div className="import-actions">
      {needsDecisions(analysis) && <button type="button" disabled={phase === "committing"} onClick={() => setPhase("decisions")}>Back</button>}
      <button className="primary" type="button" disabled={!preview.ready || phase === "committing"} onClick={() => void commit()}>{phase === "committing" ? "Importing…" : `Import ${preview.committedShows} show${preview.committedShows === 1 ? "" : "s"}`}</button>
    </div></>}
    {phase === "complete" && commitResult && analysis && <section className="report success import-done" aria-live="polite">
      <h2>Import complete</h2>
      <p className="import-done-line">Imported <strong>{commitResult.committed}</strong> show{commitResult.committed === 1 ? "" : "s"} and <strong>{commitResult.watchedMapped}</strong> watched episode{commitResult.watchedMapped === 1 ? "" : "s"}.</p>
      <p className="muted">{commitResult.newShows} new · {commitResult.updatedShows} updated</p>
      <SkippedShows analysis={analysis}/>
      <TechnicalDetails analysis={analysis}/>
      <a className="primary-link" href="#/watch-list">Go to Watch List</a>
    </section>}</>}
    <TvMazeAttribution/>
  </>;
}
