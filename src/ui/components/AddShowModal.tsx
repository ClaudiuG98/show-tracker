import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderShow } from "../../domain/models";
import { posterUrls } from "../../domain/view-models";
import { TvMazeProvider } from "../../providers/tvmaze/provider";
import type { useTracker } from "../useTracker";
import { AsyncButton } from "./AsyncButton";
import { Poster } from "./Poster";

type Tracker = ReturnType<typeof useTracker>;
const searchProvider = new TvMazeProvider();

export function AddShowModal({ tracker, onClose }: { tracker: Tracker; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProviderShow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [trackedIds, setTrackedIds] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);

  // Prevent the Library page behind the modal from scrolling while it's open. Plain
  // `overflow: hidden` clamps scrollY to 0 (there is nothing left to scroll), so pin the
  // body in place with position: fixed instead, which preserves the underlying scroll offset.
  useLayoutEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    const previous = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      window.scrollTo(0, scrollY);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onQueryChange(value: string) {
    setQuery(value);
    const trimmed = value.trim();
    // Set "searching" in the same batch as the query update so there is no
    // intermediate render where the query is non-empty but search hasn't started
    // yet (that gap briefly rendered a false "no shows matched" flash).
    if (trimmed) { setSearching(true); setSearchError(""); }
    else { setSearching(false); setResults([]); setSearchError(""); }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const currentQuery = trimmed;
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchProvider.searchShows(currentQuery);
        if (query.trim() !== currentQuery) return;
        setResults(found); setSearching(false); setSearchError("");
      } catch (cause) {
        if (query.trim() !== currentQuery) return;
        setSearchError(cause instanceof Error ? cause.message : "Search failed.");
        setSearching(false);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  const alreadyTracked = (show: ProviderShow) =>
    trackedIds.has(show.id) || (tracker.local?.shows.some((tracked) => tracked.externalIds.tvmazeShow === show.id) ?? false);

  async function track(show: ProviderShow) {
    const episodes = await searchProvider.getEpisodes(show.id);
    await tracker.addShow(show, episodes);
    setTrackedIds((current) => new Set(current).add(show.id));
  }

  return createPortal(
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="add-show-title">
        <div className="modal-top">
          <div className="modal-header"><h2 id="add-show-title">Add a show</h2><button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button></div>
          <label className="search"><span aria-hidden="true">⌕</span><span className="sr-only">Search TVMaze for a show to add</span>
            <input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search by show title"/>
            {searching && <span className="search-spinner" aria-hidden="true"/>}</label>
          {searchError && <p className="error" role="alert">{searchError}</p>}
          {!searching && query.trim() && results.length === 0 && !searchError && <p className="empty-inline">No shows matched “{query.trim()}”.</p>}
        </div>
        <div className="add-show-results" aria-live="polite">{results.map((show) => {
          const tracked = alreadyTracked(show);
          return <div className="add-show-row" key={show.id}>
            <Poster title={show.name} {...posterUrls(show)}/>
            <div className="add-show-copy"><strong>{show.name}</strong><span>{show.premiered?.slice(0, 4) ?? "TBA"} · {show.status.replaceAll("_", " ")}{show.networkName ? ` · ${show.networkName}` : show.webChannelName ? ` · ${show.webChannelName}` : ""}</span></div>
            {tracked ? <span className="badge accent">Tracked</span>
              : <AsyncButton busyLabel="Adding…" successLabel="Added" onAction={() => track(show)}>Track</AsyncButton>}
          </div>;
        })}</div>
      </div>
    </div>,
    document.body,
  );
}
