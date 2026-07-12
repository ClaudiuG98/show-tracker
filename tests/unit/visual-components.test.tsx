import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainState } from "../../src/domain/selectors";
import { Library, ShowDetail, Upcoming, WatchList } from "../../src/ui/App";
import { Poster } from "../../src/ui/components/Poster";
import type { useTracker } from "../../src/ui/useTracker";

afterEach(cleanup);

const show = { id: "local-1", externalIds: { imdb: "tt1", tvmazeShow: 10 }, titleSnapshot: "Silo", userState: "watching" as const,
  importSources: ["manual" as const], createdAt: "2024-01-01", updatedAt: "2024-01-01" };
const domain: DomainState = {
  settings: { timezone: "UTC", dateOnlyReleaseHour: "09:00" }, shows: [show], progress: [],
  providerShows: [{ provider: "tvmaze", id: 10, name: "Silo", status: "running", externalIds: { tvmazeShow: 10 },
    image: { medium: "https://static.tvmaze.com/medium.jpg", original: "https://static.tvmaze.com/original.jpg" }, updatedAt: 1 }],
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
  it("renders the Watch List poster, backlog count, and advances optimistically", () => {
    let resolve!: () => void; const markEpisode = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(<MemoryRouter><WatchList tracker={tracker({ markEpisode })}/></MemoryRouter>);
    expect(screen.getByText("+1 more")).toBeVisible(); expect(screen.getByRole("img", { name: "Silo poster" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Mark Freedom Day watched/ }));
    expect(screen.queryByText("Freedom Day")).not.toBeInTheDocument(); resolve();
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
});

describe("show seasons", () => {
  it("groups episodes, displays original artwork, and protects future episodes from season bulk actions", () => {
    const current = tracker();
    render(<MemoryRouter initialEntries={["/show/local-1"]}><Routes><Route path="/show/:id" element={<ShowDetail tracker={current}/>}/></Routes></MemoryRouter>);
    expect(screen.getByText("Season 1")).toBeVisible(); expect(screen.getByText("0 / 3 watched")).toBeVisible();
    expect(screen.getByRole("img", { name: "Silo poster" })).toHaveAttribute("src", "https://static.tvmaze.com/original.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Mark aired season watched" }));
    expect(current.setEpisodesWatched).toHaveBeenCalledWith(show, [1, 2], true);
    expect(current.setEpisodesWatched).not.toHaveBeenCalledWith(show, expect.arrayContaining([3]), true);
  });
});
