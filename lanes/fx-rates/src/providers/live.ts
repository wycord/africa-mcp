/**
 * Live FX provider — composes the per-bank fetchers (sources/fetchers.ts), the cross-check
 * sources, the parallel (Quidax) source, and the reconciliation layer.
 *
 * Degrades, never crashes (spec sections 4 & 5). On a failed fetch, in order:
 *   1. classify the failure (BROKEN = answered but failing, UNAVAILABLE = unreachable);
 *   2. after 3 consecutive failures, promote the independent cross-check to primary;
 *   3. otherwise serve last-known-good with stale: true;
 *   4. only with nothing cached at all does the tool return an error.
 *
 * Step 2 deliberately precedes step 3: once a source has failed three times running, a fresh
 * reading from the secondary beats a days-old cached value from the dead primary.
 *
 * The fetch seam is injectable (LiveFxDeps) so the degradation ladder can be exercised with
 * zero network in the smoke test. Production callers use the default deps.
 */
import {
  type FxProvider,
  type CurrencyCoverage,
  type OfficialRate,
  type ParallelRate,
  type RateHistoryPoint,
  type RateSnapshot,
  type ReconcileResult,
  type SourceStatus,
  type DocsStatus,
  loadConfig,
  fetchJson,
  SourceUnreachableError,
  ToolError,
} from "@braynexservices/africa-mcp-core";
import { BANKS, bankFor, type BankConfig } from "../currencies.js";
import {
  CROSS_CHECKS,
  sourceFor,
  parallelSourceFor,
  type SourceConfig,
} from "../sources/config.js";
import { MIN_SPREAD_SAMPLES, SourceStateStore } from "../sources/state.js";
import {
  fetchBnr,
  fetchCbn,
  fetchCbk,
  fetchBog,
  fetchBot,
  fetchSarb,
  fetchCrossCheck,
  fetchQuidax,
  type RateFetch,
} from "../sources/fetchers.js";
import {
  checkDiscrepancy,
  checkSpreadAnomaly,
  median,
  mergeFlags,
  snapshotIsStale,
  spreadPct,
  type SpreadBaseline,
} from "../reconcile.js";

const FALLBACK_HINT = "set FX_PROVIDER=mock for offline fixtures";

/** Per-bank fetcher dispatch — adding a bank is one config entry + one function here. */
function dispatchOfficial(cfg: SourceConfig): Promise<OfficialRate> {
  switch (cfg.id) {
    case "bnr": return fetchBnr(cfg);
    case "cbn": return fetchCbn(cfg);
    case "cbk": return fetchCbk(cfg);
    case "bog": return fetchBog(cfg);
    case "bot": return fetchBot(cfg);
    case "sarb": return fetchSarb(cfg);
    default:
      throw new ToolError(`No fetcher wired for source "${cfg.id}".`, FALLBACK_HINT);
  }
}

/** The network seam. Overridable so the degradation ladder is testable without a network. */
export interface LiveFxDeps {
  fetchOfficial(cfg: SourceConfig): Promise<OfficialRate>;
  fetchCrossCheck(cfg: SourceConfig, localCurrency: string): Promise<RateFetch>;
  fetchParallel(cfg: SourceConfig): Promise<ParallelRate>;
  fetchOfficialHistory(localCurrency: string, startDate: string, endDate: string): Promise<RateHistoryPoint[]>;
}

const defaultDeps: LiveFxDeps = {
  fetchOfficial: dispatchOfficial,
  fetchCrossCheck,
  fetchParallel: fetchQuidax,
  async fetchOfficialHistory(localCurrency, startDate, endDate) {
    const cfg = CROSS_CHECKS.frankfurter;
    // /v1/latest -> /v1/<start>..<end> for the time-series form.
    const url = `${cfg.url.replace(/latest$/, `${startDate}..${endDate}`)}?base=USD&symbols=${localCurrency}`;
    const { res, body } = await fetchJson(url, { method: "GET" }, { service: cfg.label, fallbackHint: FALLBACK_HINT });
    if (!res.ok || body === null) {
      throw new ToolError(`${cfg.label} history unavailable (HTTP ${res.status}).`, FALLBACK_HINT);
    }
    const b = body as { rates?: Record<string, Record<string, number>> };
    const out: RateHistoryPoint[] = [];
    for (const [date, rates] of Object.entries(b.rates ?? {})) {
      const rate = rates?.[localCurrency];
      if (typeof rate === "number" && rate > 0 && date >= startDate && date <= endDate) {
        out.push({ date, rate, source: cfg.id });
      }
    }
    return out.sort((a, b2) => a.date.localeCompare(b2.date));
  },
};

