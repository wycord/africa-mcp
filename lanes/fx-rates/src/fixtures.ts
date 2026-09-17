/**
 * Mock FX fixtures — deterministic rates so the lane (and smoke tests) run with zero signup
 * and zero network. NOT live rates: do not quote these as real.
 *
 * Each entry means 1 {quote} = {rate} {currency} (how many local units buy 1 USD).
 * Parallel values sit above official where a parallel market exists (NG only in v1),
 * reflecting the historical premium. Historical points are spread across dates so the
 * spread-anomaly rolling median has real day-matched data to work from.
 *
 * Determinism is a hard requirement here: nothing in this file may read Date.now() or
 * Math.random(), or the smoke test's assertions stop meaning anything.
 */

export interface FixtureRate {
  country: string;
  currency: string;
  quote: string;
  rate: number;
  market: "official" | "parallel";
  /** Publication date (YYYY-MM-DD) the rate is "as of". */
  asOf: string;
}

/** Deterministic "today" for fixtures — a fixed date keeps snapshot fields reproducible. */
export const FIXTURE_DATE = "2026-09-16";

export const OFFICIAL_FIXTURES: FixtureRate[] = [
  { country: "NG", currency: "NGN", quote: "USD", rate: 1550.0, market: "official", asOf: FIXTURE_DATE },
  { country: "GH", currency: "GHS", quote: "USD", rate: 15.8, market: "official", asOf: FIXTURE_DATE },
  { country: "KE", currency: "KES", quote: "USD", rate: 128.5, market: "official", asOf: FIXTURE_DATE },
  { country: "ZA", currency: "ZAR", quote: "USD", rate: 17.6, market: "official", asOf: FIXTURE_DATE },
  { country: "TZ", currency: "TZS", quote: "USD", rate: 2650.0, market: "official", asOf: FIXTURE_DATE },
  { country: "RW", currency: "RWF", quote: "USD", rate: 1380.0, market: "official", asOf: FIXTURE_DATE },
  { country: "EG", currency: "EGP", quote: "USD", rate: 48.2, market: "official", asOf: FIXTURE_DATE },
];

export const PARALLEL_FIXTURES: FixtureRate[] = [
  { country: "NG", currency: "NGN", quote: "USD", rate: 1610.0, market: "parallel", asOf: FIXTURE_DATE },
];

/**
 * Independent second-opinion fixtures, standing in for the live cross-check sources
 * (Frankfurter / OpenDataForAfrica).
 *
 * These are a SEPARATE table on purpose. Deriving the cross-check arithmetically from the
 * official fixture (official * 1.002) would make reconcile_rate compare one number against
 * a transform of itself, so the discrepancy check could never fail for a reason that the
 * transform did not put there — it would test multiplication, not reconciliation.
 *
 * EG deviates ~2.5% deliberately, exercising the discrepancy flag offline; every other
 * currency sits inside the 1% threshold.
 */
export const CROSS_CHECK_FIXTURES: FixtureRate[] = [
  { country: "NG", currency: "NGN", quote: "USD", rate: 1553.1, market: "official", asOf: FIXTURE_DATE },
  { country: "GH", currency: "GHS", quote: "USD", rate: 15.87, market: "official", asOf: FIXTURE_DATE },
  { country: "KE", currency: "KES", quote: "USD", rate: 128.94, market: "official", asOf: FIXTURE_DATE },
  { country: "ZA", currency: "ZAR", quote: "USD", rate: 17.52, market: "official", asOf: FIXTURE_DATE },
  { country: "TZ", currency: "TZS", quote: "USD", rate: 2661.0, market: "official", asOf: FIXTURE_DATE },
  { country: "RW", currency: "RWF", quote: "USD", rate: 1385.5, market: "official", asOf: FIXTURE_DATE },
  // Deliberate outlier: 49.41 vs 48.20 is +2.51%, above the 1% threshold.
  { country: "EG", currency: "EGP", quote: "USD", rate: 49.41, market: "official", asOf: FIXTURE_DATE },
];

/** The mock's label for its independent cross-check leg. */
export const MOCK_CROSS_CHECK_SOURCE = "mock-cross-check";

export function officialFixture(country: string): FixtureRate | undefined {
  return OFFICIAL_FIXTURES.find((f) => f.country === country);
}

export function crossCheckFixture(country: string): FixtureRate | undefined {
  return CROSS_CHECK_FIXTURES.find((f) => f.country === country);
}

/**
 * 30 days of official USD history for a covered country (deterministic drift within ~1% of
 * the current fixture). Returns [] for a country with no official fixture — inventing a
 * series for an uncovered country would fabricate market data.
 */
export function officialHistory(country: string): FixtureRate[] {
  const fixture = officialFixture(country);
  if (!fixture) return [];
  const out: FixtureRate[] = [];
  const end = Date.parse(`${FIXTURE_DATE}T00:00:00Z`);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    // Deterministic pseudo-drift in [-1%, +1%] of base, ending exactly at base on day 0.
    const drift = Math.sin(i / 4) * 0.005 + Math.cos(i / 9) * 0.004;
    out.push({
      country,
      currency: fixture.currency,
      quote: "USD",
      rate: Number((fixture.rate * (1 + drift)).toFixed(4)),
      market: "official",
      asOf: d,
    });
  }
  return out;
}

/**
 * 30 days of parallel history, tracking a steady premium over official — the baseline the
 * spread-anomaly median is computed from. Returns [] where no parallel market is covered,
 * so a country without a parallel source can never be handed a fabricated parallel series.
 */
export function parallelHistory(country: string): FixtureRate[] {
  const hasParallel = PARALLEL_FIXTURES.some((f) => f.country === country);
  if (!hasParallel) return [];
  return officialHistory(country).map((p) => ({
    ...p,
    market: "parallel" as const,
    rate: Number((p.rate * 1.039).toFixed(4)),
  }));
}
