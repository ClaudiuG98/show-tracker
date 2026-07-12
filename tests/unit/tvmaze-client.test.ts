import { describe, expect, it, vi } from "vitest";
import { createTvMazeRequest, TvMazeRequestError, type TvMazeFetch } from "../../src/providers/tvmaze/client";

function response(status: number, value: unknown, headers: Record<string, string> = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, headerValue]) => [key.toLowerCase(), headerValue]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => normalized.get(name.toLowerCase()) ?? null },
    json: async () => value,
  } as unknown as Response;
}

describe("TVMaze request client", () => {
  it("releases concurrency slots before retrying simultaneous rate limits", async () => {
    const attempts = new Map<string, number>();
    const fetchFn = vi.fn(async (url: string) => {
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);
      return attempt === 1
        ? response(429, null, { "Retry-After": "0" })
        : response(200, { url });
    }) as TvMazeFetch;
    const sleep = vi.fn(async () => undefined);
    const request = createTvMazeRequest({
      fetchFn,
      sleep,
      maxAttempts: 2,
      maxConcurrency: 4,
      minStartIntervalMs: 0,
      random: () => 0,
    });

    const paths = ["/one", "/two", "/three", "/four"];
    const values = await Promise.all(paths.map((path) => request(path)));

    expect(values).toEqual(paths.map((path) => ({ url: `https://api.tvmaze.com${path}` })));
    expect(fetchFn).toHaveBeenCalledTimes(8);
    expect([...attempts.values()]).toEqual([2, 2, 2, 2]);
  });

  it("exposes an exhausted 429 as a typed rate-limit error", async () => {
    const request = createTvMazeRequest({
      fetchFn: vi.fn(async () => response(429, null, { "Retry-After": "0" })) as TvMazeFetch,
      sleep: async () => undefined,
      maxAttempts: 2,
      minStartIntervalMs: 0,
      random: () => 0,
    });

    const error = await request("/limited").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TvMazeRequestError);
    expect(error).toMatchObject({ kind: "rate_limit", status: 429, attempts: 2 });
  });

  it("honors an HTTP-date Retry-After value", async () => {
    const now = Date.parse("2026-07-12T10:00:00Z");
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response(503, null, { "Retry-After": "Sun, 12 Jul 2026 10:00:05 GMT" }))
      .mockResolvedValueOnce(response(200, { ok: true })) as TvMazeFetch;
    const sleep = vi.fn(async () => undefined);
    const request = createTvMazeRequest({
      fetchFn,
      sleep,
      now: () => now,
      maxAttempts: 2,
      minStartIntervalMs: 0,
      random: () => 0,
    });

    await expect(request("/temporarily-unavailable")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("exposes an exhausted fetch failure as a typed network error", async () => {
    const request = createTvMazeRequest({
      fetchFn: vi.fn(async () => { throw new TypeError("offline"); }) as TvMazeFetch,
      sleep: async () => undefined,
      maxAttempts: 2,
      minStartIntervalMs: 0,
      random: () => 0,
    });

    await expect(request("/offline")).rejects.toMatchObject({
      name: "TvMazeRequestError",
      kind: "network",
      status: undefined,
      attempts: 2,
    });
  });
});
