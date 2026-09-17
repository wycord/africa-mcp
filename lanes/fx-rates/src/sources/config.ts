/**
 * Versioned, config-driven source registry (spec section 5). A site redesign becomes a
 * config diff, not a code rewrite: each source carries its endpoint/selector config and a
 * configVersion; the parser module named in `parser` turns the raw payload into a rate.
 *
 * Every v1 source is keyless and public. Politeness lives in core fetchText/fetchJson
 * (Wycord User-Agent, jittered capped retries); cadence is respected by the provider's
 * cache — one fetch per source per cache TTL.
 */

export type SourceKind = "api" | "scrape" | "parallel_api" | "unavailable";

export interface SelectorConfig {
  /** CSS selector or regex name — versioned so a redesign is a config diff. */
  selector: string;
  /** Row/table locator for HTML tables, where applicable. */
  rowSelector?: string;
  /** Which column of the matched row holds the numeric rate (0-based). */
  valueColumn?: number;
  /** Which column holds the quote-currency code (0-based), where applicable. */
  currencyColumn?: number;
  /**
   * Which column holds the row's own publication date (0-based), where the source prints
   * one. Read from the SAME row as the rate so `as_of` can never be invented — see
   * parsePublicationDate() in fetchers.ts.
   */
  dateColumn?: number;
}

export interface SourceConfig {
  /** Provider-internal id, e.g. "cbn". */
  id: string;
  /** Human label surfaced in source fields, e.g. "CBN". */
  label: string;
  country: string;
  currency: string;
  kind: SourceKind;
  configVersion: number;
  /** Primary endpoint. Dead until verified — see notes. */
  url: string;
  /** Selector/parse config for scrapes. */
  selectors?: SelectorConfig;
  /** Secondary fallback endpoint (e.g. PDF or aggregator mirror), where one exists. */
  fallbackUrl?: string;
  /** Cross-check source id from CROSS_CHECKS, where a second independent source exists. */
  crossCheck?: string;
  notes?: string;
}

/** The v1 per-bank official sources. Egypt (CBE) is intentionally absent: the exact CBE
 *  rates page is unconfirmed, and the spec forbids scaffolding a scraper against an
 *  unconfirmed URL — EG serves mock/Frankfurter until a human verifies the page. */
export const OFFICIAL_SOURCES: Record<string, SourceConfig> = {
  NG: {
    id: "cbn",
    label: "CBN",
    country: "NG",
    currency: "NGN",
    kind: "api",
    configVersion: 2,
    url: "https://www.cbn.gov.ng/api/GetAllNFEM_Rates",
    notes: "JS-rendered table loads from /api/GetAllNFEM_Rates; we fetch the JSON directly. Latest row is the official NFEM rate. No independent cross-check wired (Frankfurter does not serve NGN).",
  },
  GH: {
    id: "bog",
    label: "Bank of Ghana",
    country: "GH",
    currency: "GHS",
    kind: "scrape",
    configVersion: 3,
    url: "https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/",
    selectors: { selector: "table_31", rowSelector: "table", valueColumn: 5, currencyColumn: 1, dateColumn: 0 },
    // No confirmed Frankfurter coverage for BoG — OpenDataForAfrica is the cross-check.
    crossCheck: "opendataforafrica",
    notes: "Columns: 0=Date, 1=Currency ('US Dollar'), 2=Currency Pair, 3=Buying, 4=Selling, 5=Mid Rate. We take the Mid Rate, and the row's own Date — BoG publishes in arrears, so it is routinely yesterday. Verified live 2026-09-17 (USD row: 16 Sep 2026, mid 11.5000).",
  },
  KE: {
    id: "cbk",
    label: "Central Bank of Kenya",
    country: "KE",
    currency: "KES",
    kind: "unavailable",
    configVersion: 3,
    url: "https://www.centralbank.go.ke/cbk-indicative-rates/",
    notes: "UNAVAILABLE: current CBK rates are PDF-only; the HTML table and ajax endpoint both serve stale 2024 data. No current machine-readable KES source exists. Marked unavailable rather than serving a stale rate.",
  },
  ZA: {
    id: "sarb",
    label: "SARB",
    country: "ZA",
    currency: "ZAR",
    kind: "api",
    configVersion: 2,
    url: "https://custom.resbank.co.za/SarbWebApi/WebIndicators/HomePageRates",
    crossCheck: "frankfurter",
    notes: "SARB Web API returns a JSON indicator array; the 'Rand per US Dollar' entry (TimeseriesCode EXCX135D) is ZAR per USD. Verified 2026-09-17. Frankfurter genuinely serves ZAR, so this cross-check is valid.",
  },
  TZ: {
    id: "bot",
    label: "Bank of Tanzania",
    country: "TZ",
    currency: "TZS",
    kind: "scrape",
    configVersion: 3,
    url: "https://www.bot.go.tz/ExchangeRate/excRates?lang=en",
    selectors: { selector: "excRates", rowSelector: "table", valueColumn: 4, currencyColumn: 1, dateColumn: 5 },
    notes: "Columns: 0=S/NO, 1=Currency ('USD'), 2=Buying, 3=Selling, 4=Mean, 5=Transaction Date. valueColumn MUST stay 4 (Mean): col2 is the one-sided BUYING quote, ~0.5% below mid, and convert() uses this rate in both directions. Every sibling source is a mid/weighted average (CBN weightedAvgRate, BoG Mid Rate, SARB mid), so a bid here would also bias reconciliation. Verified live 2026-09-17 (USD: buy 2628.4455, sell 2654.73, mean 2641.5878).",
  },
  RW: {
    id: "bnr",
    label: "BNR",
    country: "RW",
    currency: "RWF",
    kind: "unavailable",
    configVersion: 2,
    url: "https://fxrates.bnr.rw/",
    // The public /latest/usd endpoint now 404s; BNR's root page says API access requires an
    // application through their e-correspondence portal. No free endpoint to scrape.
    notes: "UNAVAILABLE: BNR API is application-only as of 2026-09-17. Marked unavailable rather than fabricated.",
  },
};

