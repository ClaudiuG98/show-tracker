import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainState } from "../../src/domain/selectors";
import { EpisodeDetail, Library, SettingsPage, ShowDetail, Upcoming, WatchList } from "../../src/ui/App";
import { Poster } from "../../src/ui/components/Poster";
import { ImportPage } from "../../src/ui/import/ImportPage";
import { resetImportStore, useImportStore } from "../../src/ui/import/import-store";
import type { useTracker } from "../../src/ui/useTracker";
import { emptyImportDecisions } from "../../src/imports/preview";
import type { ImportAnalysis } from "../../src/imports/session";
import { bingersZip } from "../fixtures/bingers";
import { TvMazeProvider } from "../../src/providers/tvmaze/provider";

afterEach(() => { cleanup(); resetImportStore(); vi.restoreAllMocks(); });

const show = { id: "local-1", externalIds: { imdb: "tt1", tvmazeShow: 10 }, titleSnapshot: "Silo", userState: "watching" as const,
  tvTimeRating: 4, importSources: ["manual" as const], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
const domain: DomainState = {
  settings: { timezone: "UTC", dateOnlyReleaseHour: "09:00", notifications: true }, shows: [show], progress: [],
  providerShows: [{ provider: "tvmaze", id: 10, name: "Silo", status: "running", externalIds: { tvmazeShow: 10 },
    image: { medium: "https://static.tvmaze.com/medium.jpg", original: "https://static.tvmaze.com/original.jpg" }, rating: 8.3, updatedAt: 1 }],
  episodes: [
    { id: 1, showId: 10, season: 1, number: 1, name: "Freedom Day", kind: "regular", airstamp: "2024-01-01T20:00:00Z" },
    { id: 2, showId: 10, season: 1, number: 2, name: "Holston's Pick", kind: "regular", airstamp: "2024-01-08T20:00:00Z" },
    { id: 3, showId: 10, season: 1, number: 3, name: "Future", kind: "regular", airdate: "2099-01-01" },
  ],
};

function tracker(overrides: Partial<ReturnType<typeof useTracker>> = {}) {
  return { domain, local: { shows: domain.shows, progress: domain.progress, settings: domain.settings, history: [] }, now: new Date("2025-01-01T00:00:00Z"),
    error: undefined, status: "", reload: vi.fn(), markEpisode: vi.fn(async () => undefined), markEpisodes: vi.fn(async () => undefined),
    setEpisodesWatched: vi.fn(async () => undefined), markCaughtUp: vi.fn(async () => undefined), setShowState: vi.fn(async () => undefined), removeShow: vi.fn(async () => undefined), undo: vi.fn(async () => undefined), ...overrides } as unknown as ReturnType<typeof useTracker>;
}

describe("poster presentation", () => {
  it("renders a lazy provider poster and a graceful title fallback", () => {
    const { rerender } = render(<Poster title="Silo" medium="https://static.tvmaze.com/silo.jpg"/>);
    expect(screen.getByRole("img", { name: "Silo poster" })).toHaveAttribute("loading", "lazy");
    rerender(<Poster title="House of the Dragon"/>);
    expect(screen.getByRole("img", { name: "No poster available for House of the Dragon" })).toHaveTextContent("HO");
  });
});

describe("dashboard cards", () => {
  it("renders the Watch List poster, backlog count, and advances optimistically", async () => {
    let resolve!: () => void; const markEpisode = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(<MemoryRouter><WatchList tracker={tracker({ markEpisode })}/></MemoryRouter>);
    expect(screen.getByText("+1 more")).toBeVisible(); expect(screen.getByRole("img", { name: "Silo poster" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Silo episode details: Freedom Day" })).toHaveAttribute("href", "#/show/local-1/episode/1");
    expect(screen.getByRole("link", { name: "Silo" })).toHaveAttribute("href", "#/show/local-1");
    fireEvent.click(screen.getByRole("button", { name: /Mark Freedom Day watched/ }));
    expect(screen.getByText("Freedom Day").closest("article")).toHaveClass("completing");
    await waitFor(() => expect(markEpisode).toHaveBeenCalled()); resolve();
  });

  it("renders the nearest Upcoming release with date-only and later count", () => {
    const upcomingDomain = { ...domain, episodes: [{ ...domain.episodes[2]!, id: 3, airdate: "2026-01-01" }, { ...domain.episodes[2]!, id: 4, number: 4, airdate: "2026-02-01" }] };
    render(<MemoryRouter><Upcoming tracker={tracker({ domain: upcomingDomain, now: new Date("2025-01-01") })}/></MemoryRouter>);
    expect(screen.getByText(/Date only/)).toBeVisible(); expect(screen.getByText("+1 later announced")).toBeVisible();
  });

  it("filters the Library by user and provider state", () => {
    render(<MemoryRouter><Library tracker={tracker()}/></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Paused" })); expect(screen.queryByText("Silo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Watching" })); expect(screen.getByText("Silo")).toBeVisible();
  });

  it("finds a renamed show by its accent-free name and the title the export used", () => {
    // TVMaze files this show under its native name; the user knows it as "Persona".
    const sahsiyet = { ...show, id: "sahsiyet", externalIds: { tvmazeShow: 14 }, titleSnapshot: "Şahsiyet", sourceTitle: "Persona" };
    const shows = [show, sahsiyet];
    const domainWithRename: DomainState = { ...domain, shows,
      providerShows: [...domain.providerShows, { ...domain.providerShows[0]!, id: 14, name: "Şahsiyet", externalIds: { tvmazeShow: 14 } }] };
    render(<MemoryRouter><Library tracker={tracker({ domain: domainWithRename, local: { ...tracker().local!, shows, progress: [], settings: domain.settings, history: [] } })}/></MemoryRouter>);
    const search = screen.getByRole("textbox", { name: "Search library" });

    fireEvent.change(search, { target: { value: "Sahsiyet" } });
    expect(screen.getByText("Şahsiyet")).toBeVisible();
    expect(screen.queryByText("Silo")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "persona" } });
    expect(screen.getByText("Şahsiyet")).toBeVisible();
    // The Library stays uncluttered -- the alias only appears on the show's own page.
    expect(screen.queryByText(/also known as/)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(screen.queryByText("Şahsiyet")).not.toBeInTheDocument();
  });

  it.each([
    ["Ófærð", "ofaerd"],       // Icelandic eth and ae are letters, not accented vowels
    ["Ødegård", "odegard"],    // Nordic o-slash
    ["Straße", "strasse"],     // German sharp s
    ["Łódź", "lodz"],          // Polish l-stroke
    ["Élite", "elite"],
  ])("finds %s by typing %s", (title, query) => {
    const foreign = { ...show, id: "foreign", externalIds: { tvmazeShow: 15 }, titleSnapshot: title };
    const shows = [foreign];
    const foreignDomain: DomainState = { ...domain, shows,
      providerShows: [{ ...domain.providerShows[0]!, id: 15, name: title, externalIds: { tvmazeShow: 15 } }] };
    render(<MemoryRouter><Library tracker={tracker({ domain: foreignDomain, local: { ...tracker().local!, shows, progress: [], settings: domain.settings, history: [] } })}/></MemoryRouter>);

    fireEvent.change(screen.getByRole("textbox", { name: "Search library" }), { target: { value: query } });

    expect(screen.getByText(title)).toBeVisible();
  });

  it("sorts the Library by source dates, watch activity, release, title, and both ratings", () => {
    const { tvTimeRating: _tvTimeRating, ...unratedShow } = show;
    const shows = [
      { ...show, id: "alpha", externalIds: { tvmazeShow: 11 }, titleSnapshot: "Alpha", imdbAddedAt: "2024-01-01", tvTimeAddedAt: "2020-01-01", tvTimeRating: 5 },
      { ...show, id: "beta", externalIds: { tvmazeShow: 12 }, titleSnapshot: "Beta", tvTimeAddedAt: "2025-01-01", tvTimeRating: 3 },
      { ...unratedShow, id: "gamma", externalIds: { tvmazeShow: 13 }, titleSnapshot: "Gamma", createdAt: "2026-01-01" },
    ];
    const progress = [
      { localShowId: "alpha", tvmazeEpisodeId: 101, season: 1, episode: 1, watched: true, watchedAt: "2026-03-01T00:00:00Z", source: "user" as const },
      { localShowId: "beta", tvmazeEpisodeId: 102, season: 1, episode: 1, watched: true, watchedAt: "2026-02-01T00:00:00Z", source: "user" as const },
    ];
    const sortableDomain: DomainState = { ...domain, shows, progress,
      providerShows: [
        { ...domain.providerShows[0]!, id: 11, name: "Alpha", externalIds: { tvmazeShow: 11 }, rating: 7 },
        { ...domain.providerShows[0]!, id: 12, name: "Beta", externalIds: { tvmazeShow: 12 }, rating: 9 },
        { ...domain.providerShows[0]!, id: 13, name: "Gamma", externalIds: { tvmazeShow: 13 }, rating: 8 },
      ],
      episodes: [
        { id: 201, showId: 11, season: 1, number: 1, kind: "regular", airdate: "2027-02-01" },
        { id: 202, showId: 12, season: 1, number: 1, kind: "regular", airdate: "2027-01-01" },
      ],
    };
    render(<MemoryRouter><Library tracker={tracker({ domain: sortableDomain, local: { ...tracker().local!, shows, progress, settings: sortableDomain.settings, history: [] }, now: new Date("2026-01-01T00:00:00Z") })}/></MemoryRouter>);
    const titles = () => within(screen.getByRole("region", { name: "Tracked shows" })).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    const sort = screen.getByRole("combobox", { name: "Sort by" });

    expect(titles()).toEqual(["Gamma", "Beta", "Alpha"]);
    fireEvent.change(sort, { target: { value: "recently_watched" } }); expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    fireEvent.change(sort, { target: { value: "next_release" } }); expect(titles()).toEqual(["Beta", "Alpha", "Gamma"]);
    fireEvent.change(sort, { target: { value: "title" } }); expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    fireEvent.change(sort, { target: { value: "tvtime_rating" } }); expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    fireEvent.change(sort, { target: { value: "tvmaze_rating" } }); expect(titles()).toEqual(["Beta", "Gamma", "Alpha"]);
  });

  it("formats watched history like show-detail dates", () => {
    const action = { id: "history-1", showId: show.id, episodeKeys: ["1"], action: "watched" as const,
      before: { episodes: [], userState: "watching" as const }, after: { episodes: [], userState: "watching" as const }, occurredAt: "2022-10-11T12:30:00Z" };
    render(<MemoryRouter><WatchList tracker={tracker({ local: { ...tracker().local!, shows: [show], progress: [], settings: domain.settings, history: [action] } })}/></MemoryRouter>);
    fireEvent.click(screen.getByText(/Watched history/));
    expect(within(document.querySelector(".history-group > summary")! as HTMLElement).getByRole("img", { name: "Silo poster" })).toHaveAttribute("src", "https://static.tvmaze.com/medium.jpg");
    expect(document.querySelector(".history-entry .poster")).toBeNull();
    fireEvent.click(document.querySelector(".history-group > summary")!);
    expect(screen.getByText("Oct 11, 2022")).toBeVisible();
  });

  it.each([0, 1, 20, 21, 40, 119])("lets all %i history shows be displayed in batches of 20", async (total) => {
    const history = Array.from({ length: total }, (_, index) => ({
      id: `history-${index}`, showId: `show-${index}`, episodeKeys: ["1"], action: "watched" as const,
      before: { episodes: [], userState: "watching" as const }, after: { episodes: [], userState: "watching" as const },
      occurredAt: new Date(Date.UTC(2026, 0, total - index)).toISOString(),
    }));
    const current = tracker({ local: { ...tracker().local!, history } });
    render(<MemoryRouter><WatchList tracker={current}/></MemoryRouter>);
    fireEvent.click(screen.getByText(/Watched history/));
    expect(screen.getByLabelText(`${total} shows in history`)).toHaveTextContent(String(total));

    if (total === 0) {
      expect(screen.getByText(/Episodes you mark watched will appear here/)).toBeVisible();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } else {
      let visible = Math.min(20, total);
      const expectVisibleEntries = () => {
        expect(document.querySelectorAll(".history-group")).toHaveLength(visible);
        document.querySelectorAll(".history-group:not([open]) > summary").forEach((summary) => fireEvent.click(summary));
        expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(visible);
        expect(screen.getByRole("status")).toHaveTextContent(`Showing ${visible} of ${total} ${total === 1 ? "show" : "shows"}`);
      };
      expectVisibleEntries();
      while (visible < total) {
        fireEvent.click(screen.getByRole("button", { name: "Load more" }));
        visible = Math.min(visible + 20, total);
        expectVisibleEntries();
      }
      const entries = screen.getAllByRole("button", { name: "Undo" }).map((button) => button.closest("article")!);
      expect(entries.map((entry) => entry.querySelector("time")?.dateTime)).toEqual(history.map((action) => action.occurredAt));
      fireEvent.click(within(entries.at(-1)!).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(current.undo).toHaveBeenCalledWith(history.at(-1)));
    }
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("keeps the history count accurate when entries are removed after loading more", () => {
    const action = { id: "history-1", showId: show.id, episodeKeys: ["1"], action: "watched" as const,
      before: { episodes: [], userState: "watching" as const }, after: { episodes: [], userState: "watching" as const }, occurredAt: "2026-01-01T12:00:00Z" };
    const history = Array.from({ length: 21 }, (_, index) => ({ ...action, id: `history-${index}`, showId: `show-${index}` }));
    const renderHistory = (entries: typeof history) => <MemoryRouter><WatchList tracker={tracker({ local: { ...tracker().local!, history: entries } })}/></MemoryRouter>;
    const { rerender } = render(renderHistory(history));
    fireEvent.click(screen.getByText(/Watched history/));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    rerender(renderHistory(history.slice(0, 7)));
    expect(screen.getByRole("status")).toHaveTextContent("Showing 7 of 7 shows");
    document.querySelectorAll(".history-group > summary").forEach((summary) => fireEvent.click(summary));
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();

    rerender(renderHistory([]));
    expect(screen.getByText(/Episodes you mark watched will appear here/)).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows ratings on Library cards only", () => {
    const current = tracker();
    render(<MemoryRouter><WatchList tracker={current}/></MemoryRouter>);
    expect(screen.queryByLabelText("TVMaze rating 8.3 out of 10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("TV Time rating 4.0 out of 5")).not.toBeInTheDocument();

    cleanup();
    render(<MemoryRouter><Upcoming tracker={current}/></MemoryRouter>);
    expect(screen.queryByLabelText("TVMaze rating 8.3 out of 10")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("TV Time rating 4.0 out of 5")).not.toBeInTheDocument();

    cleanup();
    render(<MemoryRouter><Library tracker={current}/></MemoryRouter>);
    expect(screen.getByLabelText("TVMaze rating 8.3 out of 10")).toBeVisible();
    expect(screen.getByLabelText("TV Time rating 4.0 out of 5")).toBeVisible();
  });
});

describe("route-independent operation status", () => {
  it("auto-detects Bingers by archive contents and reaches the existing preview", async () => {
    const lookup = vi.spyOn(TvMazeProvider.prototype, "lookupByTvdbId").mockResolvedValue(domain.providerShows[0]!);
    vi.spyOn(TvMazeProvider.prototype, "getEpisodes").mockResolvedValue(domain.episodes);
    render(<MemoryRouter><ImportPage tracker={tracker()}/></MemoryRouter>);
    const archive = bingersZip();
    const file = { name: "export.zip", size: archive.byteLength, lastModified: 1,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) } as File;
    fireEvent.change(document.querySelector("#import-files")!, { target: { files: [file] } });
    await waitFor(() => expect(useImportStore.getState().phase).toBe("preview"));
    expect(lookup).toHaveBeenCalledWith(10);
    expect(screen.getByText("Bingers")).toBeVisible();
    expect(screen.getByRole("button", { name: "Import 1 show" })).toBeEnabled();
    expect(useImportStore.getState().bingers?.shows).toHaveLength(1);
  });

  it("warns before analyzing overlapping Bingers and TV Time histories", async () => {
    useImportStore.setState({ tvtime: { shows: [], specials: 0, specialFlagMismatches: 0, ignoredEntries: [] } });
    const lookup = vi.spyOn(TvMazeProvider.prototype, "lookupByTvdbId");
    render(<MemoryRouter><ImportPage tracker={tracker()}/></MemoryRouter>);
    const archive = bingersZip();
    fireEvent.change(document.querySelector("#import-files")!, { target: { files: [{ name: "bingers.zip", size: archive.byteLength, lastModified: 1,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) } as File] } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Import these one at a time" })).toBeVisible());
    expect(lookup).not.toHaveBeenCalled();
  });

  it("explains both export sources and keeps files chosen in separate picker sessions", async () => {
    render(<MemoryRouter><ImportPage tracker={tracker()}/></MemoryRouter>);
    expect(screen.getByRole("heading", { name: "Get your export files" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Open your IMDb lists/ })).toHaveAttribute("href", "https://www.imdb.com/profile/lists");
    expect(screen.getByRole("heading", { name: "Import from Refract, Bingers, or TV Time" })).toBeVisible();
    expect(screen.getByText(/TV Time data exports are no longer available/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /Open TV Time data export/ })).not.toBeInTheDocument();

    const input = document.querySelector<HTMLInputElement>("#import-files")!;
    const silo = { name: "silo.csv", size: 70, lastModified: 1, text: async () => "Const,Title,Title Type,Created\ntt14688458,Silo,TV Series,2024-01-01" } as File;
    fireEvent.change(input, { target: { files: [silo] } });
    await waitFor(() => expect(useImportStore.getState().selectedFiles).toHaveLength(1));

    const archive = zipSync({ "followed_tv_show.csv": strToU8("tv_show_id,created_at,updated_at,active,archived,tv_show_name\n403245,2022-10-11 12:30:00,2022-10-11 12:30:00,1,0,Silo") });
    const gdpr = { name: "gdpr-data.zip", size: archive.byteLength, lastModified: 2,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) } as File;
    fireEvent.change(input, { target: { files: [gdpr] } });
    await waitFor(() => expect(useImportStore.getState().selectedFiles).toHaveLength(2));

    expect(within(screen.getByLabelText("Selected files")).getByText("silo.csv")).toBeVisible();
    expect(within(screen.getByLabelText("Selected files")).getByText("gdpr-data.zip")).toBeVisible();
    expect(useImportStore.getState().imdb?.rows.map((row) => row.title)).toEqual(["Silo"]);
    expect(useImportStore.getState().tvtime?.shows.map((item) => item.title)).toEqual(["Silo"]);
  });

  it("restores an in-progress import after the Import page remounts", () => {
    useImportStore.setState({ phase: "analyzing", stageProgress: { stage: "resolve_ids", completed: 2, total: 5, message: "Resolving 2 of 5 shows." } });
    const current = tracker();
    const first = render(<MemoryRouter><ImportPage tracker={current}/></MemoryRouter>);
    expect(screen.getByText("Resolving 2 of 5 shows.")).toBeVisible();
    first.unmount();

    render(<MemoryRouter><ImportPage tracker={current}/></MemoryRouter>);
    expect(screen.getByText("Resolving 2 of 5 shows.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Resolving 2 of 5 shows." })).toHaveValue(2);
  });

  it("renders the parent refresh operation when Settings remounts", () => {
    const current = tracker({ metadataAction: "refresh" });
    const first = render(<MemoryRouter><SettingsPage tracker={current}/></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Checking for updates…" })).toHaveAttribute("aria-busy", "true");
    first.unmount();

    render(<MemoryRouter><SettingsPage tracker={current}/></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Checking for updates…" })).toHaveAttribute("aria-busy", "true");
  });

  it("explains automatic updates and keeps the full download under confirmed troubleshooting", async () => {
    const refreshMetadata = vi.fn(async () => undefined);
    const current = tracker({
      refreshMetadata,
      local: { ...tracker().local!, lastSyncAt: "2026-07-26T13:56:00.000Z" },
    });
    render(<MemoryRouter><SettingsPage tracker={current}/></MemoryRouter>);

    expect(screen.queryByLabelText("Date-only release hour")).not.toBeInTheDocument();
    expect(screen.getByText(/checked automatically once a day/i)).toBeVisible();
    expect(screen.getByText("Jul 26, 2026 · 1:56 PM")).toBeVisible();
    expect(screen.getByText("Up to date")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Re-download all metadata" })).not.toBeVisible();

    fireEvent.click(screen.getByText("Troubleshooting"));
    const redownload = screen.getByRole("button", { name: "Re-download all metadata" });
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(redownload);
    expect(refreshMetadata).not.toHaveBeenCalled();
    await waitFor(() => expect(redownload).not.toHaveAttribute("aria-busy", "true"));
    fireEvent.click(redownload);
    await waitFor(() => expect(refreshMetadata).toHaveBeenCalledWith(true));
  });

  it("shows a persisted automatic-update failure and its retry time", () => {
    const current = tracker({
      local: {
        ...tracker().local!,
        lastSyncAt: "2026-07-25T13:00:00.000Z",
        lastSyncFailure: {
          failedAt: "2026-07-26T13:00:00.000Z",
          message: "TVMaze could not be reached. Check your internet connection.",
          retryAt: "2026-07-26T13:30:00.000Z",
          attempt: 1,
        },
      },
    });

    render(<MemoryRouter><SettingsPage tracker={current}/></MemoryRouter>);

    expect(screen.getByText("Needs retry")).toBeVisible();
    expect(screen.getByText(/Automatic update failed/)).toBeVisible();
    expect(screen.getByText(/TVMaze could not be reached/)).toBeVisible();
    expect(screen.getByText(/The extension will retry/)).toBeVisible();
  });

  it("stops before analysing when two exports both carry watch history", () => {
    // Both describe the same shows, so reconciliation could only read every one as a conflict.
    useImportStore.setState({ phase: "parsed",
      tvtime: { shows: [], specials: 0, specialFlagMismatches: 0, ignoredEntries: [] },
      refract: { shows: [], episodesByShow: new Map(), malformed: [], unsupported: [], duplicates: [], totalRows: 0 } });

    render(<MemoryRouter><ImportPage tracker={tracker()}/></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Import these one at a time" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Import both anyway" })).toBeVisible();
  });

  it("keeps the finished import to a one-line result with diagnostics tucked away", () => {
    const unresolved = { show: "Example", tvdbEpisodeId: 999, season: 2, episode: 1, name: "Episode 1", reason: "No compatible episode." };
    const analysis: ImportAnalysis = {
      sessionId: "session",
      importedAt: "2026-01-01T00:00:00Z",
      counts: { imdbRowsParsed: 0, tvTimeShowsParsed: 1, tvTimeEpisodesParsed: 1 },
      records: [],
      providerShows: [],
      episodesByShow: new Map(),
      report: {
        imdbRowsParsed: 0, tvTimeShowsParsed: 1, exactImdbMatches: 0, exactTvdbMatches: 1,
        successfullyMerged: 0, imdbOnly: 0, tvTimeOnly: 0, conflicts: 0, unmatchedShows: 1, tvTimeEpisodesParsed: 1,
        watchedEpisodesMapped: 0, explicitUnwatchedEpisodesMapped: 0, futureEpisodesExcludedFromBacklog: 0, specialsExcluded: 0,
        unresolvedEpisodes: 1, episodesBackfilled: 0, showsRequiringProgressSetup: 0, providerNetworkErrors: 0, conflictNames: [], unmatchedNames: ["Safe"],
        tvTimeOnlyNames: [], unresolvedEpisodeRecords: [unresolved], numberingConflicts: [], backfilledShows: [], providerErrors: [],
      },
    };
    useImportStore.setState({ phase: "complete", analysis, decisions: emptyImportDecisions(),
      commitResult: { committed: 213, newShows: 180, updatedShows: 33, watchedMapped: 6112, explicitUnwatchedMapped: 0 } });

    render(<MemoryRouter><ImportPage tracker={tracker()}/></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Import complete" })).toBeVisible();
    expect(screen.getByText(/Imported/)).toHaveTextContent("Imported 213 shows and 6112 watched episodes.");
    // The one actionable leftover stays visible; every raw counter hides behind one toggle.
    expect(screen.getByText(/1 show couldn.t be matched/)).toBeVisible();
    expect(screen.getByText("Technical details")).toBeVisible();
    expect(screen.queryByText("Exact TVDB matches")).not.toBeVisible();
    expect(screen.getByRole("link", { name: "Go to Watch List" })).toHaveAttribute("href", "#/watch-list");
  });
});

describe("show seasons", () => {
  it("returns detail pages to the route that opened them", () => {
    vi.spyOn(window.history, "length", "get").mockReturnValue(2);
    const current = tracker();
    const episodeView = render(
      <MemoryRouter initialEntries={["/watch-list", "/show/local-1/episode/1"]} initialIndex={1}>
        <Routes>
          <Route path="/watch-list" element={<h1>Watch List origin</h1>}/>
          <Route path="/show/:id/episode/:episodeId" element={<EpisodeDetail tracker={current}/>}/>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /Next episode S01 · E02/ }));
    expect(screen.getByRole("heading", { name: "Holston's Pick" })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: /Next episode S01 · E03/ }));
    expect(screen.getByRole("heading", { name: "Future" })).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: /Go back/ }));
    expect(screen.getByRole("heading", { name: "Watch List origin" })).toBeVisible();

    episodeView.unmount();
    render(
      <MemoryRouter initialEntries={["/upcoming", "/show/local-1"]} initialIndex={1}>
        <Routes>
          <Route path="/upcoming" element={<h1>Upcoming origin</h1>}/>
          <Route path="/show/:id" element={<ShowDetail tracker={current}/>}/>
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: /Go back/ }));
    expect(screen.getByRole("heading", { name: "Upcoming origin" })).toBeVisible();
  });

  it("renders episode metadata, adjacent episode navigation, and watched control", async () => {
    const episodes = domain.episodes.map((episode) => episode.id === 2 ? { ...episode, runtimeMinutes: 52, rating: 8.7,
      summary: "Holston explains what happened outside the silo.", image: { original: "https://static.tvmaze.com/episode.jpg" } } : episode);
    const detailedDomain = { ...domain, episodes };
    const current = tracker({ domain: detailedDomain, local: { ...tracker().local!, shows: [show], progress: [], settings: detailedDomain.settings, history: [] } });
    render(<MemoryRouter initialEntries={["/show/local-1/episode/2"]}><Routes><Route path="/show/:id/episode/:episodeId" element={<EpisodeDetail tracker={current}/>}/></Routes></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Holston's Pick", level: 1 })).toBeVisible();
    expect(screen.getByText("Holston explains what happened outside the silo.")).toBeVisible();
    expect(screen.getByText("8.7 / 10")).toBeVisible();
    expect(screen.getByText("Monday, Jan 8th, 2024")).toBeVisible();
    expect(screen.queryByText(/8:00 PM/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Holston's Pick episode still" })).toHaveAttribute("src", "https://static.tvmaze.com/episode.jpg");
    expect(screen.getByRole("link", { name: /Previous episode S01 · E01 Freedom Day/ })).toHaveAttribute("href", "#/show/local-1/episode/1");
    expect(screen.getByRole("link", { name: /Next episode S01 · E03 Future/ })).toHaveAttribute("href", "#/show/local-1/episode/3");

    const mark = screen.getByRole("button", { name: "Mark watched" });
    expect(mark).toHaveTextContent("✓");
    fireEvent.click(mark);
    await waitFor(() => expect(current.markEpisode).toHaveBeenCalledWith(show, 2, true));
  });

  it.each([
    ["Persona", "shows"],                    // a genuinely different name
    ["Silo (2023)", "hides"],                // same name, trailing year
    ["Silo: Wool", "hides"],                 // same name, extra words
  ])("%s: %s the alias on the show page", (sourceTitle, expected) => {
    const renamed = { ...show, sourceTitle };
    const current = tracker({ domain: { ...domain, shows: [renamed] },
      local: { ...tracker().local!, shows: [renamed], progress: [], settings: domain.settings, history: [] } });
    render(<MemoryRouter initialEntries={["/show/local-1"]}><Routes><Route path="/show/:id" element={<ShowDetail tracker={current}/>}/></Routes></MemoryRouter>);

    if (expected === "shows") expect(screen.getByText(`also known as ${sourceTitle}`)).toBeVisible();
    else expect(screen.queryByText(/also known as/)).not.toBeInTheDocument();
  });

  it("groups episodes, displays original artwork, and protects future episodes from season bulk actions", () => {
    const episodeStill = "https://static.tvmaze.com/freedom-day.jpg";
    const showDomain = { ...domain, episodes: domain.episodes.map((episode) => episode.id === 1 ? { ...episode, image: { medium: episodeStill } } : episode) };
    const current = tracker({ domain: showDomain });
    render(<MemoryRouter initialEntries={["/show/local-1"]}><Routes><Route path="/show/:id" element={<ShowDetail tracker={current}/>}/></Routes></MemoryRouter>);
    expect(screen.getByText("Season 1")).toBeVisible(); expect(screen.getByText("0 / 3 watched")).toBeVisible();
    expect(screen.getByRole("img", { name: "Silo poster" })).toHaveAttribute("src", "https://static.tvmaze.com/original.jpg");
    expect(screen.getByText("TV Time rating")).toBeVisible();
    const episodeLink = screen.getByRole("link", { name: "Open episode details: Freedom Day" });
    const episodeImage = screen.getByRole("img", { name: "Freedom Day episode still" });
    expect(episodeLink).toHaveAttribute("href", "#/show/local-1/episode/1");
    expect(episodeLink).toContainElement(episodeImage);
    expect(episodeLink).not.toContainElement(screen.getByRole("button", { name: "Mark watched: Freedom Day" }));
    fireEvent.click(screen.getByRole("button", { name: /Mark aired season watched/ }));
    expect(current.setEpisodesWatched).toHaveBeenCalledWith(show, [1, 2], true);
    expect(current.setEpisodesWatched).not.toHaveBeenCalledWith(show, expect.arrayContaining([3]), true);
  });
});
