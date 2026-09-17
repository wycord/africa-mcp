/**
 * Source state store — tracks last-known-good values, last successful fetch, and
 * DocsStatus per source. This is what makes the lane degrade instead of crash: on a fetch
 * failure the provider serves the cached value with stale: true, and get_rate_status
 * reports BROKEN/UNAVAILABLE per the spec's DocsStatus semantics.
 *
 * In-memory for v1 (a file-backed store can implement the same surface later without any
 * tool changes — the tools only read the snapshot fields).
 */
import type { DocsStatus, OfficialRate, ParallelRate } from "@braynexservices/africa-mcp-core";

export interface SourceState {
  status: DocsStatus;
  /** Last-known-good official rate served by this source, if any. */
  lastGoodOfficial?: OfficialRate;
  /** Last-known-good parallel rate served by this source, if any. */
  lastGoodParallel?: ParallelRate;
  /** ISO timestamp of the last successful fetch (any kind). */
  lastSuccessfulFetch?: string;
  /** Consecutive failed fetch days — 3 triggers automatic fallback promotion. */
  consecutiveFailures: number;
}

/** Rolling window the spread-anomaly baseline is computed over (spec section 4: 30 days). */
export const SPREAD_WINDOW_DAYS = 30;

/**
 * Minimum day-observations before a median counts as a baseline. Below this the
 * spread-anomaly check abstains rather than judging today against a handful of points.
 */
export const MIN_SPREAD_SAMPLES = 7;

export class SourceStateStore {
  private readonly store = new Map<string, SourceState>();
  /** currency -> date -> observed official-vs-parallel spread %, capped at the window. */
  private readonly spreads = new Map<string, Map<string, number>>();

  /** Read a source's state WITHOUT creating it — separates "never fetched" from "LIVE". */
  peek(sourceId: string): SourceState | undefined {
    return this.store.get(sourceId);
  }

  get(sourceId: string): SourceState {
    let s = this.store.get(sourceId);
    if (!s) {
      s = { status: "LIVE", consecutiveFailures: 0 };
      this.store.set(sourceId, s);
    }
    return s;
  }

  /**
   * Record one day's observed spread for a currency. Keyed by date, so repeated calls on the
   * same day overwrite instead of stacking — otherwise a chatty caller could flood the
   * window with one day's value and drag the median onto it.
   */
  recordSpread(currency: string, date: string, pct: number): void {
    if (!Number.isFinite(pct)) return;
    let series = this.spreads.get(currency);
    if (!series) {
      series = new Map();
      this.spreads.set(currency, series);
    }
    series.set(date, pct);
    if (series.size > SPREAD_WINDOW_DAYS) {
      const kept = new Set([...series.keys()].sort().slice(-SPREAD_WINDOW_DAYS));
      for (const d of [...series.keys()]) if (!kept.has(d)) series.delete(d);
    }
  }

  /** Observed spreads for a currency, within the retained window. */
  spreadObservations(currency: string): number[] {
    return [...(this.spreads.get(currency)?.values() ?? [])];
  }

  markSuccess(sourceId: string): SourceState {
    const s = this.get(sourceId);
    s.status = "LIVE";
    s.consecutiveFailures = 0;
    s.lastSuccessfulFetch = new Date().toISOString();
    return s;
  }

  markBroken(sourceId: string): SourceState {
    const s = this.get(sourceId);
    // 403/404/5xx-type failures: the fetch itself ran but the source failed us.
    s.status = "BROKEN";
    s.consecutiveFailures += 1;
    return s;
  }

  markUnavailable(sourceId: string): SourceState {
    const s = this.get(sourceId);
    // Gated/unreachable: network-level failures.
    s.status = "UNAVAILABLE";
    s.consecutiveFailures += 1;
    return s;
  }

  recordOfficial(sourceId: string, rate: OfficialRate): void {
    const s = this.markSuccess(sourceId);
    s.lastGoodOfficial = rate;
  }

  recordParallel(sourceId: string, rate: ParallelRate): void {
    const s = this.markSuccess(sourceId);
    s.lastGoodParallel = rate;
  }

  /** Automatic fallback promotion check (spec section 5): 3 consecutive failures flips primary to fallback. */
  shouldPromoteFallback(sourceId: string): boolean {
    return this.get(sourceId).consecutiveFailures >= 3;
  }

  all(): Map<string, SourceState> {
    return this.store;
  }
}