export const GLOBAL_HOST_ID = "tv-tracker-global-control";
export const TITLE_HOST_ID = "tv-tracker-title-control";

type TrackerResponse = { ok?: boolean; tracked?: boolean; showId?: string; count?: number; error?: string };
type SendMessage = (message: Record<string, unknown>) => Promise<TrackerResponse>;

const STYLE = `:host{all:initial;display:inline-flex;margin:0 6px;vertical-align:middle}:host([data-kind="title"]:not([data-fallback])){display:flex;width:100%;margin:8px 0 0}:host([data-kind="title"]:not([data-fallback])) .title{width:100%;justify-content:center}button{display:inline-flex;align-items:center;min-height:40px;border:1px solid #777;border-radius:20px;padding:0 15px;background:#252525;color:#fff;font:700 14px Arial,sans-serif;cursor:pointer;white-space:nowrap}button:hover{border-color:#f5c518}button:focus-visible{outline:3px solid #8fc7ff;outline-offset:2px}button.loading{cursor:wait}.title{background:#f5c518;color:#111;border-color:#f5c518}.mark{display:block;width:24px;height:24px;flex:0 0 24px;margin-right:7px;object-fit:contain}.loading .mark{width:15px;height:15px;flex-basis:15px;border:2px solid #1115;border-top-color:#111;border-radius:50%;animation:tracker-spin .7s linear infinite}.count{display:inline-grid;place-items:center;min-width:21px;height:21px;margin-left:8px;padding:0 4px;border-radius:11px;background:#f5c518;color:#111;font-size:12px}.title .count{display:none}:host([data-fallback]){position:fixed;right:18px;bottom:18px;z-index:2147483646}:host([data-fallback][data-kind="title"]){bottom:68px}@keyframes tracker-spin{to{transform:rotate(1turn)}}@media(prefers-reduced-motion:reduce){*{transition:none!important}.loading .mark{animation-duration:1.5s}}`;

const iconUrl = (kind: "global" | "title") => {
  const path = kind === "title" ? "icons/imdb-mark-32.png" : "icons/icon-32.png";
  return typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : `/${path}`;
};

const imdbIdFromPath = (pathname: string) => pathname.match(/^\/title\/(tt\d+)/)?.[1];

function schemaTypes(document: Document): string[] {
  const types: string[] = [];
  const inspectEntity = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(inspectEntity); return; }
    if (!value || typeof value !== "object") return;
    const entity = value as Record<string, unknown>;
    if (typeof entity["@type"] === "string") types.push(entity["@type"]);
    if (Array.isArray(entity["@graph"])) entity["@graph"].forEach(inspectEntity);
  };
  document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]').forEach((script) => { try { inspectEntity(JSON.parse(script.textContent ?? "")); } catch { /* IMDb may replace JSON-LD during navigation. */ } });
  return types;
}

export function imdbTitleKind(document: Document): "show" | "movie" | "episode" | "unknown" {
  const types = schemaTypes(document);
  if (types.some((type) => type === "TVEpisode")) return "episode";
  if (types.some((type) => type === "Movie")) return "movie";
  if (types.some((type) => ["TVSeries", "TVMiniSeries"].includes(type))) return "show";
  return "unknown";
}

function reserveHost(document: Document, id: string, kind: "global" | "title", target: Element | null) {
  const existing = document.getElementById(id) as HTMLElement | null;
  if (existing) return existing;
  const host = document.createElement("span"); host.id = id; host.dataset.kind = kind; host.dataset.trackerReserved = "true";
  if (target?.parentElement) target.insertAdjacentElement("afterend", host);
  else { host.dataset.fallback = "true"; document.body?.append(host); }
  host.attachShadow({ mode: "open" });
  return host;
}

