/**
 * FX & Parallel Rates MCP tools — the 7 tools from spec section 3, exact names + field
 * names. Provider-agnostic: every tool calls the injected FxProvider and returns
 * structuredContent. Parallel rates are market observation only, labeled by source —
 * never presented as "the real rate" (spec section 8).
 */
import { z } from "zod";
import { type ToolDef, type FxProvider, ToolError } from "@braynexservices/africa-mcp-core";
import { BANKS, bankFor } from "./currencies.js";

const COUNTRY = z
  .string()
  .length(2)
  .describe("ISO-2 country code, e.g. NG, GH, KE, ZA, TZ, RW, EG");

const countryArg = (args: Record<string, unknown>): string => {
  const c = args.country;
  if (typeof c !== "string" || !/^[A-Za-z]{2}$/.test(c)) {
    throw new ToolError("country must be a 2-letter ISO code, e.g. 'NG'.", "Try list_currencies for supported countries.");
  }
  return c.toUpperCase();
};

/**
 * The currency a country's rates are quoted in, for display. Rates are "local units per 1
 * USD", so the human-readable line must name the CURRENCY (NGN), never the country (NG).
 */
const currencyOf = (country: string): string => bankFor(country)?.currency ?? country;

/** Local-currency -> country, derived from the one bank registry so the two cannot drift. */
const LOCAL_BY_CURRENCY: Record<string, string> = Object.fromEntries(
  BANKS.filter((b) => b.officialAvailable).map((b) => [b.currency, b.country]),
);

/**
 * Format a converted amount without rounding a real value down to zero. Plain toFixed(2)
 * turns 1 NGN -> USD (0.000645) into 0.00, which reads as "worth nothing" rather than
 * "worth a fraction of a cent". Amounts of 1 or more keep normal 2dp money precision;
 * smaller ones keep 6 significant digits.
 */
const roundMoney = (value: number): number =>
  Math.abs(value) >= 1 ? Number(value.toFixed(2)) : Number(value.toPrecision(6));

