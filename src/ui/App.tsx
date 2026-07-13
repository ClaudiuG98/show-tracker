import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { differenceInCalendarDays, formatDistanceToNow } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createBackup, parseBackup, type TrackerBackup } from "../backup/backup";
import { episodeReleaseInstant, getEpisodeAvailability } from "../domain/availability";
import type { ProviderEpisode } from "../domain/models";
import { selectUpcomingShows, selectWatchListShows } from "../domain/selectors";
import { groupRegularEpisodesBySeason, librarySummary, posterUrls, providerFor } from "../domain/view-models";
import { clearTrackerDatabase, resetMetadataCache } from "../storage/database";
import { emptyLocalState, updateLocalState, writeLocalState } from "../storage/local-state";
import { ImportPage } from "./import/ImportPage";
import { TvMazeAttribution } from "./components/Attribution";
import { Poster } from "./components/Poster";
import { useTracker } from "./useTracker";

type Tracker = ReturnType<typeof useTracker>;
const FIXTURE_BUILD = import.meta.env.MODE === "fixture" && import.meta.env.WXT_FIXTURE_SUBSET === "true";
const episodeCode = (episode: ProviderEpisode) => `S${String(episode.season).padStart(2, "0")} · E${String(episode.number).padStart(2, "0")}`;
const stateLabel = (value: string) => value.replaceAll("_", " ");
const waitForExit = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ? Promise.resolve()
  : new Promise<void>((resolve) => window.setTimeout(resolve, 180));

type AsyncButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onAction: (event: React.MouseEvent<HTMLButtonElement>) => Promise<unknown>;
  busyLabel?: string;
  successLabel?: string;
};

function AsyncButton({ onAction, busyLabel = "Working…", successLabel, children, disabled, className = "", ...props }: AsyncButtonProps) {
  const [state, setState] = useState<"idle" | "busy" | "success" | "error">("idle"), [error, setError] = useState("");
  const run = async (event: React.MouseEvent<HTMLButtonElement>) => {
    if (state === "busy") return;
    setState("busy"); setError("");
    try {
      await onAction(event);
      if (successLabel) { setState("success"); window.setTimeout(() => setState("idle"), 1_600); }
      else setState("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed."); setState("error");
    }
  };
  return <span className={`async-control ${state}`}><button {...props} className={`${className} async-button`.trim()} disabled={disabled || state === "busy"} aria-busy={state === "busy"} onClick={(event) => void run(event)}>{state === "busy" ? <><span className="button-spinner" aria-hidden="true"/>{busyLabel && <span>{busyLabel}</span>}</> : <span>{state === "success" && successLabel ? successLabel : children}</span>}</button>{state === "error" && <span className="button-feedback" role="alert">{error} Try again.</span>}</span>;
}

function historyDescription(action: NonNullable<Tracker["local"]>["history"][number], tracker: Tracker) {
  if (action.action === "state_changed") return `Status changed from ${stateLabel(action.before.userState)} to ${stateLabel(action.after.userState)}`;
  const episodes = action.episodeKeys.map(Number).map((id) => tracker.domain?.episodes.find((episode) => episode.id === id)).filter((episode): episode is ProviderEpisode => Boolean(episode))
    .sort((a, b) => a.season - b.season || a.number - b.number);
  if (episodes.length === 0) return stateLabel(action.action);
  if (episodes.length === 1) return `${episodeCode(episodes[0]!)} · ${episodes[0]!.name ?? "Untitled episode"} · ${action.action.includes("unwatched") ? "marked unwatched" : "marked watched"}`;
  return `${episodes.length} episodes marked ${action.action === "bulk_unwatched" ? "unwatched" : "watched"} · ${episodeCode(episodes[0]!)} through ${episodeCode(episodes.at(-1)!)}`;
}

