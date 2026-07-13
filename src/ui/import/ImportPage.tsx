import { useMemo, useRef, useState } from "react";
import type { ProviderEpisode } from "../../domain/models";
import { selectFixtureSubset } from "../../imports/fixture-subset";
import { parseImdbCsv, type ImdbParseResult } from "../../imports/imdb";
import { commitImport, type ImportCommitResult } from "../../imports/commit";
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
  type ImportStage,
  type ImportStageProgress,
  type SelectedImportSources,
} from "../../imports/session";
import { parseTvTimeZip, TvTimeImportError, type TvTimeParseResult } from "../../imports/tvtime";
import { TvMazeProvider } from "../../providers/tvmaze/provider";
import type { useTracker } from "../useTracker";
import { posterUrls } from "../../domain/view-models";
import { Poster } from "../components/Poster";
import { TvMazeAttribution } from "../components/Attribution";

const FIXTURE_SUBSET_MODE = import.meta.env.MODE === "fixture" && import.meta.env.WXT_FIXTURE_SUBSET === "true";
const REQUIRED_FIXTURE_TITLES = ["Silo", "House of the Dragon"] as const;
const FIXTURE_BANNER = "Fixture subset mode: importing newest 20 shows plus Silo and House of the Dragon.";

type Tracker = ReturnType<typeof useTracker>;
type Phase = "select" | "parsed" | "analyzing" | "report" | "decisions" | "preview" | "committing" | "complete";

const steps: Array<{ stage: ImportStage; label: string }> = [
  { stage: "select_files", label: "Select files" },
  { stage: "validate_parse", label: "Validate and parse" },
  { stage: "analyze_sources", label: "Analyze sources" },
  { stage: "resolve_ids", label: "Resolve show IDs" },
  { stage: "download_episodes", label: "Download episode metadata" },
  { stage: "reconcile", label: "Reconcile records" },
  { stage: "report", label: "Show import report" },
  { stage: "progress_decisions", label: "Collect progress decisions" },
  { stage: "final_preview", label: "Show final preview" },
  { stage: "commit", label: "Commit once" },
];

function phaseStage(phase: Phase, progress?: ImportStageProgress): ImportStage {
  if (progress) return progress.stage;
  switch (phase) {
    case "select": return "select_files";
    case "parsed": return "validate_parse";
    case "analyzing": return "analyze_sources";
    case "report": return "report";
    case "decisions": return "progress_decisions";
    case "preview": return "final_preview";
    case "committing": return "commit";
    case "complete": return "complete";
  }
}

function ImportSteps({ current }: { current: ImportStage }) {
  const currentIndex = current === "complete" ? steps.length : steps.findIndex((step) => step.stage === current);
  return <ol className="import-steps" aria-label="Import stages">{steps.map((step, index) =>
    <li className={index === currentIndex ? "current" : index < currentIndex ? "done" : ""}
      aria-current={index === currentIndex ? "step" : undefined} key={step.stage}>
      <span>{index + 1}</span>{step.label}
    </li>)}</ol>;
}

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

function CountStrip({ imdb, tvtime, analysis, committed }: {
  imdb: ImdbParseResult | undefined;
  tvtime: TvTimeParseResult | undefined;
  analysis: ImportAnalysis | undefined;
  committed: number;
}) {
  const parsed = (imdb?.totalRows ?? 0) + (tvtime?.shows.length ?? 0);
  const selected = analysis ? Math.max(analysis.counts.imdbRowsSelected, analysis.counts.tvTimeShowsSelected) : 0;
  return <><dl className="import-counts">
    <div><dt>Parsed source records</dt><dd>{parsed}</dd></div>
    <div><dt>Selected fixture shows</dt><dd>{analysis?.fixtureSubsetMode ? selected : 0}</dd></div>
    <div><dt>Matched</dt><dd>{analysis?.report.successfullyMerged ?? 0}</dd></div>
    <div><dt>Unmatched</dt><dd>{analysis?.report.unmatchedShows ?? 0}</dd></div>
    <div><dt>Committed</dt><dd>{committed}</dd></div>
  </dl>{analysis && <p className="source-count-summary">IMDb rows: {analysis.counts.imdbRowsParsed} parsed / {analysis.counts.imdbRowsSelected} selected · TV Time shows: {analysis.counts.tvTimeShowsParsed} parsed / {analysis.counts.tvTimeShowsSelected} selected · TV Time episodes: {analysis.counts.tvTimeEpisodesParsed} parsed / {analysis.counts.tvTimeEpisodesSelected} selected.</p>}</>;
}

