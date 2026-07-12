import { describe, expect, it } from "vitest";
import { getEpisodeAvailability } from "../../src/domain/availability";
import type { ProviderEpisode } from "../../src/domain/models";
const episode = (values: Partial<ProviderEpisode> = {}): ProviderEpisode => ({ id: 1, showId: 1, season: 1, number: 1, kind: "regular", ...values });
describe("episode availability", () => {
  it("prefers an exact airstamp", () => expect(getEpisodeAvailability(episode({ airdate:"2099-01-01",airstamp:"2025-01-01T10:00:00Z"}),new Date("2025-01-01T10:00:00Z"),"Europe/Bucharest","09:00")).toBe("available"));
  it("uses the configured local hour for a date", () => {
    expect(getEpisodeAvailability(episode({airdate:"2025-01-15"}),new Date("2025-01-15T06:59:59Z"),"Europe/Bucharest","09:00")).toBe("future");
    expect(getEpisodeAvailability(episode({airdate:"2025-01-15"}),new Date("2025-01-15T07:00:00Z"),"Europe/Bucharest","09:00")).toBe("available");
  });
  it("keeps missing schedules unknown", () => expect(getEpisodeAvailability(episode(),new Date(),"UTC","09:00")).toBe("unknown"));
});