export function fxTools(provider: FxProvider): ToolDef[] {
  return [
    {
      name: "list_currencies",
      title: "List covered currencies",
      description:
        "List all covered African currencies: country, ISO-4217 code, central bank, v1/expansion coverage, and whether official and parallel rates are available.",
      inputSchema: {},
      outputSchema: {
        currencies: z.array(
          z.object({
            country: z.string(),
            iso_code: z.string(),
            bank: z.string(),
            coverage: z.enum(["v1", "expansion"]),
            official_available: z.boolean(),
            parallel_available: z.boolean(),
          }),
        ),
      },
      handler: async () => {
        const currencies = await provider.listCurrencies();
        const text = currencies
          .map((c) => `${c.country} — ${c.iso_code} (${c.bank}) [${c.coverage}] official:${c.official_available} parallel:${c.parallel_available}`)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: { currencies } };
      },
    },
    {
      name: "get_official_rate",
      title: "Get official central-bank rate",
      description:
        "Get the OFFICIAL central-bank exchange rate for a country vs a quote currency (default USD). " +
        "Rate means 1 {quote} = {rate} local units (e.g. 1 USD = 1550 NGN from CBN). " +
        "Serves the last-known-good value with stale: true when the source is down, rather than erroring. Example: { country: 'NG' }.",
      inputSchema: {
        country: COUNTRY,
        quote_currency: z.string().length(3).optional().describe("Quote currency ISO-4217 code (default USD)"),
      },
      outputSchema: {
        rate: z.number(),
        source: z.string(),
        as_of: z.string(),
        fetched_at: z.string(),
        stale: z.boolean(),
      },
      handler: async (args) => {
        const country = countryArg(args);
        const quote = typeof args.quote_currency === "string" ? args.quote_currency.toUpperCase() : "USD";
        const snap = await provider.getOfficialRate(country, quote);
        const text = `1 ${quote} = ${snap.rate.toLocaleString("en-US")} ${currencyOf(country)} (official, ${snap.source}, as of ${snap.as_of})${snap.stale ? " [STALE — last-known-good]" : ""}`;
        return { content: [{ type: "text", text }], structuredContent: { ...snap } };
      },
    },
    {
      name: "get_parallel_rate",
      title: "Get parallel / street-market rate",
      description:
        "Get the PARALLEL/street-market exchange rate for a country vs a quote currency (default USD), where a source exists. " +
        "Market observation only, labeled by source — not the official rate, and never advice. " +
        "Returns { available: false, reason: 'no_parallel_source' } for countries with no parallel source. Example: { country: 'NG' }.",
      inputSchema: {
        country: COUNTRY,
        quote_currency: z.string().length(3).optional().describe("Quote currency ISO-4217 code (default USD)"),
      },
      outputSchema: {
        rate: z.number().optional(),
        source: z.string().optional(),
        as_of: z.string().optional(),
        fetched_at: z.string().optional(),
        stale: z.boolean().optional(),
        available: z.boolean().optional(),
        reason: z.string().optional(),
      },
      handler: async (args) => {
        const country = countryArg(args);
        const quote = typeof args.quote_currency === "string" ? args.quote_currency.toUpperCase() : "USD";
        const snap = await provider.getParallelRate(country, quote);
        if (!("rate" in snap) || snap.rate === undefined) {
          return {
            content: [{ type: "text", text: `No parallel-rate source for ${country}. Official rates: use get_official_rate.` }],
            structuredContent: { ...snap },
          };
        }
        const text = `1 ${quote} ≈ ${snap.rate.toLocaleString("en-US")} ${currencyOf(country)} (parallel market, ${snap.source}, as of ${snap.as_of}) — market observation, not the official rate${snap.stale ? " [STALE — last-known-good]" : ""}`;
        return { content: [{ type: "text", text }], structuredContent: { ...snap } };
      },
    },
    {
      name: "get_rate_history",
      title: "Get historical rates",
      description:
        "Get a historical daily rate series (official or parallel) for a country's currency, inclusive of start_date and end_date (YYYY-MM-DD). Example: { country: 'NG', currency: 'NGN', rate_type: 'official', start_date: '2026-08-01', end_date: '2026-08-31' }.",
      inputSchema: {
        country: COUNTRY,
        currency: z.string().length(3).describe("Local currency ISO-4217 code, e.g. NGN"),
        rate_type: z.enum(["official", "parallel"]),
        start_date: z.string().describe("Start date, YYYY-MM-DD"),
        end_date: z.string().describe("End date, YYYY-MM-DD"),
      },
      outputSchema: {
        history: z.array(z.object({ date: z.string(), rate: z.number(), source: z.string() })),
      },
      handler: async (args) => {
        const country = countryArg(args);
        const currency = typeof args.currency === "string" ? args.currency.toUpperCase() : "";
        const rateType = args.rate_type === "parallel" ? "parallel" : "official";
        const start = typeof args.start_date === "string" ? args.start_date : "";
        const end = typeof args.end_date === "string" ? args.end_date : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
          throw new ToolError("start_date and end_date must be YYYY-MM-DD.", "Example: start_date '2026-08-01', end_date '2026-08-31'.");
        }
        if (start > end) {
          throw new ToolError("start_date is after end_date.", "Swap them and retry.");
        }
        const history = await provider.getRateHistory(country, currency, rateType, start, end);
        const text = history.length
          ? history.map((h) => `${h.date}: 1 USD = ${h.rate.toLocaleString("en-US")} ${currency} (${rateType}, ${h.source})`).join("\n")
          : `No ${rateType} history for ${country} in ${start}..${end}.`;
        return { content: [{ type: "text", text }], structuredContent: { history } };
      },
    },
    {
      name: "convert",
      title: "Convert an amount at official or parallel rate",
      description:
        "Convert an amount between two currencies using the official (default) or parallel rate for the local leg. " +
        "Example: { amount: 100, from_currency: 'USD', to_currency: 'NGN', rate_type: 'parallel' }.",
      inputSchema: {
        amount: z.number().positive().describe("Amount to convert"),
        from_currency: z.string().length(3).describe("Source currency ISO-4217 code, e.g. USD"),
        to_currency: z.string().length(3).describe("Target currency ISO-4217 code, e.g. NGN"),
        rate_type: z.enum(["official", "parallel"]).optional().describe("Rate to use (default official)"),
      },
      outputSchema: {
        result: z.number(),
        rate_used: z.number(),
        source: z.string(),
        as_of: z.string(),
      },
      handler: async (args) => {
        const amount = Number(args.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new ToolError("amount must be a positive number.", "Example: amount: 100.");
        }
        const from = String(args.from_currency ?? "").toUpperCase();
        const to = String(args.to_currency ?? "").toUpperCase();
        const rateType = args.rate_type === "parallel" ? "parallel" : "official";
        if (from.length !== 3 || to.length !== 3 || from === to) {
          throw new ToolError("from_currency and to_currency must be different 3-letter ISO codes.", "Example: USD -> NGN.");
        }

        const localCountry = LOCAL_BY_CURRENCY[from === "USD" ? to : from];
        if (!localCountry || (from !== "USD" && to !== "USD")) {
          throw new ToolError(
            `Unsupported pair ${from}->${to}. v1 supports USD <-> {${Object.keys(LOCAL_BY_CURRENCY).join(", ")}}.`,
            "Cross-African-currency pairs: convert via USD in two steps.",
          );
        }

        // Every provider rate is "local units per 1 USD". USD -> local multiplies by it;
        // local -> USD divides by it. Nothing else in this tool inverts a rate.
        const snap = rateType === "parallel"
          ? await provider.getParallelRate(localCountry, "USD")
          : await provider.getOfficialRate(localCountry, "USD");
        if (!("rate" in snap)) {
          throw new ToolError(
            `No parallel source for ${localCountry}.`,
            "Use rate_type 'official', or another country.",
          );
        }
        if (!Number.isFinite(snap.rate) || snap.rate <= 0) {
          throw new ToolError(
            `Source ${snap.source} returned an unusable rate (${snap.rate}) for ${localCountry}.`,
            "Check get_rate_status for that source's health.",
          );
        }

        const rate = from === "USD" ? snap.rate : 1 / snap.rate;
        const result = roundMoney(amount * rate);
        const staleNote = snap.stale ? " [STALE — last-known-good]" : "";
        const text = `${amount.toLocaleString("en-US")} ${from} = ${result.toLocaleString("en-US")} ${to} @ ${rate.toPrecision(6)} (${rateType}, ${snap.source}, as of ${snap.as_of})${staleNote}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { result, rate_used: rate, source: snap.source, as_of: snap.as_of },
        };
      },
    },
    {
      name: "reconcile_rate",
      title: "Reconcile a rate across sources",
      description:
        "Run the reconciliation layer on demand for a country's currency: gathers the official rate from the direct source AND its independent cross-check, the parallel rate where one exists, and reports the official-vs-parallel spread plus any discrepancy flags (cross-provider delta > threshold, abnormal spread, staleness). Example: { country: 'NG', currency: 'NGN' }.",
      inputSchema: {
        country: COUNTRY,
        currency: z.string().length(3).describe("Local currency ISO-4217 code, e.g. NGN"),
      },
      outputSchema: {
        official: z.array(z.object({ source: z.string(), rate: z.number(), as_of: z.string() })),
        parallel: z.array(z.object({ source: z.string(), rate: z.number(), as_of: z.string() })),
        spread_pct: z.number(),
        discrepancy_flag: z.boolean(),
        discrepancy_reason: z.string().nullable(),
      },
      handler: async (args) => {
        const country = countryArg(args);
        const currency = String(args.currency ?? "").toUpperCase();
        const r = await provider.reconcileRate(country, currency);
        const lines = [
          `Official sources: ${r.official.map((o) => `${o.source}=${o.rate} (${o.as_of})`).join(", ")}`,
          `Parallel sources: ${r.parallel.length ? r.parallel.map((p) => `${p.source}=${p.rate} (${p.as_of})`).join(", ") : "(none)"}`,
          `Official-vs-parallel spread: ${r.spread_pct}%`,
          r.discrepancy_flag ? `DISCREPANCY: ${r.discrepancy_reason}` : "No discrepancy flagged.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { ...r } };
      },
    },
    {
      name: "get_rate_status",
      title: "Get source health / staleness status",
      description:
        "Get per-source health for the FX sources: docs_status (LIVE | BROKEN | UNAVAILABLE | SHUT_DOWN), last successful fetch, age in hours, and the staleness threshold. Filter to one country with the optional country arg. Use this to check whether rates are current before relying on them.",
      inputSchema: {
        country: z.string().length(2).optional().describe("Optional ISO-2 country filter, e.g. NG"),
      },
      outputSchema: {
        sources: z.array(
          z.object({
            source: z.string(),
            docs_status: z.enum(["LIVE", "BROKEN", "UNAVAILABLE", "SHUT_DOWN"]),
            last_successful_fetch: z.string(),
            age_hours: z.number(),
            stale_threshold_hours: z.number(),
          }),
        ),
      },
      handler: async (args) => {
        const country = typeof args.country === "string" ? args.country.toUpperCase() : undefined;
        const sources = await provider.getRateStatus(country);
        const text = sources.length
          ? sources.map((s) => `${s.source}: ${s.docs_status} (last ok ${s.last_successful_fetch}, age ${s.age_hours}h, stale after ${s.stale_threshold_hours}h)`).join("\n")
          : `No sources tracked for ${country ?? "any country"}.`;
        return { content: [{ type: "text", text }], structuredContent: { sources } };
      },
    },
  ];
}