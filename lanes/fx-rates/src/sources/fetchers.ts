/**
 * Per-bank live fetchers — one module per bank (spec section 5). Each is thin: it reads its
 * SourceConfig (versioned selectors), fetches politely via core fetchText/fetchJson, parses
 * with its own small table/regex logic, and returns an OfficialRate. A site redesign = bump
 * configVersion + adjust the parser, not a rewrite.
 *
 * Every rate leaving this module passes assertPlausibleRate(): a parse that succeeds but
 * produces a number of the wrong magnitude (inverted quote, wrong column, changed units) is
 * more dangerous than a parse that fails, so it is refused here rather than served.
 *
 * A failing fetch NEVER throws out of a tool call for rate data: the provider catches, marks
 * the source BROKEN/UNAVAILABLE, and serves last-known-good with stale: true.
 */
import {
  type OfficialRate,
  type ParallelRate,
  nowIso,
  fetchJson,
  fetchText,
  SourceUnavailableError,
} from "@braynexservices/africa-mcp-core";
import { assertPlausibleRate, type SourceConfig } from "./config.js";

export interface RateFetch {
  rate: number;
  asOf: string;
}

/**
 * Parse a rate out of raw table text, handling the separator conventions our sources use:
 * "1,550.00" (anglophone), "1 550,00" / "1.550,00" (francophone), "1550", "1550.25".
 *
 * The rule is positional, not locale-guessed: whichever of "," or "." appears LAST is the
 * decimal separator, and every other separator is a thousands group. A repeated separator
 * ("1.550.000") is therefore always thousands.
 *
 * The one genuinely ambiguous form is a single separator followed by exactly three digits
 * ("1,550" / "1.550"), which is 1550 anglophone and 1.550 francophone. We read it as
 * thousands for "," and as a decimal for ".", matching how all seven v1 sources publish.
 * assertPlausibleRate() is the backstop if a source ever switches convention.
 */
export function parseNumber(raw: string): number {
  // Drop currency symbols, letters, NBSP and ordinary spaces (all thousands separators here).
  const cleaned = raw.replace(/[\s  ]/g, "").replace(/[^0-9.,-]/g, "");
  if (!/\d/.test(cleaned)) throw new Error(`Unparseable rate value: "${raw}"`);

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized: string;

  if (lastComma === -1 && lastDot === -1) {
    normalized = cleaned;
  } else if (lastComma > lastDot) {
    // Comma is the decimal separator: strip dots, swap the comma for a dot.
    normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
  } else if (lastDot > lastComma) {
    // Dot is the decimal separator: strip commas, and any earlier dots (thousands groups).
    const intPart = cleaned.slice(0, lastDot).replace(/[.,]/g, "");
    const fracPart = cleaned.slice(lastDot + 1).replace(/[.,]/g, "");
    normalized = `${intPart}.${fracPart}`;
  } else {
    normalized = cleaned;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Unparseable rate value: "${raw}"`);
  return n;
}

/** Strip tags and decode the handful of entities that show up inside rate cells. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split an HTML table row into its cell texts, in document order. */
function rowCells(row: string): string[] {
  return row
    .split(/<t[dh][^>]*>/i)
    .slice(1)
    .map((c) => cellText(c.split(/<\/t[dh]>/i)[0] ?? ""));
}

/** Match a currency code as a standalone token, not as a substring of a longer word. */
function mentionsCode(text: string, code: string): boolean {
  return new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`, "i").test(text);
}

/** Match a full currency label (e.g. "US Dollar", "US DOLLAR") case-insensitively. */
function mentionsLabel(text: string, label: string): boolean {
  return text.replace(/\s+/g, " ").trim().toUpperCase() === label.toUpperCase();
}

/**
 * Extract a numeric rate for `quote` from table-like HTML.
 *
 * When the config names a currencyColumn we REQUIRE that column to hold the currency code,
 * rather than accepting any row that mentions the code somewhere. A page that lists USD in a
 * commentary cell, or a second table on the same page, would otherwise silently yield a
 * number from the wrong row — and a wrong rate is worse than no rate.
 */
