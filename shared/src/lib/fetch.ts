/**
 * Shared fetch-with-retry used by every live adapter. Applies a per-attempt timeout and
 * backoff-retry (jittered, capped at 3 retries) on TRANSIENT failures — network/timeout
 * rejections, HTTP 429, and 5xx.
 *
 * Non-retryable responses are returned to the caller as { res, body } so each adapter keeps
 * its own status/body policy — e.g. treat 403/404 as a broken source, or trust a provider's
 * JSON envelope on a benign 4xx. Throws a ToolError only when all attempts are exhausted.
 *
 * Live scrapers are polite: a custom Wycord User-Agent with a contact address is applied
 * unless the caller overrides it. robots.txt compliance is each adapter's responsibility.
 */
import { ToolError } from "./errors.js";

export interface FetchJsonOptions {
  /** Human label for error messages, e.g. "BNR". */
  service: string;
  /** Actionable tail appended to transient hints, e.g. "set FX_PROVIDER=mock". */
  fallbackHint: string;
  /** Per-attempt timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Backoff (ms) before each attempt; first entry is usually 0. Default [0, 600, 1500] (3 retries). */
  backoffsMs?: number[];
  /** Hard cap on the response body we will buffer, in bytes. Default 8 MiB. */
  maxBytes?: number;
}

export interface FetchJsonResult {
  res: Response;
  /** Parsed JSON body, or null if the response was not valid JSON or exceeded maxBytes. */
  body: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — every source we hit returns far less.

export const WYCORD_USER_AGENT =
  "africa-mcp/0.1 (+https://github.com/wycord/africa-mcp; contact: braynexservices@gmail.com)";

/**
 * Read a response body with a hard byte ceiling so a compromised/misbehaving upstream can't
 * exhaust memory. Returns the decoded text, or null if the body is absent or exceeds the
 * cap — the caller then treats null as an unparseable body, i.e. fails closed rather than
 * trusting a truncated payload.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null; // reject early when advertised
  if (!res.body) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  opts: FetchJsonOptions,
): Promise<FetchJsonResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffs = opts.backoffsMs ?? [0, 600, 1500];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const headers = new Headers(init.headers);
  if (!headers.has("user-agent") && !headers.has("User-Agent")) {
    headers.set("User-Agent", WYCORD_USER_AGENT);
  }
  const mergedInit: RequestInit = { ...init, headers };

  let lastError: ToolError | null = null;
  for (const backoff of backoffs) {
    // Jitter so many clients retrying the same source don't synchronize.
    if (backoff) await sleep(backoff + Math.floor(Math.random() * 250));
    let res: Response;
    try {
      res = await fetch(url, { ...mergedInit, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // Timeout / DNS / connection reset — a transient we should retry, not leak raw.
      lastError = new SourceUnreachableError(opts.service, opts.fallbackHint);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new SourceUnavailableError(res.status, opts.service, opts.fallbackHint);
      continue;
    }
    const text = await readCapped(res, maxBytes).catch(() => null);
    let body: unknown = null;
    if (text !== null && text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { res, body };
  }
  throw (
    lastError ??
    new ToolError(
      `${opts.service} request failed after retries.`,
      `Try again shortly, or ${opts.fallbackHint}.`,
    )
  );
}

/**
 * Upstream answered with a failure status (403/404, or 429/5xx after retries). Under the
 * registry's DocsStatus semantics this is BROKEN: the host is reachable, its rate endpoint
 * is not serving us.
 */
export class SourceUnavailableError extends ToolError {
  constructor(
    public readonly status: number,
    service: string,
    fallbackHint: string,
  ) {
    super(
      `${service} is unavailable (HTTP ${status}).`,
      `The source may be gated, moved, or down; or ${fallbackHint}.`,
    );
    this.name = "SourceUnavailableError";
  }
}

/**
 * Upstream never answered — DNS failure, connection reset or timeout, after all retries.
 * Under DocsStatus semantics this is UNAVAILABLE (unreachable), which is a different
 * operational fact from BROKEN (reachable but failing). Callers map the two to different
 * docs_status values, so the two error types must stay separable.
 */
export class SourceUnreachableError extends ToolError {
  constructor(service: string, fallbackHint: string) {
    super(
      `${service} did not respond (network error or timeout).`,
      `Retried; try again shortly, or ${fallbackHint}.`,
    );
    this.name = "SourceUnreachableError";
  }
}

export async function fetchText(
  url: string,
  opts: FetchJsonOptions & { init?: RequestInit } = {} as FetchJsonOptions & { init?: RequestInit },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffs = opts.backoffsMs ?? [0, 600, 1500];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let lastError: ToolError | null = null;
  for (const backoff of backoffs) {
    if (backoff) await sleep(backoff + Math.floor(Math.random() * 250));
    let res: Response;
    try {
      res = await fetch(url, {
        ...opts.init,
        headers: { "User-Agent": WYCORD_USER_AGENT, ...(opts.init?.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      lastError = new SourceUnreachableError(opts.service, opts.fallbackHint);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new SourceUnavailableError(res.status, opts.service, opts.fallbackHint);
      continue;
    }
    if (!res.ok) {
      // Any other non-2xx (403/404/moved/etc.): the host answered, the endpoint failed us.
      throw new SourceUnavailableError(res.status, opts.service, opts.fallbackHint);
    }
    const text = await readCapped(res, maxBytes).catch(() => null);
    if (text === null) {
      lastError = new ToolError(
        `${opts.service} returned an unparseable or oversized body.`,
        `Try again shortly, or ${opts.fallbackHint}.`,
      );
      continue;
    }
    return text;
  }
  throw (
    lastError ??
    new ToolError(
      `${opts.service} request failed after retries.`,
      `Try again shortly, or ${opts.fallbackHint}.`,
    )
  );
}