import { describe, expect, it } from "vitest";
import type { ProviderEpisode, ProviderStatus } from "../../src/domain/models";
import {
  applyActiveProgressChoice,
  applyFinishedMixture,
  applyFinishedWatchedEverything,
  classifyOnboardingShow,
  type OnboardingShow,
} from "../../src/imports/onboarding";

const timing = {
  importInstant: new Date("2025-01-15T12:00:00Z"),
  timezone: "UTC",
  dateOnlyReleaseHour: "09:00",
};

function episode(
  id: number,
  season: number,
  number: number,
  values: Partial<ProviderEpisode> = {},
): ProviderEpisode {
  return {
    id,
    showId: 100,
    season,
    number,
    kind: "regular",
    airstamp: `2025-01-${String(number).padStart(2, "0")}T10:00:00Z`,
    ...values,
  };
}

function show(
  id: string,
  providerStatus: ProviderStatus = "running",
  episodes: ProviderEpisode[] = [episode(1, 1, 1), episode(2, 1, 2)],
): OnboardingShow {
  return { id, providerStatus, episodes };
}

describe("onboarding classification", () => {
  it("classifies only ended shows with known, already available regular episodes as finished", () => {
    expect(classifyOnboardingShow(show("ended", "ended"), timing)).toBe("finished");
    expect(classifyOnboardingShow(show("running"), timing)).toBe("active_or_uncertain");
    expect(classifyOnboardingShow(show("future", "ended", [
      episode(1, 1, 1),
      episode(2, 1, 2, { airstamp: "2025-02-01T10:00:00Z" }),
    ]), timing)).toBe("active_or_uncertain");
    expect(classifyOnboardingShow(show("unknown", "ended", [{
      id: 1,
      showId: 100,
      season: 1,
      number: 1,
      kind: "regular",
    }]), timing)).toBe("active_or_uncertain");
    expect(classifyOnboardingShow(show("empty", "ended", []), timing)).toBe("active_or_uncertain");
  });

  it("ignores specials when classifying a finished show", () => {
    expect(classifyOnboardingShow(show("special", "ended", [
      episode(1, 1, 1),
      episode(99, 0, 1, { kind: "special", airstamp: "2099-01-01T00:00:00Z" }),
    ]), timing)).toBe("finished");
  });
});

describe("finished-show onboarding", () => {
  it("marks watched-everything through the import instant without future episodes or specials", () => {
    const result = applyFinishedWatchedEverything(show("finished", "ended", [
      episode(2, 1, 2),
      episode(1, 1, 1),
      episode(99, 0, 1, { kind: "special" }),
    ]), timing);

    expect(result.userState).toBe("completed");
    expect(result.episodeDecisions).toEqual([
      { tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true },
      { tvmazeEpisodeId: 2, season: 1, episode: 2, watched: true },
    ]);
  });

  it("applies mixture selections as not started and catches up unselected shows", () => {
    const results = applyFinishedMixture(
      [show("unselected", "ended"), show("selected", "ended")],
      ["selected"],
      timing,
    );

    expect(results.map((result) => result.userState)).toEqual(["completed", "not_started"]);
    expect(results[0]?.episodeDecisions.every((item) => item.watched)).toBe(true);
    expect(results[1]?.episodeDecisions.every((item) => !item.watched)).toBe(true);
  });

  it("rejects bulk finished assumptions for an active show", () => {
    expect(() => applyFinishedWatchedEverything(show("active"), timing))
      .toThrow("not confidently finished");
  });
});

describe("active-show onboarding", () => {
  const active = show("active", "running", [
    episode(3, 1, 3),
    episode(1, 1, 1),
    episode(2, 1, 2),
    episode(4, 1, 4, { airstamp: "2025-02-01T10:00:00Z" }),
    episode(99, 0, 1, { kind: "special" }),
  ]);

  it("supports caught-up and not-started actions using available regular episodes only", () => {
    const caughtUp = applyActiveProgressChoice(active, { kind: "caught_up" }, timing);
    const notStarted = applyActiveProgressChoice(active, { kind: "not_started" }, timing);

    expect(caughtUp.userState).toBe("caught_up");
    expect(caughtUp.episodeDecisions.map((item) => item.tvmazeEpisodeId)).toEqual([1, 2, 3]);
    expect(caughtUp.episodeDecisions.every((item) => item.watched)).toBe(true);
    expect(notStarted.userState).toBe("not_started");
    expect(notStarted.episodeDecisions.map((item) => item.tvmazeEpisodeId)).toEqual([1, 2, 3]);
    expect(notStarted.episodeDecisions.every((item) => !item.watched)).toBe(true);
  });

  it("marks every available regular episode through the chosen last watched episode", () => {
    const result = applyActiveProgressChoice(
      active,
      { kind: "last_watched", tvmazeEpisodeId: 2 },
      timing,
    );

    expect(result.userState).toBe("watching");
    expect(result.episodeDecisions.map(({ watched }) => watched)).toEqual([true, true, false]);
  });

  it("rejects a future or special last-watched episode", () => {
    expect(() => applyActiveProgressChoice(
      active,
      { kind: "last_watched", tvmazeEpisodeId: 4 },
      timing,
    )).toThrow("available regular episode");
    expect(() => applyActiveProgressChoice(
      active,
      { kind: "last_watched", tvmazeEpisodeId: 99 },
      timing,
    )).toThrow("available regular episode");
  });

  it("supports manual gaps and derives a conservative progress state", () => {
    const gap = applyActiveProgressChoice(
      active,
      { kind: "manual", watchedTvmazeEpisodeIds: [1, 3, 4, 99] },
      timing,
    );
    const none = applyActiveProgressChoice(
      active,
      { kind: "manual", watchedTvmazeEpisodeIds: [] },
      timing,
    );

    expect(gap.userState).toBe("watching");
    expect(gap.episodeDecisions).toEqual([
      { tvmazeEpisodeId: 1, season: 1, episode: 1, watched: true },
      { tvmazeEpisodeId: 2, season: 1, episode: 2, watched: false },
      { tvmazeEpisodeId: 3, season: 1, episode: 3, watched: true },
    ]);
    expect(none.userState).toBe("not_started");
  });
});