function requireBank(country: string): BankConfig {
  const bank = bankFor(country);
  if (!bank) {
    throw new ToolError(`Unknown country "${country}".`, `Supported: ${BANKS.map((b) => b.country).join(", ")}.`);
  }
  return bank;
}

/** Reject a currency that is not the country's own — see the mock provider for why. */
function requireCurrencyMatch(bank: BankConfig, currency: string): void {
  const given = currency.trim().toUpperCase();
  if (given && given !== bank.currency) {
    throw new ToolError(
      `${bank.country}'s currency is ${bank.currency}, not ${given}.`,
      "Call list_currencies for the country-to-currency map.",
    );
  }
}

function requireUsdQuote(quoteCurrency: string, tool: string): void {
  if (quoteCurrency.toUpperCase() !== "USD") {
    throw new ToolError(
      `${tool}: only USD quotes are supported in v1 (got "${quoteCurrency}").`,
      "Pass quote_currency: 'USD' or omit it.",
    );
  }
}

/** A resolved official rate, carrying the id of the source that actually served it. */
interface ResolvedOfficial {
  rate: OfficialRate;
  /** Underlying source id — NOT the display label, which may be decorated for provenance. */
  sourceId: string;
}

export class LiveFxProvider implements FxProvider {
  readonly name = "live";
  private readonly state = new SourceStateStore();
  private readonly staleThresholdHours = loadConfig().fxStaleThresholdHours;
  private readonly deps: LiveFxDeps;

