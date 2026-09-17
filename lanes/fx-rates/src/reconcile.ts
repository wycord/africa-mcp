/**
 * Reconciliation layer (spec section 4) — three independently toggleable checks:
 *   1. Cross-provider discrepancy: direct source vs an independent cross-check, flagged when
 *      the delta exceeds a per-currency threshold (default 1%).
 *   2. Spread anomaly: official-vs-parallel spread vs the rolling 30-day median spread for
 *      that currency; flags ABNORMAL_SPREAD when the spread exceeds 2x that median.
 *   3. Staleness: DocsStatus semantics per source; stale beyond the threshold serves
 *      last-known-good with stale: true rather than erroring.
 *
 * Deterministic arithmetic only — no judgment calls in the logic, mirroring
 * deploy/review-draft.sh. Every function here is total: it either returns a defined answer
 * or declines to answer, and never returns a number derived from a zero/NaN denominator.
 */
import type { RateHistoryPoint, RateSnapshot } from "@braynexservices/africa-mcp-core";
import { DISCREPANCY_THRESHOLD_PCT, SPREAD_ANOMALY_FACTOR } from "./sources/config.js";

export interface SpreadBaseline {
  /** Rolling 30-day median official-vs-parallel spread percentage. */
  medianSpreadPct: number;
  /** How many matched day-pairs the median was computed from — provenance for the flag. */
  sampleSize: number;
}

export interface ReconcileFlags {
  discrepancy_flag: boolean;
  discrepancy_reason: string | null;
}

const NO_FLAG: ReconcileFlags = { discrepancy_flag: false, discrepancy_reason: null };

/**
 * A spread median this close to zero carries no information, so scaling it by the anomaly
 * factor would make the check fire on noise. Below this floor the spread check abstains.
 */
const MIN_MEANINGFUL_MEDIAN_PCT = 0.05;

/** A rate must be a positive finite number to be usable as a denominator or a quote. */
export function isUsableRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Check 1: cross-provider discrepancy. Both rates must be the same quote pair and in the
 * same units (local currency per 1 USD).
 *
 * The delta is relative to `primary` (the direct central-bank source), which is the value
 * the tool actually serves — so "1% off" means 1% off what the caller receives.
 *
 * Declines to flag, rather than guessing, when there is no cross-check or either rate is
 * unusable: a missing second opinion is not evidence of agreement, and callers read
 * discrepancy_flag: false as "checked and consistent" only in combination with the two
 * rows present in ReconcileResult.official.
 */
export function checkDiscrepancy(
  currency: string,
  primary: { source: string; rate: number },
  cross: { source: string; rate: number } | null,
): ReconcileFlags {
  if (!cross) return NO_FLAG;
  if (!isUsableRate(primary.rate) || !isUsableRate(cross.rate)) return NO_FLAG;
  // Guard against comparing a source against itself — that always reads 0% and would
  // report false confidence. Callers must pass two genuinely independent sources.
  if (cross.source === primary.source) return NO_FLAG;

  const threshold = DISCREPANCY_THRESHOLD_PCT[currency] ?? 1.0;
  const deltaPct = (Math.abs(cross.rate - primary.rate) / primary.rate) * 100;
  if (deltaPct > threshold) {
    return {
      discrepancy_flag: true,
      discrepancy_reason: `CROSS_PROVIDER_DISCREPANCY: ${primary.source}=${primary.rate} vs ${cross.source}=${cross.rate} (${deltaPct.toFixed(2)}% > ${threshold}%)`,
    };
  }
  return NO_FLAG;
}

/**
 * Check 2: spread anomaly. Spec: flag when the official-vs-parallel spread "deviates more
 * than 2x the median" — i.e. the current spread exceeds SPREAD_ANOMALY_FACTOR times the
 * rolling 30-day median spread for that currency.
 *
 * Read literally: a median premium of 3.9% flags at a current premium above 7.8%. Comparing
 * |spread - median| against 2x|median| instead would only fire above 3x the median, missing
 * exactly the moderate blow-out this signal exists to catch.
 *
 * Magnitudes are compared, so an inverted spread (parallel below official — itself unusual)
 * is caught by the same rule.
 */