function RecordNames({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  return <details className="record-list"><summary>{title} ({names.length})</summary><ul>{names.map((name, index) => <li key={`${name}:${index}`}>{name}</li>)}</ul></details>;
}

function ImportReportView({ analysis }: { analysis: ImportAnalysis }) {
  const report = analysis.report;
  const values: Array<[string, number]> = [
    ["IMDb rows parsed", report.imdbRowsParsed],
    ["TV Time shows parsed", report.tvTimeShowsParsed],
    ["Shows selected by fixture subset mode", report.showsSelectedByFixture],
    ["Exact IMDb matches", report.exactImdbMatches],
    ["Exact TVDB matches", report.exactTvdbMatches],
    ["Successfully merged records", report.successfullyMerged],
    ["IMDb-only records", report.imdbOnly],
    ["TV Time-only records", report.tvTimeOnly],
    ["Conflicts", report.conflicts],
    ["Unmatched shows", report.unmatchedShows],
    ["TV Time episodes parsed", report.tvTimeEpisodesParsed],
    ["Watched episodes successfully mapped", report.watchedEpisodesMapped],
    ["Explicit unwatched episodes mapped", report.explicitUnwatchedEpisodesMapped],
    ["Future episodes excluded from backlog", report.futureEpisodesExcludedFromBacklog],
    ["Specials excluded", report.specialsExcluded],
    ["Unresolved episodes", report.unresolvedEpisodes],
    ["Shows requiring progress setup", report.showsRequiringProgressSetup],
    ["Provider/network errors", report.providerNetworkErrors],
  ];
  return <section className="report"><h2>Import report</h2><dl className="report-metrics">{values.map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <RecordNames title="Conflicting records" names={report.conflictNames}/>
    <RecordNames title="Unmatched shows" names={report.unmatchedNames}/>
    <RecordNames title="TV Time-only shows" names={report.tvTimeOnlyNames}/>
    {report.unresolvedEpisodeRecords.length > 0 && <details className="record-list"><summary>Progress could not be mapped ({report.unresolvedEpisodeRecords.length})</summary><ul>
      {report.unresolvedEpisodeRecords.map((episode) => <li key={`${episode.show}:${episode.tvdbEpisodeId}`}>{episode.show} — S{episode.season}E{episode.episode} {episode.name}: {episode.reason}</li>)}
    </ul></details>}
    {report.numberingConflicts.length > 0 && <details className="record-list"><summary>Season/episode numbering conflicts ({report.numberingConflicts.length})</summary><ul>
      {report.numberingConflicts.map((conflict, index) => <li key={`${conflict.show}:${index}`}>{conflict.show} — {conflict.episode}: {conflict.sourceNumber} → {conflict.providerNumber}</li>)}
    </ul></details>}
    {report.providerErrors.length > 0 && <details className="record-list" open><summary>Provider/network failures ({report.providerErrors.length})</summary><ul>
      {report.providerErrors.map((error, index) => <li key={`${error.recordName}:${index}`}><strong>{providerErrorLabel(error)} — {error.recordName}</strong>: {error.message}</li>)}
    </ul></details>}
  </section>;
}

function recordTiming(analysis: ImportAnalysis, tracker: Tracker): OnboardingTiming {
  return {
    importInstant: new Date(analysis.importedAt),
    timezone: tracker.local!.settings.timezone,
    dateOnlyReleaseHour: tracker.local!.settings.dateOnlyReleaseHour,
  };
}

function availableEpisodes(record: ImportShowRecord, analysis: ImportAnalysis, tracker: Tracker) {
  return getAvailableRegularEpisodes({ id: record.id, providerStatus: record.provider!.status, episodes: record.episodes }, recordTiming(analysis, tracker));
}

function ProgressEditor({ record, analysis, tracker, value, onChange, optional = false }: {
  record: ImportShowRecord;
  analysis: ImportAnalysis;
  tracker: Tracker;
  value: ActiveProgressChoice | undefined;
  onChange: (choice: ActiveProgressChoice | undefined) => void;
  optional?: boolean;
}) {
  const episodes = availableEpisodes(record, analysis, tracker);
  function setKind(kind: string) {
    if (!kind) { onChange(undefined); return; }
    if (kind === "caught_up" || kind === "not_started") onChange({ kind });
    else if (kind === "last_watched") {
      const episode = episodes[0];
      onChange(episode ? { kind, tvmazeEpisodeId: episode.id } : { kind: "not_started" });
    } else onChange({ kind: "manual", watchedTvmazeEpisodeIds: [] });
  }
  return <div className="progress-editor">
    <label>Progress action <select value={value?.kind ?? ""} onChange={(event) => setKind(event.target.value)}>
      <option value="">{optional ? "Use the list-level choice" : "Choose progress…"}</option>
      <option value="caught_up">Caught up</option><option value="not_started">Not started</option>
      <option value="last_watched">Choose last watched episode</option><option value="manual">Select episodes manually</option>
    </select></label>
    {value?.kind === "last_watched" && <label>Last watched episode <select value={value.tvmazeEpisodeId} onChange={(event) => onChange({ kind: "last_watched", tvmazeEpisodeId: Number(event.target.value) })}>
      {episodes.map((episode) => <option value={episode.id} key={episode.id}>{episodeLabel(episode)}</option>)}
    </select></label>}
    {value?.kind === "manual" && <fieldset className="episode-choice"><legend>Select watched episodes; gaps are allowed</legend>
      {episodes.length === 0 && <p>No currently available regular episodes.</p>}
      {episodes.map((episode) => { const checked = value.watchedTvmazeEpisodeIds.includes(episode.id); return <label key={episode.id}>
        <input type="checkbox" checked={checked} onChange={(event) => onChange({ kind: "manual", watchedTvmazeEpisodeIds: event.target.checked
          ? [...value.watchedTvmazeEpisodeIds, episode.id]
          : value.watchedTvmazeEpisodeIds.filter((id) => id !== episode.id) })}/>{episodeLabel(episode)}
      </label>; })}</fieldset>}
  </div>;
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
  const tvTimeOnly = analysis.records.filter((record) => record.kind === "tvtime_only");
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
    {(analysis.report.unmatchedShows > 0 || analysis.report.unresolvedEpisodes > 0 || analysis.report.numberingConflicts.length > 0) && <section className="report attention-summary"><h2>{analysis.report.unmatchedShows + new Set(analysis.report.unresolvedEpisodeRecords.map((episode) => episode.show)).size} shows need attention</h2>
      <p>Matched shows will still import. Unmatched shows are skipped, and any remaining unmapped TV Time episode states are listed in the report without blocking the import.</p>
    </section>}
    {conflicts.length > 0 && <section className="report"><h2>Exact ID conflicts</h2><p>Conflicting records cannot be merged silently. Explicitly exclude them from this commit.</p>
      {conflicts.map((record) => <label className="decision-row" key={record.id}><input type="checkbox" checked={decisions.excludedConflictRecordIds.includes(record.id)} onChange={(event) => setDecisions({ ...decisions,
        excludedConflictRecordIds: event.target.checked ? [...decisions.excludedConflictRecordIds, record.id] : decisions.excludedConflictRecordIds.filter((id) => id !== record.id) })}/>
        Exclude {record.imdb?.title ?? record.tvtime?.title ?? record.id}: {record.conflict?.reason}</label>)}</section>}
    {tvTimeOnly.length > 0 && <section className="report auto-included"><h2>{tvTimeOnly.length} TV Time shows will be added automatically</h2><p>These shows have confident provider matches. Their mapped watched and unwatched history will be imported without additional choices.</p></section>}
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
  return <section className="report final-preview"><div className="preview-title"><div><p className="eyebrow">Ready to commit</p><h2>Final import preview</h2><p>Review the exceptions below. Shows that are fully watched are grouped together.</p></div><span className="count">{preview.committedShows}</span></div>
    <div className="preview-summary"><div><strong>{fullyWatched.length}</strong><span>Fully watched</span><small>through import date</small></div><div><strong>{exceptions.length}</strong><span>Different progress</span><small>listed below</small></div><div><strong>{preview.newShows}</strong><span>New shows</span><small>{preview.updatedShows} updated</small></div><div><strong>{conflictGroups.size}</strong><span>Local conflicts</span><small>{conflictGroups.size ? "review choices below" : "none"}</small></div></div>
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
  const [phase, setPhase] = useState<Phase>("select");
  const [imdb, setImdb] = useState<ImdbParseResult>();
  const [tvtime, setTvtime] = useState<TvTimeParseResult>();
  const [filenames, setFilenames] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<ImportAnalysis>();
  const [decisions, setDecisions] = useState<ImportDecisions>(emptyImportDecisions);
  const [preview, setPreview] = useState<ImportPreview>();
  const [stageProgress, setStageProgress] = useState<ImportStageProgress>();
  const [error, setError] = useState<{ title: string; message: string }>();
  const [commitResult, setCommitResult] = useState<ImportCommitResult>();
  const provider = useMemo(() => new TvMazeProvider(), []);
  const operationId = useRef(0);

  function reset() {
    operationId.current++;
    setPhase("select"); setImdb(undefined); setTvtime(undefined); setFilenames([]); setAnalysis(undefined);
    setDecisions(emptyImportDecisions()); setPreview(undefined); setStageProgress(undefined); setError(undefined); setCommitResult(undefined);
  }

  async function processFiles(files: File[]) {
    reset();
    if (files.length === 0) return;
    const currentOperation = operationId.current;
    setStageProgress({ stage: "validate_parse", completed: 0, total: files.length, message: "Validating selected files." });
    let nextImdb: ImdbParseResult | undefined;
    let nextTvtime: TvTimeParseResult | undefined;
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index]!;
        if (file.name.toLowerCase().endsWith(".csv")) {
          nextImdb = parseImdbCsv(await file.text());
          if (nextImdb.schemaErrors.length > 0) throw new Error(`IMDb CSV schema validation failed: ${nextImdb.schemaErrors.join(" ")}`);
          if (nextImdb.rows.length === 0) throw new Error("IMDb CSV contained no supported TV series or miniseries.");
        } else if (file.name.toLowerCase().endsWith(".zip")) {
          nextTvtime = parseTvTimeZip(new Uint8Array(await file.arrayBuffer()));
        } else throw new Error(`Unsupported file: ${file.name}`);
        if (currentOperation !== operationId.current) return;
        setStageProgress({ stage: "validate_parse", completed: index + 1, total: files.length, message: `Validated ${index + 1} of ${files.length} files.` });
      }
      if (currentOperation !== operationId.current) return;
      setImdb(nextImdb); setTvtime(nextTvtime); setFilenames(files.map((file) => file.name)); setPhase("parsed"); setStageProgress(undefined);
    } catch (cause) {
      if (currentOperation !== operationId.current) return;
      const title = cause instanceof TvTimeImportError
        ? cause.code === "zip_validation" ? "ZIP validation failed" : cause.code === "schema" ? "TV Time schema could not be parsed" : "No TV Time shows were found"
        : "Import validation failed";
      setError({ title, message: cause instanceof Error ? cause.message : "The selected import could not be parsed." });
      setStageProgress(undefined);
    }
  }

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []); event.target.value = ""; await processFiles(files);
  }

  function selectedSources(): SelectedImportSources {
    if (!FIXTURE_SUBSET_MODE) return selectFullImportSources(imdb, tvtime);
    const subset = selectFixtureSubset({ imdbRows: imdb?.rows ?? [], tvTimeShows: tvtime?.shows ?? [], newestCount: 20, requiredTitles: REQUIRED_FIXTURE_TITLES });
    return {
      imdbRows: subset.imdbRows,
      tvTimeShows: subset.tvTimeShows,
      fixtureSubsetMode: true,
      counts: {
        imdbRowsParsed: imdb?.totalRows ?? 0,
        tvTimeShowsParsed: tvtime?.shows.length ?? 0,
        tvTimeEpisodesParsed: tvtime?.shows.reduce((total, show) => total + show.episodes.length, 0) ?? 0,
        imdbRowsSelected: subset.counts.selected.imdbRows,
        tvTimeShowsSelected: subset.counts.selected.tvTimeShows,
        tvTimeEpisodesSelected: subset.counts.selected.tvTimeEpisodes,
      },
    };
  }

  async function runAnalysis() {
    if (!imdb && !tvtime) return;
    const currentOperation = ++operationId.current;
    setError(undefined); setAnalysis(undefined); setPreview(undefined); setCommitResult(undefined); setPhase("analyzing");
    try {
      const result = await analyzeImport({ selected: selectedSources(), provider, settings: tracker.local!.settings,
        onProgress: (progress) => { if (currentOperation === operationId.current) setStageProgress(progress); } });
      if (currentOperation !== operationId.current) return;
      setAnalysis(result); setDecisions(emptyImportDecisions()); setPhase("report"); setStageProgress(undefined);
      if (result.report.providerErrors.length > 0) {
        const first = result.report.providerErrors[0]!;
        setError({ title: providerErrorLabel(first), message: `${first.recordName}: ${first.message}` });
      }
    } catch (cause) {
      if (currentOperation !== operationId.current) return;
      setPhase("parsed"); setStageProgress(undefined);
      setError({ title: "Import analysis failed", message: cause instanceof Error ? cause.message : "The import could not be analyzed." });
    }
  }

  function openDecisions() {
    if (!analysis || !tracker.local) return;
    const timing = recordTiming(analysis, tracker), progressChoices = { ...decisions.progressChoices };
    for (const record of analysis.records.filter((candidate) => candidate.kind === "imdb_only" && candidate.provider)) {
      if (classifyOnboardingShow({ id: record.id, providerStatus: record.provider!.status, episodes: record.episodes }, timing) !== "finished" && !progressChoices[record.id]) {
        progressChoices[record.id] = { kind: "caught_up" };
      }
    }
    setDecisions({ ...decisions, finishedMode: "mixture", progressChoices }); setPhase("decisions");
  }

  function openPreview() {
    if (!analysis || !tracker.local) return;
    const next = buildImportPreview(analysis, decisions, tracker.local);
    setPreview(next); setPhase("preview");
  }

  function updatePreviewDecisions(next: ImportDecisions) {
    setDecisions(next);
    if (analysis && tracker.local) setPreview(buildImportPreview(analysis, next, tracker.local));
  }

  async function commit() {
    if (!analysis || !preview || !preview.ready) return;
    setError(undefined); setPhase("committing");
    try {
      const result = await commitImport(analysis, preview, decisions);
      setCommitResult(result); await tracker.reload(); setPhase("complete");
    } catch (cause) {
      setPhase("preview"); setError({ title: "Commit failed", message: cause instanceof Error ? cause.message : "Commit failed. Existing tracker state was not changed." });
    }
  }

  const current = phaseStage(phase, stageProgress);
  const operationBusy = Boolean(stageProgress) || phase === "analyzing" || phase === "committing";
  return <><h1>Import</h1><p>Select an IMDb CSV and/or a TV Time ZIP. Analysis remains temporary until the final commit.</p>
    {FIXTURE_SUBSET_MODE && <p className="fixture-banner">{FIXTURE_BANNER}</p>}
    <ImportSteps current={current}/>
    <CountStrip imdb={imdb} tvtime={tvtime} analysis={analysis} committed={commitResult?.committed ?? 0}/>
    <section className="report source-picker"><h2>1. Select files</h2><label className={`file-drop ${operationBusy ? "disabled" : ""}`} htmlFor="import-files" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!operationBusy) void processFiles(Array.from(event.dataTransfer.files)); }}><span aria-hidden="true">⇧</span><strong>Drop IMDb CSV and TV Time ZIP here</strong><small>or choose files from your computer</small><input id="import-files" type="file" multiple accept=".csv,.zip" disabled={operationBusy} onChange={(event) => void choose(event)}/></label>
      {filenames.length > 0 && <div className="selected-files" aria-label="Selected files">{filenames.map((filename) => <span className="badge" key={filename}>{filename}</span>)}</div>}{(phase !== "select" || operationBusy) && <button type="button" onClick={reset}>{operationBusy ? "Cancel current operation" : "Cancel import"}</button>}
    </section>
    {error && <ErrorPanel title={error.title} message={error.message} retry={phase === "report" && analysis?.report.providerErrors.length ? () => void runAnalysis() : phase === "preview" ? () => void commit() : undefined}/>} 
    {stageProgress && <section className="report" aria-live="polite"><h2>{steps.find((step) => step.stage === stageProgress.stage)?.label}</h2><p>{stageProgress.message}</p><progress aria-label={stageProgress.message} value={stageProgress.completed} max={Math.max(1, stageProgress.total)}/><div className="import-skeleton" aria-hidden="true"><span/><span/><span/></div></section>}
    {phase === "parsed" && <section className="report"><h2>2. Validate and parse</h2>
      {imdb && <p>IMDb: {imdb.totalRows} rows parsed; {imdb.rows.length} supported shows; {imdb.malformed.length} malformed; {imdb.unsupported.length} unsupported; {imdb.duplicates.length} duplicates.</p>}
      {tvtime && <p>TV Time: {tvtime.shows.length} shows and {tvtime.shows.reduce((total, show) => total + show.episodes.length, 0)} episodes parsed.</p>}
      <button className="primary" type="button" onClick={() => void runAnalysis()}>Analyze sources</button></section>}
    {analysis && ["report", "decisions", "preview", "committing", "complete"].includes(phase) && <ImportReportView analysis={analysis}/>} 
    {phase === "report" && analysis && <div className="import-actions">{analysis.report.providerErrors.length > 0
      ? <button className="primary" type="button" onClick={() => void runAnalysis()}>Retry failed requests</button>
      : <button className="primary" type="button" onClick={openDecisions}>Continue to progress setup</button>}</div>}
    {phase === "decisions" && analysis && <><DecisionsView analysis={analysis} tracker={tracker} decisions={decisions} setDecisions={setDecisions}/><div className="import-actions">
      <button type="button" onClick={() => setPhase("report")}>Back to report</button><button className="primary" type="button" onClick={openPreview}>Build final preview</button>
    </div></>}
    {(phase === "preview" || phase === "committing") && preview && <><FinalPreviewView preview={preview} decisions={decisions} updateDecisions={updatePreviewDecisions}/><div className="import-actions">
      <button type="button" disabled={phase === "committing"} onClick={() => setPhase("decisions")}>Back to decisions</button><button className="primary" type="button" disabled={!preview.ready || phase === "committing"} onClick={() => void commit()}>{phase === "committing" ? "Committing…" : "Commit import once"}</button>
    </div></>}
    {phase === "complete" && commitResult && analysis && <section className="report success" aria-live="polite"><h2>{analysis.report.unmatchedShows || analysis.report.unresolvedEpisodes ? "Import committed with reviewed unresolved records" : "Import complete"}</h2><p>{commitResult.committed} shows committed: {commitResult.newShows} new and {commitResult.updatedShows} updated.</p><p>{commitResult.watchedMapped} watched and {commitResult.explicitUnwatchedMapped} explicit unwatched episode states committed.</p></section>}
    <TvMazeAttribution/>
  </>;
}
