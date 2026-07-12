const API = "https://api.tvmaze.com";

export type TvMazeRequestErrorKind =
  | "rate_limit"
  | "network"
  | "server"
  | "http"
  | "invalid_response";

export class TvMazeRequestError extends Error {
  readonly name = "TvMazeRequestError";

  constructor(
    message: string,
    readonly kind: TvMazeRequestErrorKind,
    readonly status: number | undefined,
    readonly attempts: number,
    cause?: unknown,
  ) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

export type TvMazeRequest = (path: string) => Promise<unknown | null>;
export type TvMazeFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface TvMazeClientOptions {
  apiBaseUrl?: string;
  fetchFn?: TvMazeFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  maxConcurrency?: number;
  minStartIntervalMs?: number;
}

function retryAfterMilliseconds(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const instant = Date.parse(value);
  return Number.isNaN(instant) ? undefined : Math.max(0, instant - now);
}

export function createTvMazeRequest(options: TvMazeClientOptions = {}): TvMazeRequest {
  const apiBaseUrl = (options.apiBaseUrl ?? API).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
  const minStartIntervalMs = Math.max(0, options.minStartIntervalMs ?? 500);

  const inflight = new Map<string, Promise<unknown | null>>();
  const waiters: Array<() => void> = [];
  let nextStart = 0;
  let active = 0;

  async function acquire() {
    if (active >= maxConcurrency) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    const current = now();
    const wait = Math.max(0, nextStart - current);
    nextStart = Math.max(nextStart, current) + minStartIntervalMs;
    if (wait > 0) await sleep(wait);
  }

  function release() {
    active--;
    waiters.shift()?.();
  }

  async function fetchWithSlot(path: string) {
    await acquire();
    try {
      return await fetchFn(`${apiBaseUrl}${path}`, { headers: { Accept: "application/json" } });
    } finally {
      release();
    }
  }

  const fallbackDelay = (attempt: number) => 2 ** attempt * 1_000 + random() * 250;

  async function request(path: string): Promise<unknown | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetchWithSlot(path);
      } catch (cause) {
        if (attempt < maxAttempts) {
          await sleep(fallbackDelay(attempt));
          continue;
        }
        throw new TvMazeRequestError(
          `TVMaze network request failed after ${attempt} attempts.`,
          "network",
          undefined,
          attempt,
          cause,
        );
      }

      if (response.status === 404) return null;

      if (response.status === 429) {
        if (attempt === maxAttempts) {
          throw new TvMazeRequestError(
            `TVMaze rate limit reached after ${attempt} attempts.`,
            "rate_limit",
            response.status,
            attempt,
          );
        }
        await sleep(
          retryAfterMilliseconds(response.headers.get("Retry-After"), now()) ?? fallbackDelay(attempt),
        );
        continue;
      }

      if (response.status >= 500) {
        if (attempt === maxAttempts) {
          throw new TvMazeRequestError(
            `TVMaze server request failed (${response.status}) after ${attempt} attempts.`,
            "server",
            response.status,
            attempt,
          );
        }
        await sleep(
          retryAfterMilliseconds(response.headers.get("Retry-After"), now()) ?? fallbackDelay(attempt),
        );
        continue;
      }

      if (!response.ok) {
        throw new TvMazeRequestError(
          `TVMaze request failed (${response.status}).`,
          "http",
          response.status,
          attempt,
        );
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new TvMazeRequestError(
          "TVMaze returned invalid JSON.",
          "invalid_response",
          response.status,
          attempt,
          cause,
        );
      }
    }

    throw new TvMazeRequestError("TVMaze request failed.", "network", undefined, maxAttempts);
  }

  return (path: string) => {
    const existing = inflight.get(path);
    if (existing) return existing;
    const pending = request(path).finally(() => inflight.delete(path));
    inflight.set(path, pending);
    return pending;
  };
}

export const tvMazeRequest = createTvMazeRequest();