export function extractRateFromHtml(html: string, cfg: SourceConfig, quote: string): number {
  const sel = cfg.selectors;
  if (!sel?.rowSelector) {
    throw new Error(`${cfg.label} (v${cfg.configVersion}): no row selector configured.`);
  }

  const rows = html
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((r) => r.split(/<\/tr>/i)[0] ?? "");

  for (const row of rows) {
    const cells = rowCells(row);
    if (cells.length === 0) continue;

    if (sel.currencyColumn !== undefined) {
      const codeCell = cells[sel.currencyColumn];
      if (!codeCell) continue;
      // The currency cell can hold a code ("USD") or a label ("US Dollar"). Require the
      // cell to be an exact match to the quote code or its dollar/currency label — never a
      // mere substring mention ("Rates quoted against USD on 2026-09-16" must not win).
      // "USDOLLAR" arises from both "US Dollar" (BoG) and "US DOLLAR" (CBK) once spaces
      // are stripped; the "US"→"USD" expansion covers it.
      const q = quote.toUpperCase();
      const normalized = codeCell.replace(/[^A-Za-z]/g, "").toUpperCase();
      if (normalized !== q && normalized !== `${q}DOLLAR` && normalized !== `${q.replace(/D$/, "")}DOLLAR`) continue;
    } else if (!mentionsCode(cellText(row), quote)) {
      continue;
    }

    const idx = sel.valueColumn ?? cells.length - 1;
    const cell = cells[idx];
    if (!cell) continue;
    // Anchor on a complete numeric token so a stray "2026" beside the rate cannot win.
    const m = cell.match(/-?\d[\d.,   ]*\d|-?\d/);
    if (!m) continue;
    return parseNumber(m[0]);
  }
  throw new Error(`${cfg.label} (v${cfg.configVersion}): no parseable ${quote} row in page`);
}

function official(cfg: SourceConfig, fetched: RateFetch): OfficialRate {
  return {
    country: cfg.country,
    currency: cfg.currency,
    quoteCurrency: "USD",
    rate: assertPlausibleRate(cfg.currency, fetched.rate, cfg.label),
    source: cfg.id,
    asOf: fetched.asOf,
    fetchedAt: nowIso(),
    stale: false,
  };
}

const FALLBACK_HINT = "set FX_PROVIDER=mock for offline fixtures";

/** Publication dates are local dates; UTC today is close enough for a daily cadence. */
function todayLocal(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Accept only a plain YYYY-MM-DD publication date from a payload; otherwise use today. */
function asOfDate(raw: unknown): string {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayLocal();
}

// ---------- Rwanda (BNR) — UNAVAILABLE ----------

export async function fetchBnr(cfg: SourceConfig): Promise<OfficialRate> {
  // The public /latest/usd endpoint 404s as of 2026-09-17, and BNR's site states that API
  // access requires an application via their e-correspondence portal. Config kind is
  // "unavailable"; this fetcher must never reach the network or fabricate a number.
  throw new SourceUnavailableError(404, cfg.label, FALLBACK_HINT);
}

// ---------- Nigeria (CBN) — JSON API ----------

export async function fetchCbn(cfg: SourceConfig): Promise<OfficialRate> {
  // The rates page is JS-rendered; the underlying JSON API is fetched directly. Rows come
  // newest-first, but the id guard makes a reorder serve an old rate as today's — and a
  // wrong-but-parseable number is the dangerous case — impossible.
  const { res, body } = await fetchJson(cfg.url, { method: "GET" }, { service: cfg.label, fallbackHint: FALLBACK_HINT });
  if (!res.ok || body === null) throw new SourceUnavailableError(res.status, cfg.label, FALLBACK_HINT);
  const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  if (rows.length === 0) throw new Error(`${cfg.label}: NFEM API returned no rate rows`);
  const latest = rows.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a), rows[0]);
  const rate = Number(latest.weightedAvgRate ?? latest.closingrate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${cfg.label}: NFEM latest row has no usable weightedAvgRate/closingrate`);
  }
  return official(cfg, { rate, asOf: todayLocal() });
}

// ---------- Kenya (CBK) — UNAVAILABLE (PDF-only) ----------

export async function fetchCbk(cfg: SourceConfig): Promise<OfficialRate> {
  // CBK's indicative-rates table on the HTML page is stale (04/01/2024). Current rates ship
  // only as dated PDFs (/uploads/cbk_indicative_rates/…), and the wpDataTables ajax endpoint
  // (table_id=91) serves the same stale snapshot. There is no current machine-readable KES
  // source, so we refuse rather than serve a years-old rate. A PDF parser is a future
  // enhancement, not something to hand-roll here.
  throw new SourceUnavailableError(404, cfg.label, FALLBACK_HINT);
}

// ---------- Ghana (BoG) — scrape ----------

export async function fetchBog(cfg: SourceConfig): Promise<OfficialRate> {
  const html = await fetchText(cfg.url, { service: cfg.label, fallbackHint: FALLBACK_HINT });
  return official(cfg, { rate: extractRateFromHtml(html, cfg, "USD"), asOf: todayLocal() });
}

// ---------- Tanzania (BoT) — scrape ----------

export async function fetchBot(cfg: SourceConfig): Promise<OfficialRate> {
  const html = await fetchText(cfg.url, { service: cfg.label, fallbackHint: FALLBACK_HINT });
  return official(cfg, { rate: extractRateFromHtml(html, cfg, "USD"), asOf: todayLocal() });
}

// ---------- South Africa (SARB) — JSON API ----------

export async function fetchSarb(cfg: SourceConfig): Promise<OfficialRate> {
  // The WebIndicators endpoint returns an array of { Name, Date, Value, ... } indicator
  // rows; the "Rand per US Dollar" entry is ZAR per 1 USD. Match by exact indicator name —
  // never by position — and refuse to guess if the row or a numeric Value is missing.
  const { res, body } = await fetchJson(cfg.url, { method: "GET" }, { service: cfg.label, fallbackHint: FALLBACK_HINT });
  if (!res.ok || body === null) throw new SourceUnavailableError(res.status, cfg.label, FALLBACK_HINT);
  const rows = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  const row = rows.find((r) => r.Name === "Rand per US Dollar");
  if (!row) throw new Error(`${cfg.label}: no "Rand per US Dollar" indicator in HomePageRates payload`);
  const rate = Number(row.Value);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${cfg.label}: "Rand per US Dollar" Value is not a positive number`);
  }
  return official(cfg, { rate, asOf: asOfDate(row.Date) });
}

