import { fireEvent } from "@testing-library/dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_HOST_ID, TITLE_HOST_ID, imdbTitleKind, synchronizeImdbControls } from "../../src/imdb/integration";

function titleSchema(type: string) { const script = document.createElement("script"); script.type = "application/ld+json"; script.textContent = JSON.stringify({ "@type": type }); document.head.append(script); }
function shadowButton(id: string) { return document.getElementById(id)?.shadowRoot?.querySelector("button") as HTMLButtonElement | null; }

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

describe("IMDb integration", () => {
  it("reserves integrated hosts once and prevents duplicates", async () => {
    document.body.innerHTML = '<a href="/list/watchlist">Watchlist</a><button data-testid="tm-box-wl-button">IMDb watchlist</button>'; titleSchema("TVSeries");
    const send = vi.fn(async () => ({ ok: true, tracked: false, count: 4 }));
    const first = synchronizeImdbControls(document, "/title/tt123/", send);
    expect(document.querySelectorAll(`#${GLOBAL_HOST_ID}, #${TITLE_HOST_ID}`)).toHaveLength(2);
    await Promise.all([first, synchronizeImdbControls(document, "/title/tt123/", send)]);
    expect(document.querySelectorAll(`#${GLOBAL_HOST_ID}`)).toHaveLength(1); expect(document.querySelectorAll(`#${TITLE_HOST_ID}`)).toHaveLength(1);
    expect(shadowButton(GLOBAL_HOST_ID)).toHaveTextContent("4"); expect(document.getElementById(GLOBAL_HOST_ID)).not.toHaveAttribute("data-fallback");
    expect(shadowButton(GLOBAL_HOST_ID)?.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/icons/icon-32.png"));
    expect(shadowButton(TITLE_HOST_ID)?.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/icons/imdb-mark-32.png"));
  });

  it("suppresses show controls for movies and episodes", async () => {
    titleSchema("Movie"); expect(imdbTitleKind(document)).toBe("movie");
    await synchronizeImdbControls(document, "/title/tt999/", vi.fn(async () => ({ ok: true, count: 0 })));
    expect(document.getElementById(TITLE_HOST_ID)).not.toBeInTheDocument(); expect(document.getElementById(GLOBAL_HOST_ID)).toBeInTheDocument();
  });

  it("uses a safe fallback and opens a tracked show's detail page", async () => {
    titleSchema("TVMiniSeries"); const send = vi.fn(async (message: Record<string, unknown>) => message.type === "GET_IMDB_STATUS"
      ? { ok: true, tracked: true, showId: "local-show", count: 2 } : { ok: true });
    await synchronizeImdbControls(document, "/title/tt42/", send);
    expect(document.getElementById(TITLE_HOST_ID)).toHaveAttribute("data-fallback", "true");
    fireEvent.click(shadowButton(TITLE_HOST_ID)!);
    expect(send).toHaveBeenLastCalledWith({ type: "OPEN_DASHBOARD", route: "/show/local-show" });
  });
});