function renderButton(host: HTMLElement, label: string, kind: "global" | "title", onClick: () => void, count?: number, loading = false) {
  const shadow = host.shadowRoot!; shadow.replaceChildren();
  const style = document.createElement("style"); style.textContent = STYLE;
  const control = document.createElement("button"); control.type = "button"; control.className = `${kind}${loading ? " loading" : ""}`; control.setAttribute("aria-label", label); control.disabled = loading; control.setAttribute("aria-busy", String(loading));
  const mark = loading ? document.createElement("span") : document.createElement("img");
  mark.className = "mark"; mark.setAttribute("aria-hidden", "true");
  if (mark instanceof HTMLImageElement) { mark.src = iconUrl(kind); mark.alt = ""; }
  const text = document.createElement("span"); text.textContent = label; control.append(mark, text);
  if (kind === "global") { const badge = document.createElement("span"); badge.className = "count"; badge.textContent = String(count ?? 0); badge.setAttribute("aria-label", `${count ?? 0} shows waiting`); control.append(badge); }
  control.addEventListener("click", onClick); shadow.append(style, control); return control;
}

export async function synchronizeImdbControls(document: Document, pathname: string, send: SendMessage) {
  if (!document.body) return;
  const globalTarget = document.querySelector('a[href*="/list/watchlist"], [data-testid="watchlist-button"]');
  const globalHost = reserveHost(document, GLOBAL_HOST_ID, "global", globalTarget);
  const id = imdbIdFromPath(pathname), kind = id ? imdbTitleKind(document) : "unknown";
  const oldTitle = document.getElementById(TITLE_HOST_ID);
  if (!id || kind !== "show") oldTitle?.remove();
  const titleTarget = id && kind === "show" ? document.querySelector('[data-testid="tm-box-wl-button"], [data-testid="hero-rating-bar__watchlist"], [data-testid*="add-to-watchlist"]') : null;
  const titlePlacement = titleTarget?.parentElement ?? titleTarget;
  const titleHost = id && kind === "show" ? reserveHost(document, TITLE_HOST_ID, "title", titlePlacement) : undefined;
  const route = `${pathname}:${id ?? ""}`;
  const globalReady = globalHost.dataset.route === route && globalHost.dataset.ready === "true";
  const titleReady = !titleHost || titleHost.dataset.route === route && titleHost.dataset.ready === "true";
  if (globalReady && titleReady) return;
  if (globalHost.dataset.hydrating === route || titleHost?.dataset.hydrating === route) return;
  globalHost.dataset.route = route; globalHost.dataset.hydrating = route;
  if (titleHost) { titleHost.dataset.route = route; titleHost.dataset.hydrating = route; }
  if (!globalReady) renderButton(globalHost, "Tracker", "global", () => void send({ type: "OPEN_DASHBOARD", route: "/watch-list" }), 0);
  if (titleHost && !titleReady) renderButton(titleHost, "Tracker", "title", () => undefined, undefined, true);
  const status: TrackerResponse = await send(id ? { type: "GET_IMDB_STATUS", imdbId: id } : { type: "GET_TRACKER_SUMMARY" }).catch(() => ({ ok: false }));
  if (globalHost.dataset.route !== route || !globalHost.isConnected) return;
  renderButton(globalHost, "Tracker", "global", () => void send({ type: "OPEN_DASHBOARD", route: "/watch-list" }), status.count ?? 0);
  globalHost.dataset.ready = "true"; delete globalHost.dataset.hydrating;
  if (!titleHost || titleHost.dataset.route !== route || !titleHost.isConnected || !id) return;
  let tracked = Boolean(status.tracked), showId = status.showId;
  const paint = (label = tracked ? "Tracked" : "Track show") => {
    const control = renderButton(titleHost, label, "title", async () => {
      if (tracked) { await send({ type: "OPEN_DASHBOARD", route: showId ? `/show/${showId}` : "/library" }); return; }
      control.disabled = true; paint("Adding…");
      const result: TrackerResponse = await send({ type: "TRACK_IMDB_SHOW", imdbId: id }).catch(() => ({ ok: false, error: "Could not add show" }));
      if (result.ok) { tracked = true; showId = result.showId; paint(); } else paint(result.error ?? "Try again");
    });
  };
  paint();
  titleHost.dataset.ready = "true"; delete titleHost.dataset.hydrating;
}