export function checkSpreadAnomaly(
  officialRate: number,
  parallelRate: number | null,
  baseline: SpreadBaseline | null,
): ReconcileFlags {
  if (parallelRate === null || !baseline) return NO_FLAG;
  if (!isUsableRate(officialRate) || !isUsableRate(parallelRate)) return NO_FLAG;
  // No usable baseline: abstain rather than invent a reference point.
  if (!Number.isFinite(baseline.medianSpreadPct) || baseline.sampleSize <= 0) return NO_FLAG;
  if (Math.abs(baseline.medianSpreadPct) < MIN_MEANINGFUL_MEDIAN_PCT) return NO_FLAG;

  const current = ((parallelRate - officialRate) / officialRate) * 100;
  const limit = SPREAD_ANOMALY_FACTOR * Math.abs(baseline.medianSpreadPct);
  if (Math.abs(current) > limit) {
    return {
      discrepancy_flag: true,
      discrepancy_reason: `ABNORMAL_SPREAD: current ${current.toFixed(2)}% vs ${SPREAD_ANOMALY_FACTOR}x the 30-day median ${baseline.medianSpreadPct.toFixed(2)}% (limit ${limit.toFixed(2)}%, n=${baseline.sampleSize})`,
    };
  }
  return NO_FLAG;
}

/** Merge the checks so a second finding is never silently dropped by the first. */
export function mergeFlags(...all: ReconcileFlags[]): ReconcileFlags {
  const reasons = all.filter((f) => f.discrepancy_flag && f.discrepancy_reason).map((f) => f.discrepancy_reason as string);
  if (reasons.length === 0) return NO_FLAG;
  return { discrepancy_flag: true, discrepancy_reason: reasons.join("; ") };
}

/**
 * Official-vs-parallel spread, as a percentage of the official rate. Positive means the
 * parallel market prices the local currency weaker than the official rate.
 *
 * Returns 0 when there is no parallel rate to compare. Callers must read this together with
 * ReconcileResult.parallel — an empty parallel array means "not measured", not "no spread".
 */
export function spreadPct(officialRate: number, parallelRate: number | null): number {
  if (parallelRate === null) return 0;
  if (!isUsableRate(officialRate) || !isUsableRate(parallelRate)) return 0;
  return Number((((parallelRate - officialRate) / officialRate) * 100).toFixed(2));
}

/** Median of a numeric series (used for the 30-day rolling spread baseline). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build the rolling spread baseline from two history series, matching observations by date
 * so each spread comes from one day's official and parallel rate. Unmatched dates are
 * dropped rather than paired with the nearest neighbour — a spread computed across two
 * different days is not a spread.
 *
 * Returns null when no day has both rates, which makes checkSpreadAnomaly abstain.
 */
export function spreadBaselineFrom(
  officialSeries: RateHistoryPoint[],
  parallelSeries: RateHistoryPoint[],
): SpreadBaseline | null {
  const officialByDate = new Map(officialSeries.map((p) => [p.date, p.rate]));
  const spreads: number[] = [];
  for (const p of parallelSeries) {
    const o = officialByDate.get(p.date);
    if (!isUsableRate(o) || !isUsableRate(p.rate)) continue;
    spreads.push(((p.rate - o) / o) * 100);
  }
  const m = median(spreads);
  if (m === null) return null;
  return { medianSpreadPct: m, sampleSize: spreads.length };
}

/**
 * Check 3 (staleness), applied by the live provider when serving snapshots. An unparseable
 * fetched_at counts as stale: an unknown age must never be reported as fresh.
 */
export function snapshotIsStale(s: RateSnapshot, thresholdHours: number): boolean {
  const fetchedAt = Date.parse(s.fetched_at);
  if (!Number.isFinite(fetchedAt)) return true;
  const age = (Date.now() - fetchedAt) / 3_600_000;
  return age > thresholdHours;
}