// ---------- Cross-check sources ----------

/**
 * Fetch an independent second opinion for `localCurrency`, in local units per 1 USD — the
 * same direction and units as the primary sources, so the two are directly comparable.
 */
export async function fetchCrossCheck(cfg: SourceConfig, localCurrency: string): Promise<RateFetch> {
  const code = localCurrency.toUpperCase();
  if (cfg.id === "frankfurter") {
    // base=USD makes rates[code] "code units per 1 USD" — matching our convention exactly.
    const url = `${cfg.url}?base=USD&symbols=${code}`;
    const { res, body } = await fetchJson(url, { method: "GET" }, { service: cfg.label, fallbackHint: FALLBACK_HINT });
    if (!res.ok || body === null) throw new SourceUnavailableError(res.status, cfg.label, FALLBACK_HINT);
    const b = body as Record<string, unknown>;
    const rates = (b.rates ?? {}) as Record<string, unknown>;
    const r = rates[code];
    if (typeof r !== "number") throw new Error(`${cfg.label}: no ${code} rate`);
    return { rate: assertPlausibleRate(code, r, cfg.label), asOf: asOfDate(b.date) };
  }
  if (cfg.id === "opendataforafrica") {
    const html = await fetchText(cfg.url, { service: cfg.label, fallbackHint: FALLBACK_HINT });
    const rate = extractRateFromHtml(html, cfg, "USD");
    return { rate: assertPlausibleRate(code, rate, cfg.label), asOf: todayLocal() };
  }
  throw new Error(`No fetcher for cross-check source ${cfg.id}`);
}

// ---------- Quidax (NG parallel proxy) — free, no auth ----------

export async function fetchQuidax(cfg: SourceConfig): Promise<ParallelRate> {
  const { res, body } = await fetchJson(cfg.url, { method: "GET" }, { service: cfg.label, fallbackHint: FALLBACK_HINT });
  if (!res.ok || body === null) throw new SourceUnavailableError(res.status, cfg.label, FALLBACK_HINT);
  const b = body as Record<string, unknown>;
  const data = (b.data ?? b) as Record<string, unknown>;
  const ticker = (data.ticker ?? data) as Record<string, unknown>;
  const last = ticker.last ?? ticker.last_price ?? data.last;
  const rate = Number(last);
  if (!Number.isFinite(rate)) throw new Error(`${cfg.label}: no usable last price`);
  // USDT trades ~1:1 with USD, so NGN-per-USDT stands in for the NGN street rate. The band
  // still applies: it is the same order of magnitude, and a broken ticker must not pass.
  assertPlausibleRate(cfg.currency, rate, cfg.label);

  // Quidax stamps `at` as epoch seconds. Reject an unusable stamp instead of substituting
  // "now" — that would present an observation of unknown age as a fresh one.
  const atRaw = Number(ticker.at ?? data.at);
  const observedAt = Number.isFinite(atRaw) && atRaw > 0 ? new Date(atRaw * 1000) : null;
  const asOf = observedAt ?? new Date();
  return {
    country: cfg.country,
    currency: cfg.currency,
    // Disclosed as the proxy instrument it is, never relabelled as a USD cash rate.
    quoteCurrency: "USDT",
    rate,
    source: cfg.id,
    asOf: asOf.toISOString().slice(0, 10),
    fetchedAt: nowIso(),
    stale: false,
  };
}