/** Parallel/street-rate sources. Market observation only — never presented as "the real rate". */
export const PARALLEL_SOURCES: Record<string, SourceConfig> = {
  NG: {
    // Slug matches the registry row in the spec, and names the proxy instrument openly:
    // this is a USDT/NGN crypto ticker used as a parallel-market proxy, not a USD cash rate.
    id: "quidax-usdt-ngn",
    label: "Quidax USDT/NGN",
    country: "NG",
    currency: "NGN",
    kind: "parallel_api",
    configVersion: 1,
    url: "https://app.quidax.io/api/v1/markets/tickers/usdtngn",
    notes: "Free, no-auth USDT/NGN ticker — parallel-market proxy. Registry-listed alternatives (not wired): see spec section 6.",
  },
};

/** Cross-check sources (independent second opinions for the discrepancy check). */
export const CROSS_CHECKS: Record<string, SourceConfig> = {
  frankfurter: {
    id: "frankfurter",
    label: "Frankfurter.dev",
    country: "*",
    currency: "*",
    kind: "api",
    configVersion: 1,
    url: "https://api.frankfurter.dev/v1/latest",
    notes: "Free, open source, keyless. Serves ZAR but NOT NGN/KES/GHS/TZS — the spec's '19 African banks' claim was wrong. Only valid as a cross-check for ZA.",
  },
  opendataforafrica: {
    id: "opendataforafrica",
    label: "OpenDataForAfrica (Ghana)",
    country: "GH",
    currency: "GHS",
    kind: "api",
    configVersion: 1,
    url: "https://cb-ghana.opendataforafrica.org/",
    notes: "BoG mirror (CSV/JSON). Scraper-based cross-check for Ghana, which Frankfurter does not confirm.",
  },
};

/** Per-currency discrepancy thresholds (default 1%), overridable for more volatile currencies. */
export const DISCREPANCY_THRESHOLD_PCT: Record<string, number> = {
  NGN: 1.0,
  GHS: 1.0,
  KES: 1.0,
  ZAR: 1.0,
  TZS: 1.0,
  RWF: 1.0,
  EGP: 1.0,
};

export const SPREAD_ANOMALY_FACTOR = 2; // flag when the spread exceeds 2x the 30-day median

/**
 * Order-of-magnitude sanity band per currency, in local units per 1 USD. Versioned with the
 * selectors above, and deliberately WIDE (roughly a decade either side of the 2026 level):
 * this is not a plausibility model of FX markets and must never reject a real devaluation.
 *
 * What it does catch is the failure mode that makes a scraper dangerous rather than merely
 * broken — a rate that parses cleanly but means something else:
 *   - an inverted quote (USD per NGN = 0.00065 instead of 1550), off by ~10^6;
 *   - the wrong table column (a bid/ask spread, an index level, a year like "2026");
 *   - a units change upstream (major/minor units, a redenomination).
 * Any of those lands far outside the band, so we refuse the value and degrade to
 * last-known-good rather than hand an agent a confidently wrong number.
 */
export const PLAUSIBLE_RANGE: Record<string, { min: number; max: number }> = {
  NGN: { min: 100, max: 100_000 },
  GHS: { min: 1, max: 1_000 },
  KES: { min: 10, max: 10_000 },
  ZAR: { min: 1, max: 1_000 },
  TZS: { min: 200, max: 200_000 },
  RWF: { min: 100, max: 100_000 },
  EGP: { min: 1, max: 5_000 },
};

/**
 * Reject a parsed rate that cannot plausibly be "local units per 1 USD" for this currency.
 * Unknown currencies pass (we have no band to judge them by) but must still be finite and
 * positive — a zero or negative rate is never a rate.
 */
export function assertPlausibleRate(currency: string, rate: number, source: string): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${source}: rate ${rate} for ${currency} is not a positive finite number.`);
  }
  const band = PLAUSIBLE_RANGE[currency.toUpperCase()];
  if (!band) return rate;
  if (rate < band.min || rate > band.max) {
    throw new Error(
      `${source}: ${currency} rate ${rate} is outside the sanity band ${band.min}..${band.max} per USD. ` +
        `Refusing to serve it — the source's units, columns or page structure most likely changed.`,
    );
  }
  return rate;
}

export function sourceFor(country: string): SourceConfig | undefined {
  return OFFICIAL_SOURCES[country.trim().toUpperCase()];
}

export function parallelSourceFor(country: string): SourceConfig | undefined {
  return PARALLEL_SOURCES[country.trim().toUpperCase()];
}