  constructor(deps: Partial<LiveFxDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

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

  /**
   * Classify a failed fetch into DocsStatus terms. Unreachable (DNS/timeout) is UNAVAILABLE;
   * everything else — a failure status, or a page that fetched but would not parse — is
   * BROKEN, since a structural change is exactly what the spec wants surfaced as BROKEN.
   */
  private markFailure(sourceId: string, err: unknown): void {
    if (err instanceof SourceUnreachableError) this.state.markUnavailable(sourceId);
    else this.state.markBroken(sourceId);
  }

  private async fetchViaCrossCheck(bank: BankConfig, crossCfg: SourceConfig, label: string): Promise<ResolvedOfficial> {
    const f = await this.deps.fetchCrossCheck(crossCfg, bank.currency);
    const rate: OfficialRate = {
      country: bank.country,
      currency: bank.currency,
      quoteCurrency: "USD",
      rate: f.rate,
      source: label,
      asOf: f.asOf,
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
    this.state.recordOfficial(crossCfg.id, rate);
    return { rate, sourceId: crossCfg.id };
  }

  /** Fetch official for a country with the full degradation ladder. */
  private async officialWithFallback(country: string): Promise<ResolvedOfficial> {
    const bank = requireBank(country);
    if (!bank.officialAvailable) {
      throw new ToolError(
        `No official rate source for ${bank.country} yet (${bank.coverage}).`,
        "Call list_currencies for current coverage.",
      );
    }

    const cfg = sourceFor(bank.country);
    // Egypt: the direct CBE scrape is unconfirmed, so the cross-check IS the primary here
    // until a human verifies the page. sourceId records that honestly, which is what stops
    // reconcile_rate from later comparing this value against the same source.
    if (!cfg) {
      const crossCfg = CROSS_CHECKS.frankfurter;
      try {
        return await this.fetchViaCrossCheck(bank, crossCfg, crossCfg.id);
      } catch (err) {
        this.markFailure(crossCfg.id, err);
        const cached = this.state.get(crossCfg.id).lastGoodOfficial;
        if (cached) return { rate: { ...cached, stale: true }, sourceId: crossCfg.id };
        throw this.noCacheError(err, crossCfg.label);
      }
    }

    try {
      const rate = await this.deps.fetchOfficial(cfg);
      this.state.recordOfficial(cfg.id, rate);
      return { rate, sourceId: cfg.id };
    } catch (err) {
      this.markFailure(cfg.id, err);

      // Automatic fallback promotion, BEFORE falling back to cache: three straight failures
      // means the primary is not coming back this cycle, and a fresh secondary reading beats
      // a stale primary one. The source string discloses the substitution.
      const crossId = cfg.crossCheck;
      if (crossId && CROSS_CHECKS[crossId] && this.state.shouldPromoteFallback(cfg.id)) {
        try {
          return await this.fetchViaCrossCheck(
            bank,
            CROSS_CHECKS[crossId],
            `${CROSS_CHECKS[crossId].id} (promoted fallback for ${cfg.label})`,
          );
        } catch (crossErr) {
          this.markFailure(CROSS_CHECKS[crossId].id, crossErr);
        }
      }

      const cached = this.state.get(cfg.id).lastGoodOfficial;
      if (cached) return { rate: { ...cached, stale: true }, sourceId: cfg.id };
      throw this.noCacheError(err, cfg.label);
    }
  }

  private noCacheError(err: unknown, label: string): ToolError {
    const why = err instanceof Error ? err.message : String(err);
    return new ToolError(
      `${label} fetch failed and no last-known-good value is cached: ${why}`,
      FALLBACK_HINT,
    );
  }

  private snapshot(r: OfficialRate): RateSnapshot {
    const snap: RateSnapshot = {
      rate: r.rate,
      source: r.source,
      as_of: r.asOf,
      fetched_at: r.fetchedAt,
      stale: r.stale,
    };
    // A value can also age past the threshold while still being the newest we have.
    return { ...snap, stale: snap.stale || snapshotIsStale(snap, this.staleThresholdHours) };
  }

  async getOfficialRate(country: string, quoteCurrency = "USD"): Promise<RateSnapshot> {
    requireUsdQuote(quoteCurrency, "get_official_rate");
    const resolved = await this.officialWithFallback(country);
    return this.snapshot(resolved.rate);
  }

  async getParallelRate(
    country: string,
    quoteCurrency = "USD",
  ): Promise<RateSnapshot | { available: false; reason: "no_parallel_source" }> {
    requireUsdQuote(quoteCurrency, "get_parallel_rate");
    const bank = requireBank(country);
    const cfg = parallelSourceFor(bank.country);
    if (!cfg || !bank.parallelAvailable) return { available: false, reason: "no_parallel_source" };
    try {
      const r = await this.deps.fetchParallel(cfg);
      this.state.recordParallel(cfg.id, r);
      // ParallelRate carries the same provenance fields, so it ages by the same rule.
      return this.snapshot(r);
    } catch (err) {
      this.markFailure(cfg.id, err);
      const cached = this.state.get(cfg.id).lastGoodParallel;
      if (cached) {
        return {
          rate: cached.rate,
          source: cached.source,
          as_of: cached.asOf,
          fetched_at: cached.fetchedAt,
          stale: true,
        };
      }
      throw this.noCacheError(err, cfg.label);
    }
  }

  async getRateHistory(
    country: string,
    currency: string,
    rateType: "official" | "parallel",
    startDate: string,
    endDate: string,
  ): Promise<RateHistoryPoint[]> {
    const bank = requireBank(country);
    requireCurrencyMatch(bank, currency);
    // v1 has no historical PARALLEL source for any country. Returning the official series
    // here would silently answer a parallel question with official data — the one thing the
    // spec's acceptance criteria forbid. Return nothing instead.
    if (rateType === "parallel") return [];
    return this.deps.fetchOfficialHistory(bank.currency, startDate, endDate);
  }

  /**
   * Build the spread baseline from spreads this process has actually observed. There is no
   * historical parallel-rate source in v1, so a baseline only exists once enough live
   * observations have accumulated; until then the spread check abstains rather than
   * comparing today against an invented reference.
   */
  private spreadBaseline(currency: string): SpreadBaseline | null {
    const observations = this.state.spreadObservations(currency);
    if (observations.length < MIN_SPREAD_SAMPLES) return null;
    const m = median(observations);
    if (m === null) return null;
    return { medianSpreadPct: m, sampleSize: observations.length };
  }

  async reconcileRate(country: string, currency: string): Promise<ReconcileResult> {
    const bank = requireBank(country);
    requireCurrencyMatch(bank, currency);

    const primary = await this.officialWithFallback(bank.country);
    const official = primary.rate;
    const officialRows = [{ source: official.source, rate: official.rate, as_of: official.asOf }];

    // Independent cross-check (check 1). Resolve the configured cross-check, then drop it if
    // it IS the source that already served the primary — that happens for Egypt (whose
    // primary is Frankfurter) and after a fallback promotion. Comparing a source against
    // itself always reads 0% delta, which would report false agreement between "two" sources.
    const configured = sourceFor(bank.country)?.crossCheck;
    let crossCfg: SourceConfig | null = configured ? CROSS_CHECKS[configured] ?? null : null;
    if (!crossCfg && bank.country === "EG") crossCfg = CROSS_CHECKS.frankfurter;
    if (crossCfg && crossCfg.id === primary.sourceId) crossCfg = null;

    let crossRate: { source: string; rate: number } | null = null;
    if (crossCfg) {
      try {
        const f = await this.deps.fetchCrossCheck(crossCfg, bank.currency);
        crossRate = { source: crossCfg.id, rate: f.rate };
        officialRows.push({ source: crossCfg.id, rate: f.rate, as_of: f.asOf });
      } catch (err) {
        // A missing second opinion is not a discrepancy; record the health and carry on.
        this.markFailure(crossCfg.id, err);
      }
    }

    const parallel = await this.getParallelRate(bank.country).catch(() => null);
    const parallelRows =
      parallel && "rate" in parallel
        ? [{ source: parallel.source, rate: parallel.rate, as_of: parallel.as_of }]
        : [];
    const parallelRate = parallelRows.length > 0 ? parallelRows[0].rate : null;

    const spread = spreadPct(official.rate, parallelRate);
    // Feed today's observation in BEFORE reading the baseline back, so a long-running
    // process accumulates the rolling window the spec's check-2 needs.
    if (parallelRate !== null) this.state.recordSpread(bank.currency, official.asOf, spread);

    const flags = mergeFlags(
      checkDiscrepancy(bank.currency, { source: primary.sourceId, rate: official.rate }, crossRate),
      checkSpreadAnomaly(official.rate, parallelRate, this.spreadBaseline(bank.currency)),
    );

    return {
      official: officialRows,
      parallel: parallelRows,
      spread_pct: spread,
      discrepancy_flag: flags.discrepancy_flag,
      discrepancy_reason: flags.discrepancy_reason,
    };
  }

  async getRateStatus(country?: string): Promise<SourceStatus[]> {
    const banks = country ? [requireBank(country)] : BANKS;
    const out: SourceStatus[] = [];
    const now = Date.now();

    const push = (id: string, label: string) => {
      const s = this.state.peek(id);
      const last = s?.lastSuccessfulFetch ?? "";
      const parsed = last ? Date.parse(last) : NaN;
      const age = Number.isFinite(parsed) ? (now - parsed) / 3_600_000 : null;

      // With no successful fetch on record there is no evidence of health, so the source
      // reports UNAVAILABLE rather than being assumed LIVE. A recorded failure status wins
      // over that default. (The previous check indexed OFFICIAL_SOURCES — a country-keyed
      // map — by source id, so it never matched, and every untouched source reported LIVE
      // alongside an empty last_successful_fetch.)
      const status: DocsStatus = last
        ? s!.status
        : s && s.status !== "LIVE"
          ? s.status
          : "UNAVAILABLE";

      out.push({
        source: label,
        docs_status: status,
        last_successful_fetch: last,
        // -1 is the explicit "never successfully fetched" sentinel; age is never negative.
        age_hours: age === null ? -1 : Number(Math.max(age, 0).toFixed(2)),
        stale_threshold_hours: this.staleThresholdHours,
      });
    };

    for (const bank of banks) {
      const cfg = sourceFor(bank.country);
      if (cfg) push(cfg.id, `${cfg.label} (${bank.country})`);
      const parallelCfg = parallelSourceFor(bank.country);
      if (parallelCfg) push(parallelCfg.id, `${parallelCfg.label} (${bank.country})`);
    }
    return out;
  }
}