function releaseCountdown(date: Date, now: Date) {
  const days = differenceInCalendarDays(date, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

function formatAddedDate(value: string) {
  const calendarDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = calendarDate
    ? new Date(Number(calendarDate[1]), Number(calendarDate[2]) - 1, Number(calendarDate[3]))
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function Layout({ children, status }: { children: React.ReactNode; status: string }) {
  return <><a className="skip-link" href="#main">Skip to content</a><header><a className="brand" href="#/watch-list"><span>T</span> Tracker <small>Unofficial</small></a><span className={`build-badge ${FIXTURE_BUILD ? "fixture" : "production"}`}>{FIXTURE_BUILD ? "Fixture build" : "Production"}</span><nav aria-label="Primary">
    <NavLink to="/watch-list">Watch List</NavLink><NavLink to="/upcoming">Upcoming</NavLink><NavLink to="/library">Library</NavLink>
  </nav><nav className="tools" aria-label="Tools"><NavLink to="/import">Import</NavLink><NavLink to="/settings">Settings</NavLink></nav></header><main id="main">{children}</main><div className="sr-only" role="status" aria-live="polite">{status}</div></>;
}
function Empty({ title, children }: { title: string; children: React.ReactNode }) { return <div className="empty"><span className="empty-icon" aria-hidden="true">◇</span><h2>{title}</h2><p>{children}</p></div>; }
function PageHeading({ title, description, count, countLabel, countDetail }: { title: string; description: string; count?: number; countLabel?: string; countDetail?: string }) {
  return <div className="page-title"><div><p className="eyebrow">Your television</p><h1>{title}</h1><p>{description}</p></div>{count !== undefined && <div className={`page-count ${countLabel ? "labelled" : ""}`} aria-label={`${count} ${countLabel ?? "shows"}`}><span className="count" aria-hidden="true">{count}</span>{countLabel && <strong>{countLabel}</strong>}{countDetail && <small>{countDetail}</small>}</div>}</div>;
}

function RouteScrollReset() {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const libraryScrollTop = useRef(0);
  const showOpenedFromLibrary = useRef(false);

  useLayoutEffect(() => {
    if (pathname !== "/library") return;
    const rememberPosition = () => { libraryScrollTop.current = window.scrollY; };
    window.addEventListener("scroll", rememberPosition, { passive: true });
    return () => window.removeEventListener("scroll", rememberPosition);
  }, [pathname]);

  useLayoutEffect(() => {
    const previous = previousPath.current;
    if (previous === "/library" && pathname.startsWith("/show/")) {
      showOpenedFromLibrary.current = true;
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } else if (pathname === "/library" && previous.startsWith("/show/") && showOpenedFromLibrary.current) {
      window.scrollTo({ top: libraryScrollTop.current, left: 0, behavior: "auto" });
      showOpenedFromLibrary.current = false;
    } else {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (!pathname.startsWith("/show/")) showOpenedFromLibrary.current = false;
    }
    previousPath.current = pathname;
  }, [pathname]);
  return null;
}

export function WatchList({ tracker }: { tracker: Tracker }) {
  const [completing, setCompleting] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState("");
  const items = tracker.domain ? selectWatchListShows(tracker.domain, tracker.now) : [];
  const mark = async (showId: string, run: () => Promise<void>) => { setActionError(""); setCompleting((old) => new Set(old).add(showId)); try { await waitForExit(); await run(); } catch (cause) { setActionError(cause instanceof Error ? cause.message : "The episode could not be updated."); } finally { setCompleting((old) => { const next = new Set(old); next.delete(showId); return next; }); } };
  return <><PageHeading title="Watch List" description="Pick up with the earliest available unwatched episode."/>
    {actionError && <p className="error-panel compact" role="alert">{actionError} Try again.</p>}
    {!items.length && <Empty title="Nothing waiting">You’re caught up, or your shows still need progress setup.</Empty>}
    <section className="watch-grid" aria-label="Episodes waiting">{items.map(({ show, episode, additional }) => { const provider = providerFor(tracker.domain!, show), poster = posterUrls(provider), released = episodeReleaseInstant(episode, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour); return <article className={`watch-card ${completing.has(show.id) ? "completing" : ""}`} key={show.id}>
      <a className="card-link" href={`#/show/${show.id}`} aria-label={`Open ${show.titleSnapshot} details`}><Poster title={show.titleSnapshot} {...poster}/><div className="card-copy"><h2>{show.titleSnapshot}</h2><div className="episode-code">{episodeCode(episode)} {additional > 0 && <span>+{additional} more</span>}</div><p className="episode-title">{episode.name ?? "Episode title unavailable"}</p>{released && <time dateTime={released.toISOString()} title={released.toLocaleString()}>{formatDistanceToNow(released, { addSuffix: true })} · {released.toLocaleDateString()}</time>}</div></a>
      <button className="watched" disabled={completing.has(show.id)} aria-label={`Mark ${episode.name ?? episodeCode(episode)} watched`} onClick={() => void mark(show.id, () => tracker.markEpisode(show, episode.id, true))}><span aria-hidden="true">✓</span></button>
    </article>; })}</section><TvMazeAttribution/>
    <details className="history"><summary>Watched history <span>{tracker.local?.history.length ?? 0}</span></summary>{!tracker.local?.history.length && <p className="history-empty">Episodes you mark watched will appear here with their season, episode, and title.</p>}{tracker.local?.history.slice(0, 20).map((action) => <article className="history-entry" key={action.id}><div className="history-mark" aria-hidden="true">✓</div><div className="history-copy"><strong>{tracker.local?.shows.find((show) => show.id === action.showId)?.titleSnapshot ?? "Removed show"}</strong><span>{historyDescription(action, tracker)}</span></div><time>{new Date(action.occurredAt).toLocaleString()}</time><AsyncButton busyLabel="Undoing…" onAction={() => tracker.undo(action)}>Undo</AsyncButton></article>)}</details></>;
}

export function Upcoming({ tracker }: { tracker: Tracker }) {
  const items = tracker.domain ? selectUpcomingShows(tracker.domain, tracker.now) : [];
  return <><PageHeading title="Upcoming" description="The nearest announced regular episode for each show."/>{!items.length && <Empty title="No releases announced">Scheduled episodes will appear here when TVMaze publishes them.</Empty>}
    <section className="upcoming-grid" aria-label="Upcoming releases">{items.map(({ show, episode, later }) => { const provider = providerFor(tracker.domain!, show), poster = posterUrls(provider), date = episodeReleaseInstant(episode, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour), exact = Boolean(episode.airstamp || episode.airtime); return <article className="upcoming-card" key={show.id}><a className="card-link" href={`#/show/${show.id}`}><Poster title={show.titleSnapshot} {...poster}/><div className="card-copy"><h2>{show.titleSnapshot}</h2>{date && <div className="release-countdown"><strong>{releaseCountdown(date, tracker.now)}</strong><time dateTime={date.toISOString()}>{exact ? formatInTimeZone(date, tracker.domain!.settings.timezone, "PP · p") : `${formatInTimeZone(date, tracker.domain!.settings.timezone, "PP")} · Date only`}</time></div>}<div className="episode-code">{episodeCode(episode)}</div><p className="episode-title">{episode.name ?? "Title to be announced"}</p>{later > 0 && <p className="later-count">+{later} later announced</p>}</div></a></article>; })}</section><TvMazeAttribution/></>;
}

const FILTERS = [["all", "All"], ["watching", "Watching"], ["caught_up", "Caught up"], ["not_started", "Not started"], ["paused", "Paused"], ["completed", "Completed"], ["ended", "Ended"]] as const;
export function Library({ tracker }: { tracker: Tracker }) {
  const [search, setSearch] = useState(""), [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const allShows = tracker.local?.shows ?? [];
  const shows = allShows.filter((show) => { const provider = tracker.domain && providerFor(tracker.domain, show); return show.titleSnapshot.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || filter === "ended" ? filter === "all" || provider?.status === "ended" : show.userState === filter); });
  const isFiltered = search.trim().length > 0 || filter !== "all";
  return <><PageHeading title="Library" description="Search and manage every show stored in your tracker." count={allShows.length} countLabel="Total shows" {...(isFiltered ? { countDetail: `${shows.length} shown` } : {})}/><div className="library-tools"><label className="search"><span className="sr-only">Search library</span><span aria-hidden="true">⌕</span><input placeholder="Search shows" value={search} onChange={(event) => setSearch(event.target.value)}/></label><div className="filter-tabs" role="group" aria-label="Filter library">{FILTERS.map(([value, label]) => <button className={filter === value ? "active" : ""} aria-pressed={filter === value} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div></div>
    {!shows.length && <Empty title="No matching shows">Try another search or filter.</Empty>}<section className="library-grid" aria-label="Tracked shows">{shows.map((show) => { const summary = librarySummary(tracker.domain!, show, tracker.now), poster = posterUrls(summary.provider); return <a className="show-card" href={`#/show/${show.id}`} key={show.id}><Poster title={show.titleSnapshot} {...poster}/><div className="show-card-copy"><h2>{show.titleSnapshot}</h2><div className="badges"><span className="badge accent">{stateLabel(show.userState)}</span><span className="badge">TVMaze</span>{summary.provider?.status && <span className="badge">{stateLabel(summary.provider.status)}</span>}</div><p className="progress-count"><strong>{summary.watched} / {summary.available}</strong> available watched</p>{summary.nextAired ? <p>Next: {episodeCode(summary.nextAired)} · {summary.nextAired.name ?? "Untitled"}</p> : <p>No aired episode waiting</p>}{summary.nextFuture && <p className="muted">Upcoming: {episodeCode(summary.nextFuture)} · {summary.nextFuture.airdate ?? "TBA"}</p>}</div></a>; })}</section><TvMazeAttribution/></>;
}

export function ShowDetail({ tracker }: { tracker: Tracker }) {
  const { id } = useParams(), navigate = useNavigate();
  const [previousPrompt, setPreviousPrompt] = useState<{ episodeId: number; previousIds: number[] }>();
  useEffect(() => {
    if (!previousPrompt) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".previous-panel") && !target?.closest(`[data-episode-toggle="${previousPrompt.episodeId}"]`)) setPreviousPrompt(undefined);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [previousPrompt]);
  const show = tracker.local?.shows.find((candidate) => candidate.id === id);
  if (!show || !tracker.domain) return <Empty title="Show not found">It may have been removed from this tracker.</Empty>;
  const provider = providerFor(tracker.domain, show), poster = posterUrls(provider), seasons = groupRegularEpisodesBySeason(tracker.domain, show, tracker.now);
  const imdbId = show.externalIds.imdb ?? provider?.externalIds.imdb;
  const startYear = provider?.premiered?.slice(0, 4), endYear = provider?.ended?.slice(0, 4);
  const yearRange = startYear ? (endYear && endYear !== startYear ? `${startYear}–${endYear}` : startYear) : undefined;
  const platform = provider?.webChannelName ?? provider?.networkName;
  const orderedEpisodes = seasons.flatMap((season) => season.episodes);
  const watched = new Set(tracker.local?.progress.filter((item) => item.localShowId === show.id && item.watched).map((item) => item.tvmazeEpisodeId));
  const allAired = seasons.flatMap((season) => season.episodes).filter((episode) => getEpisodeAvailability(episode, tracker.now, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour) === "available").map((episode) => episode.id);
  const watchedAired = allAired.filter((episodeId) => watched.has(episodeId)), backlog = orderedEpisodes.filter((episode) => allAired.includes(episode.id) && !watched.has(episode.id));
  const nextAired = backlog[0], nextFutureEpisode = librarySummary(tracker.domain, show, tracker.now).nextFuture;
  const progressPercent = allAired.length ? Math.round((watchedAired.length / allAired.length) * 100) : 0;
  const savedProgressCount = tracker.local.progress.filter((item) => item.localShowId === show.id).length;
  const remove = async () => { if (!window.confirm(`Remove ${show.titleSnapshot} and its local progress?`)) return; await tracker.removeShow(show.id); navigate("/library"); };
  const markCaughtUp = async () => {
    if (backlog.length === 0 || !window.confirm(`Mark ${backlog.length} currently unwatched aired episode${backlog.length === 1 ? "" : "s"} of ${show.titleSnapshot} as watched? Future episodes will not be changed.`)) return;
    await tracker.markCaughtUp(show, allAired, provider?.status === "ended" ? "completed" : "caught_up");
  };
  const resetToNotStarted = async () => {
    if (!window.confirm(`Reset ${show.titleSnapshot} to Not started? This clears ${savedProgressCount} saved episode progress record${savedProgressCount === 1 ? "" : "s"}.`)) return;
    await tracker.setShowState(show.id, "not_started");
  };
  const chooseEpisode = async (episode: ProviderEpisode, isWatched: boolean) => {
    if (isWatched) { setPreviousPrompt(undefined); await tracker.markEpisode(show, episode.id, false); return; }
    if (getEpisodeAvailability(episode, tracker.now, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour) !== "available") {
      setPreviousPrompt(undefined); await tracker.markEpisode(show, episode.id, true); return;
    }
    const episodeIndex = orderedEpisodes.findIndex((candidate) => candidate.id === episode.id);
    const previousIds = orderedEpisodes.slice(0, episodeIndex).filter((candidate) => !watched.has(candidate.id) &&
      getEpisodeAvailability(candidate, tracker.now, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour) === "available").map((candidate) => candidate.id);
    if (previousIds.length > 0) setPreviousPrompt({ episodeId: episode.id, previousIds });
    else setPreviousPrompt(undefined);
    await tracker.markEpisode(show, episode.id, true);
  };
  return <>
    <a className="back-link" href="#/library">← Back to Library</a>
    <section className="show-hero"><div className="hero-poster"><Poster title={show.titleSnapshot} {...poster} size="detail"/>{imdbId && <a className="imdb-poster-link" href={`https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`} target="_blank" rel="noreferrer" aria-label={`Open ${show.titleSnapshot} on IMDb`} title="Open on IMDb"><span aria-hidden="true">↗</span></a>}</div><div className="hero-copy"><p className="eyebrow">Show details</p><h1>{show.titleSnapshot}</h1><div className="badges"><span className="badge accent">{stateLabel(show.userState)}</span><span className="badge">{stateLabel(provider?.status ?? "metadata unavailable")}</span></div>
      {(yearRange || provider?.rating != null || provider?.runtimeMinutes || platform) && <dl className="show-facts" aria-label="Show information">
        {yearRange && <div><dt>Years</dt><dd>{yearRange}</dd></div>}
        {provider?.rating != null && <div><dt>TVMaze rating</dt><dd><span aria-hidden="true">★</span> {provider.rating.toFixed(1)} / 10</dd></div>}
        {provider?.runtimeMinutes && <div><dt>Episode length</dt><dd>{provider.runtimeMinutes} min</dd></div>}
        {platform && <div><dt>{provider?.webChannelName ? "Streaming on" : "Network"}</dt><dd>{platform}</dd></div>}
      </dl>}
      {(provider?.genres?.length || provider?.showType || provider?.language) && <div className="show-metadata-line">{provider.genres?.map((genre) => <span className="genre" key={genre}>{genre}</span>)}{provider.showType && <span>{provider.showType}</span>}{provider.language && <span>{provider.language}</span>}</div>}
      <dl className="tracking-dates" aria-label="Dates added to tracking sources">
        {show.imdbAddedAt && <div><dt>IMDb list</dt><dd>Added <time dateTime={show.imdbAddedAt}>{formatAddedDate(show.imdbAddedAt)}</time></dd></div>}
        {show.tvTimeAddedAt && <div><dt>TV Time</dt><dd>Added <time dateTime={show.tvTimeAddedAt}>{formatAddedDate(show.tvTimeAddedAt)}</time></dd></div>}
        <div><dt>Tracker</dt><dd>Added <time dateTime={show.createdAt}>{formatAddedDate(show.createdAt)}</time></dd></div>
      </dl>
      <TvMazeAttribution/><div className="show-actions">
      {backlog.length > 0 && <AsyncButton className="primary" busyLabel="Updating…" onAction={markCaughtUp}>Mark caught up</AsyncButton>}
      {show.userState === "paused" ? <AsyncButton busyLabel="Resuming…" onAction={() => tracker.setShowState(show.id, "watching")}>Resume</AsyncButton> : backlog.length > 0 && ["watching", "caught_up"].includes(show.userState) ? <AsyncButton busyLabel="Pausing…" onAction={() => tracker.setShowState(show.id, "paused")}>Pause</AsyncButton> : null}
    </div><details className="show-more-actions"><summary>More actions</summary><p>Resetting clears episode progress. Removing deletes the show from this tracker.</p><div><AsyncButton busyLabel="Resetting…" onAction={resetToNotStarted}>Reset to not started</AsyncButton><AsyncButton className="danger" busyLabel="Removing…" onAction={remove}>Remove from tracker</AsyncButton></div></details></div></section>
    <section className="show-overview" aria-label="Show progress and next episodes">
      <article className="progress-overview"><p className="eyebrow">Aired progress</p><div className="progress-heading"><h2>{watchedAired.length} / {allAired.length}</h2><strong>{progressPercent}%</strong></div><progress max={Math.max(allAired.length, 1)} value={watchedAired.length} aria-label={`${watchedAired.length} of ${allAired.length} aired episodes watched`}/><p>{backlog.length === 0 ? "You are caught up with every available episode." : `${backlog.length} aired episode${backlog.length === 1 ? "" : "s"} waiting.`}</p></article>
      {nextAired ? <article className="next-episode-panel waiting"><p className="eyebrow">Watch next</p><div className="next-episode-copy"><span className="episode-code">{episodeCode(nextAired)}</span><h2>{nextAired.name ?? "Untitled episode"}</h2>{nextAired.runtimeMinutes && <p>{nextAired.runtimeMinutes} min</p>}</div><AsyncButton className="primary" busyLabel="Saving…" onAction={() => tracker.markEpisode(show, nextAired.id, true)}>Mark watched</AsyncButton></article> : <article className="next-episode-panel caught-up"><p className="eyebrow">Watch next</p><h2>No aired episode waiting</h2><p>{show.userState === "paused" ? "This show is paused." : "You’re caught up for now."}</p></article>}
      {nextFutureEpisode && (() => { const release = episodeReleaseInstant(nextFutureEpisode, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour); return <article className="next-episode-panel upcoming"><p className="eyebrow">Coming up</p>{release && <strong className="overview-countdown">{releaseCountdown(release, tracker.now)}</strong>}<span className="episode-code">{episodeCode(nextFutureEpisode)}</span><h2>{nextFutureEpisode.name ?? "Title to be announced"}</h2>{release && <time dateTime={release.toISOString()}>{formatInTimeZone(release, tracker.domain!.settings.timezone, nextFutureEpisode.airstamp || nextFutureEpisode.airtime ? "PP · p" : "PP")}</time>}</article>; })()}
    </section>
    <section className="seasons" aria-label="Seasons">{seasons.map((season, index) => {
      const airedSeasonIds = season.episodes.filter((episode) => getEpisodeAvailability(episode, tracker.now, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour) === "available").map((episode) => episode.id);
      const seasonWatched = airedSeasonIds.length > 0 && airedSeasonIds.every((episodeId) => watched.has(episodeId));
      return <details className="season" key={season.season} open={index === 0}><summary><span>Season {season.season}</span><span className="season-summary-actions"><span>{season.watched} / {season.total} watched</span><AsyncButton className={`season-toggle ${seasonWatched ? "checked" : ""}`} busyLabel="" aria-label={`${seasonWatched ? "Mark aired season unwatched" : "Mark aired season watched"}: Season ${season.season}`} aria-pressed={seasonWatched} disabled={airedSeasonIds.length === 0} onAction={(event) => { event.preventDefault(); event.stopPropagation(); return tracker.setEpisodesWatched(show, airedSeasonIds, !seasonWatched); }}><span aria-hidden="true">✓</span></AsyncButton></span></summary>
        <div className="season-toolbar"><span>{season.available} currently available</span></div>
        <div className="episode-rows">{season.episodes.map((episode) => {
          const availability = getEpisodeAvailability(episode, tracker.now, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour), release = episodeReleaseInstant(episode, tracker.domain!.settings.timezone, tracker.domain!.settings.dateOnlyReleaseHour), prompt = previousPrompt?.episodeId === episode.id ? previousPrompt : undefined, isWatched = watched.has(episode.id) || Boolean(prompt);
          return <article className={`episode-row ${availability}`} key={episode.id}><div className="episode-number">E{String(episode.number).padStart(2, "0")}</div><div><h3>{episode.name ?? "Untitled episode"}</h3><p><span className={`availability ${availability}`}>{availability}</span>{release ? ` · ${formatInTimeZone(release, tracker.domain!.settings.timezone, episode.airstamp || episode.airtime ? "PP · p" : "PP")}` : " · Release unknown"}{episode.runtimeMinutes ? ` · ${episode.runtimeMinutes} min` : ""}</p>{(episode.summary || episode.image || episode.rating != null) && <details className="episode-extra"><summary>Episode details</summary><div>{episode.image && <img src={episode.image.medium ?? episode.image.original} alt="" loading="lazy" decoding="async"/>}<div>{episode.rating != null && <p className="episode-rating"><span aria-hidden="true">★</span> {episode.rating.toFixed(1)} / 10</p>}{episode.summary && <p>{episode.summary}</p>}</div></div></details>}</div><div className="episode-actions">
            {prompt && <div className="previous-panel" role="group" aria-label="Previous unwatched episodes"><p>{prompt.previousIds.length} previous aired episode{prompt.previousIds.length === 1 ? " is" : "s are"} still unwatched.</p><AsyncButton busyLabel="Saving…" onAction={async () => { setPreviousPrompt(undefined); await tracker.markEpisodes(show, prompt.previousIds); }}>Mark previous episodes</AsyncButton><button className="panel-close" aria-label="Dismiss" onClick={() => setPreviousPrompt(undefined)}>×</button></div>}
            <AsyncButton data-episode-toggle={episode.id} className={`episode-toggle ${isWatched ? "checked" : ""}`} busyLabel="" aria-label={`${isWatched ? "Mark unwatched" : "Mark watched"}: ${episode.name ?? episodeCode(episode)}`} aria-pressed={isWatched} onAction={() => chooseEpisode(episode, isWatched)}><span aria-hidden="true">✓</span></AsyncButton>
          </div></article>;
        })}</div>
      </details>;
    })}</section>
  </>;
}

function SettingsPage({ tracker }: { tracker: Tracker }) {
  const navigate = useNavigate();
  const hour = tracker.local?.settings.dateOnlyReleaseHour ?? "09:00";
  const [pendingBackup, setPendingBackup] = useState<TrackerBackup>();
  const [restoreMessage, setRestoreMessage] = useState<{ kind: "error" | "success"; text: string }>();
  const [metadataAction, setMetadataAction] = useState<"refresh" | "redownload">();
  async function setHour(value: string) { await updateLocalState((state) => ({ ...state, settings: { ...state.settings, dateOnlyReleaseHour: value } })); await tracker.reload(); }
  function download() { if (!tracker.local) return; const blob = new Blob([JSON.stringify(createBackup(tracker.local), null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `imdb-shows-tracker-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); }
  async function inspectRestore(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { setPendingBackup(parseBackup(await file.text())); setRestoreMessage(undefined); }
    catch { setPendingBackup(undefined); setRestoreMessage({ kind: "error", text: "This is not a valid Tracker backup, or it was created by an unsupported version." }); }
  }
  async function applyRestore() {
    if (!pendingBackup || !window.confirm(`Replace the current ${tracker.local?.shows.length ?? 0} shows with ${pendingBackup.state.shows.length} shows from this backup?`)) return;
    try { await writeLocalState(pendingBackup.state); }
    catch { setRestoreMessage({ kind: "error", text: "Restore failed before the replacement could be saved." }); return; }
    setPendingBackup(undefined);
    try { await tracker.reload(); await chrome.runtime.sendMessage({ type: "SYNC_NOW" }); await tracker.reload(); setRestoreMessage({ kind: "success", text: "Backup restored and TVMaze metadata refreshed." }); }
    catch { setRestoreMessage({ kind: "success", text: "Backup restored. Metadata refresh failed, so use Refresh metadata when you are online." }); }
  }
  async function refreshMetadata(redownload = false) {
    setMetadataAction(redownload ? "redownload" : "refresh");
    try {
      if (redownload) await resetMetadataCache();
      const result = await chrome.runtime.sendMessage({ type: "SYNC_NOW" }) as { ok?: boolean; error?: string } | undefined;
      if (!result?.ok) throw new Error(result?.error ?? "TVMaze metadata could not be refreshed.");
      await tracker.reload();
    } finally { setMetadataAction(undefined); }
  }
  async function removeAllData() {
    const count = tracker.local?.shows.length ?? 0;
    if (!window.confirm(`Delete all data for ${count} tracked show${count === 1 ? "" : "s"}? This permanently removes the library, episode progress, watched history, import state, settings, and cached metadata.`)) return;
    await writeLocalState(emptyLocalState());
    await clearTrackerDatabase();
    await tracker.reload();
    try { await chrome.runtime.sendMessage({ type: "SYNC_NOW" }); } catch { /* Data is already cleared; badge refresh can retry later. */ }
    navigate("/library");
  }
  const showCount = tracker.local?.shows.length ?? 0;
  return <><PageHeading title="Settings" description="Release timing, backups, and extension information."/><section className="settings"><h2>Release timing</h2><label>Date-only release hour <input type="time" value={hour} onChange={(event) => void setHour(event.target.value)}/></label><p>Timezone: {tracker.local?.settings.timezone}</p><div className="show-actions"><AsyncButton disabled={metadataAction !== undefined} busyLabel={`Checking ${showCount} shows…`} successLabel="Metadata refreshed" onAction={() => refreshMetadata()}>Refresh metadata</AsyncButton><AsyncButton disabled={metadataAction !== undefined} busyLabel={`Downloading ${showCount} shows…`} successLabel="Metadata rebuilt" onAction={() => refreshMetadata(true)}>Re-download all metadata</AsyncButton></div><p className="settings-help">Refresh checks for changed shows. Re-download clears only the provider request cache and replaces metadata as fresh responses arrive; your library and watch progress remain untouched.</p></section><section className="settings"><h2>Backup and restore</h2><p>Backups contain your library, progress, history, and settings. Provider images and episode metadata are refreshed after restore.</p><button onClick={download}>Export JSON backup</button><label className="file-button">Choose backup to restore<input hidden type="file" accept="application/json,.json" onChange={(event) => void inspectRestore(event)}/></label>
    {pendingBackup && <div className="restore-preview"><h3>Review backup before replacing local data</h3><dl><div><dt>Exported</dt><dd>{new Date(pendingBackup.exportedAt).toLocaleString()}</dd></div><div><dt>Shows</dt><dd>{pendingBackup.state.shows.length}</dd></div><div><dt>Progress records</dt><dd>{pendingBackup.state.progress.length}</dd></div><div><dt>History actions</dt><dd>{pendingBackup.state.history.length}</dd></div></dl><p>This replaces the current local tracker state. It does not merge the two libraries.</p><div className="show-actions"><button onClick={() => setPendingBackup(undefined)}>Cancel</button><AsyncButton className="danger" busyLabel="Replacing…" onAction={applyRestore}>Replace local data</AsyncButton></div></div>}
    {restoreMessage && <p className={restoreMessage.kind === "error" ? "error" : "success-message"} role="status">{restoreMessage.text}</p>}</section><section className="settings danger-zone"><p className="eyebrow">Danger zone</p><h2>Start over</h2><p>Remove the entire local tracker and return to an empty Library. Export a backup first if you may want this data again.</p><AsyncButton className="danger" busyLabel="Removing all data…" onAction={removeAllData}>Remove all data</AsyncButton></section><section className="settings"><h2>About</h2><p><strong>Tracker is an unofficial extension.</strong> It is not affiliated with, endorsed by, or sponsored by IMDb or TV Time.</p><p>Current build: <strong>{FIXTURE_BUILD ? "Fixture subset (newest 20 plus required shows)" : "Production full import"}</strong></p><p><a href="https://www.tvmaze.com/api" target="_blank" rel="noreferrer">Metadata and images provided by TVMaze under CC BY-SA.</a></p></section></>;
}

export function App() { const tracker = useTracker(), location = useLocation(); if (tracker.error) return <main><section className="error-state" role="alert"><h1>{navigator.onLine ? "Tracker couldn’t load" : "You’re offline"}</h1><p>{navigator.onLine ? tracker.error : "Local progress remains safe. Reconnect to refresh TVMaze metadata, then retry."}</p><AsyncButton busyLabel="Retrying…" onAction={tracker.reload}>Retry</AsyncButton></section></main>; if (!tracker.local || !tracker.domain) return <main><div className="loading-state" role="status"><span className="spinner"/><p>Loading your tracker…</p></div></main>; return <Layout status={tracker.status}><RouteScrollReset/><div className="route-stage" key={location.pathname}><Routes location={location}><Route path="/watch-list" element={<WatchList tracker={tracker}/>}/><Route path="/upcoming" element={<Upcoming tracker={tracker}/>}/><Route path="/library" element={<Library tracker={tracker}/>}/><Route path="/show/:id" element={<ShowDetail tracker={tracker}/>}/><Route path="/import" element={<ImportPage tracker={tracker}/>}/><Route path="/settings" element={<SettingsPage tracker={tracker}/>}/><Route path="*" element={<Navigate to="/watch-list" replace/>}/></Routes></div></Layout>; }
