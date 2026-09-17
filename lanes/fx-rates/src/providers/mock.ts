/**
 * Mock FX provider — the default. Serves deterministic fixtures for all 7 v1 currencies
 * (official) and Nigeria (parallel) so the lane runs with zero signup and zero network.
 * Implements the core FxProvider interface; swap via FX_PROVIDER env.
 *
 * It runs the SAME reconciliation functions as the live provider rather than re-deriving
 * the thresholds inline, so the mock cannot drift away from the logic it is standing in for.
 */
import type {
  FxProvider,
  CurrencyCoverage,
  RateHistoryPoint,
  RateSnapshot,
  ReconcileResult,
  SourceStatus,
} from "@braynexservices/africa-mcp-core";
import { BANKS, bankFor } from "../currencies.js";
import {
  OFFICIAL_FIXTURES,
  PARALLEL_FIXTURES,
  MOCK_CROSS_CHECK_SOURCE,
  crossCheckFixture,
  officialHistory,
  parallelHistory,
  FIXTURE_DATE,
} from "../fixtures.js";
import {
  checkDiscrepancy,
  checkSpreadAnomaly,
  mergeFlags,
  spreadBaselineFrom,
  spreadPct,
} from "../reconcile.js";

const MOCK_SOURCE = "mock";

/** Resolve a country to its bank, rejecting anything outside the registry. */
function requireBank(country: string) {
  const bank = bankFor(country);
  if (!bank) {
    throw new Error(`Unknown country "${country}". Supported: ${BANKS.map((b) => b.country).join(", ")}.`);
  }
  return bank;
}

/**
 * The currency argument must name the country's own currency. Silently ignoring a mismatch
 * would let get_rate_history("NG", "KES", ...) return NGN data labelled KES.
 */
function requireCurrencyMatch(country: string, currency: string): void {
  const bank = requireBank(country);
  const given = currency.trim().toUpperCase();
  if (given && given !== bank.currency) {
    throw new Error(`${bank.country}'s currency is ${bank.currency}, not ${given}.`);
  }
}

export class MockFxProvider implements FxProvider {
  readonly name = "mock";

  async listCurrencies(): Promise<CurrencyCoverage[]> {
    return BANKS.map((b) => ({
      country: b.country,
      iso_code: b.currency,
      bank: b.bank,
      coverage: b.coverage,
      official_available: b.officialAvailable,
      parallel_available: b.parallelAvailable,
    }));
  }

  async getOfficialRate(country: string, quoteCurrency = "USD"): Promise<RateSnapshot> {
    const c = country.trim().toUpperCase();
    const fx = OFFICIAL_FIXTURES.find((f) => f.country === c && f.quote === quoteCurrency.toUpperCase());
    if (!fx) {
      throw new Error(
        `No official rate for ${c}/${quoteCurrency}. Covered: ${OFFICIAL_FIXTURES.map((f) => f.country).join(", ")} (USD quotes).`,
      );
    }
    return {
      rate: fx.rate,
      source: MOCK_SOURCE,
      as_of: fx.asOf,
      fetched_at: `${fx.asOf}T09:00:00.000Z`,
      stale: false,
    };
  }

  async getParallelRate(
    country: string,
    quoteCurrency = "USD",
  ): Promise<RateSnapshot | { available: false; reason: "no_parallel_source" }> {
    const c = country.trim().toUpperCase();
    const fx = PARALLEL_FIXTURES.find((f) => f.country === c && f.quote === quoteCurrency.toUpperCase());
    if (!fx) return { available: false, reason: "no_parallel_source" };
    return {
      rate: fx.rate,
      source: MOCK_SOURCE,
      as_of: fx.asOf,
      fetched_at: `${fx.asOf}T10:30:00.000Z`,
      stale: false,
    };
  }

  async getRateHistory(
    country: string,
    currency: string,
    rateType: "official" | "parallel",
    startDate: string,
    endDate: string,
  ): Promise<RateHistoryPoint[]> {
    const bank = requireBank(country);
    requireCurrencyMatch(bank.country, currency);
    // parallelHistory() is empty where no parallel market is covered, so a parallel request
    // for such a country returns nothing rather than official data wearing a parallel label.
    const series = rateType === "parallel" ? parallelHistory(bank.country) : officialHistory(bank.country);
    return series
      .filter((p) => p.asOf >= startDate && p.asOf <= endDate)
      .map((p) => ({ date: p.asOf, rate: p.rate, source: MOCK_SOURCE }));
  }

  async reconcileRate(country: string, currency: string): Promise<ReconcileResult> {
    const bank = requireBank(country);
    requireCurrencyMatch(bank.country, currency);

    const official = await this.getOfficialRate(bank.country, "USD");
    const officialRows = [{ source: official.source, rate: official.rate, as_of: official.as_of }];

    // Second opinion from its own fixture table — an independent value, not a transform of
    // the primary, so the discrepancy check is exercised rather than short-circuited.
    const cross = crossCheckFixture(bank.country);
    if (cross) {
      officialRows.push({ source: MOCK_CROSS_CHECK_SOURCE, rate: cross.rate, as_of: cross.asOf });
    }

    const parallel = await this.getParallelRate(bank.country, "USD");
    const parallelRows =
      "rate" in parallel ? [{ source: parallel.source, rate: parallel.rate, as_of: parallel.as_of }] : [];
    const parallelRate = parallelRows.length > 0 ? parallelRows[0].rate : null;

    const discrepancy = checkDiscrepancy(
      bank.currency,
      { source: official.source, rate: official.rate },
      cross ? { source: MOCK_CROSS_CHECK_SOURCE, rate: cross.rate } : null,
    );

    // Real rolling median over the 30 fixture days, day-matched — not a hardcoded constant.
    const baseline = spreadBaselineFrom(
      officialHistory(bank.country).map((p) => ({ date: p.asOf, rate: p.rate, source: MOCK_SOURCE })),
      parallelHistory(bank.country).map((p) => ({ date: p.asOf, rate: p.rate, source: MOCK_SOURCE })),
    );
    const anomaly = checkSpreadAnomaly(official.rate, parallelRate, baseline);

    const flags = mergeFlags(discrepancy, anomaly);
    return {
      official: officialRows,
      parallel: parallelRows,
      spread_pct: spreadPct(official.rate, parallelRate),
      discrepancy_flag: flags.discrepancy_flag,
      discrepancy_reason: flags.discrepancy_reason,
    };
  }

  async getRateStatus(country?: string): Promise<SourceStatus[]> {
    const banks = country ? BANKS.filter((b) => b.country === country.trim().toUpperCase()) : BANKS;
    return banks
      .filter((b) => b.officialAvailable || b.parallelAvailable)
      .map((b) => ({
        source: b.country === "NG" ? "mock (CBN + Quidax)" : `mock (${b.bank.split(" (")[0]})`,
        docs_status: "LIVE" as const,
        last_successful_fetch: `${FIXTURE_DATE}T09:00:00.000Z`,
        // Fixed, not computed from the clock: a mock whose output drifts with wall time
        // cannot be asserted against.
        age_hours: 24,
        stale_threshold_hours: 48,
      }));
  }
}
