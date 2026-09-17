/**
 * FX & Parallel Rates lane smoke test. Zero network, zero signup.
 *
 * Part 1 drives all 7 tools over an in-memory MCP client<->server pair against the mock
 * provider. Part 2 exercises the pure money-path functions directly. Part 3 drives the LIVE
 * provider through its degradation ladder with an injected fetch seam, so the spec's
 * "degrades rather than crashes" criterion is proven offline instead of assumed.
 *
 * Run: npm run smoke (exits non-zero on failure)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildServer,
  SourceUnavailableError,
  SourceUnreachableError,
  type OfficialRate,
} from "@braynexservices/africa-mcp-core";
import { fxTools } from "../src/tools.js";
import { MockFxProvider } from "../src/providers/mock.js";
import { LiveFxProvider } from "../src/providers/live.js";
import { extractRateFromHtml, parseNumber } from "../src/sources/fetchers.js";
import { assertPlausibleRate, OFFICIAL_SOURCES, type SourceConfig } from "../src/sources/config.js";

const failures: string[] = [];
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) return;
  failures.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`);
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

// ===================== Part 1: the 7 tools, over MCP, on mocks =====================

const server = buildServer(fxTools(new MockFxProvider()), { name: "fx-smoke" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "smoke", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

const EXPECTED_TOOLS = [
  "list_currencies",
  "get_official_rate",
  "get_parallel_rate",
  "get_rate_history",
  "convert",
  "reconcile_rate",
  "get_rate_status",
];
const toolNames = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", toolNames.join(", "));
check("7 tools exposed", toolNames.length === 7, toolNames.length);
for (const name of EXPECTED_TOOLS) check(`tool ${name} present`, toolNames.includes(name));

const sc = <T>(r: { structuredContent?: unknown }) => r.structuredContent as T;
const textOf = (r: { content?: unknown }) =>
  (r.content as { type: string; text?: string }[] | undefined)?.map((c) => c.text ?? "").join("\n") ?? "";

// --- list_currencies
const currencies = sc<{ currencies: { country: string; iso_code: string; coverage: string }[] }>(
  await client.callTool({ name: "list_currencies", arguments: {} }),
);
const v1 = currencies.currencies.filter((c) => c.coverage === "v1");
console.log("currencies ->", currencies.currencies.length, "v1:", v1.length);
check("7 v1 currencies", v1.length === 7, v1.length);

// --- get_official_rate
const officialRes = await client.callTool({ name: "get_official_rate", arguments: { country: "NG" } });
const official = sc<{ rate: number; source: string; as_of: string; fetched_at: string; stale: boolean }>(officialRes);
console.log("NG official ->", JSON.stringify(official));
check("NG official rate is the fixture", official.rate === 1550, official.rate);
check("NG official is not stale", official.stale === false);
// The human-readable line must name the CURRENCY, not the country code.
check("official text says NGN, not NG", /1,550 NGN/.test(textOf(officialRes)), textOf(officialRes));

// --- get_parallel_rate
const parallel = sc<{ rate: number; source: string }>(
  await client.callTool({ name: "get_parallel_rate", arguments: { country: "NG" } }),
);
const noParallel = sc<{ available: boolean; reason: string }>(
  await client.callTool({ name: "get_parallel_rate", arguments: { country: "GH" } }),
);
console.log("NG parallel ->", JSON.stringify(parallel), "| GH parallel ->", JSON.stringify(noParallel));
check("NG parallel rate is the fixture", parallel.rate === 1610, parallel.rate);
check("parallel differs from official", parallel.rate !== official.rate);
check("GH reports no parallel source", noParallel.available === false && noParallel.reason === "no_parallel_source");

// --- get_rate_history
const history = sc<{ history: { date: string; rate: number }[] }>(
  await client.callTool({
    name: "get_rate_history",
    arguments: { country: "NG", currency: "NGN", rate_type: "official", start_date: "2026-09-01", end_date: "2026-09-16" },
  }),
);
console.log("NG official history ->", history.history.length, "points");
check("NG official history is 16 inclusive days", history.history.length === 16, history.history.length);

// A country with no parallel market must NOT be handed a fabricated parallel series.
const ghParallelHistory = sc<{ history: unknown[] }>(
  await client.callTool({
    name: "get_rate_history",
    arguments: { country: "GH", currency: "GHS", rate_type: "parallel", start_date: "2026-09-01", end_date: "2026-09-16" },
  }),
);
console.log("GH parallel history ->", ghParallelHistory.history.length, "points");
check("no fabricated parallel history for GH", ghParallelHistory.history.length === 0, ghParallelHistory.history.length);

// A currency that is not the country's own must be rejected, not silently relabelled.
const currencyMismatch = await client.callTool({
  name: "get_rate_history",
  arguments: { country: "NG", currency: "KES", rate_type: "official", start_date: "2026-09-01", end_date: "2026-09-16" },
});
check("country/currency mismatch is an error", currencyMismatch.isError === true);

// --- convert
const convOfficial = sc<{ result: number; rate_used: number }>(
  await client.callTool({ name: "convert", arguments: { amount: 100, from_currency: "USD", to_currency: "NGN" } }),
);
const convParallel = sc<{ result: number; rate_used: number }>(
  await client.callTool({ name: "convert", arguments: { amount: 100, from_currency: "USD", to_currency: "NGN", rate_type: "parallel" } }),
);
const convInverse = sc<{ result: number }>(
  await client.callTool({ name: "convert", arguments: { amount: 155000, from_currency: "NGN", to_currency: "USD" } }),
);
const convTiny = sc<{ result: number }>(
  await client.callTool({ name: "convert", arguments: { amount: 1, from_currency: "NGN", to_currency: "USD" } }),
);
console.log("convert ->", convOfficial.result, "|", convParallel.result, "|", convInverse.result, "| tiny", convTiny.result);
check("100 USD -> NGN official", convOfficial.result === 155000, convOfficial.result);
check("100 USD -> NGN parallel", convParallel.result === 161000, convParallel.result);
check("parallel and official rates differ", convParallel.rate_used !== convOfficial.rate_used);
check("155000 NGN -> USD round-trips", near(convInverse.result, 100, 0.01), convInverse.result);
// A sub-cent amount must not be rounded away to zero.
check("1 NGN -> USD is not rounded to 0", convTiny.result > 0, convTiny.result);
const convBadPair = await client.callTool({ name: "convert", arguments: { amount: 10, from_currency: "NGN", to_currency: "KES" } });
check("cross-local pair is rejected", convBadPair.isError === true);

// --- reconcile_rate: two independent official rows, spread, and the discrepancy flag
const recNg = sc<{ official: { source: string; rate: number }[]; parallel: unknown[]; spread_pct: number; discrepancy_flag: boolean; discrepancy_reason: string | null }>(
  await client.callTool({ name: "reconcile_rate", arguments: { country: "NG", currency: "NGN" } }),
);
console.log("reconcile NG ->", JSON.stringify(recNg));
check("NG reconcile has two official sources", recNg.official.length === 2, recNg.official.length);
check("NG reconcile sources are distinct", recNg.official[0]?.source !== recNg.official[1]?.source);
check("NG reconcile rates are independent values", recNg.official[0]?.rate !== recNg.official[1]?.rate);
check("NG reconcile has one parallel row", recNg.parallel.length === 1, recNg.parallel.length);
// (1610 - 1550) / 1550 = 3.87%, not 3.9 — the spread is computed, not assumed.
check("NG spread_pct is 3.87", recNg.spread_pct === 3.87, recNg.spread_pct);
check("NG is not flagged (0.2% < 1% threshold)", recNg.discrepancy_flag === false, recNg.discrepancy_reason);

// EG's cross-check fixture deviates 2.51%, above the 1% threshold — the flag must fire.
const recEg = sc<{ discrepancy_flag: boolean; discrepancy_reason: string | null }>(
  await client.callTool({ name: "reconcile_rate", arguments: { country: "EG", currency: "EGP" } }),
);
console.log("reconcile EG ->", JSON.stringify(recEg));
check("EG discrepancy flag fires", recEg.discrepancy_flag === true);
check("EG reason names the cross-provider check", /CROSS_PROVIDER_DISCREPANCY/.test(recEg.discrepancy_reason ?? ""), recEg.discrepancy_reason);

// --- get_rate_status
const statusAll = sc<{ sources: { docs_status: string }[] }>(await client.callTool({ name: "get_rate_status", arguments: {} }));
const statusNg = sc<{ sources: { source: string }[] }>(await client.callTool({ name: "get_rate_status", arguments: { country: "NG" } }));
console.log("status all ->", statusAll.sources.length, "| NG ->", statusNg.sources.map((s) => s.source).join(", "));
check("status covers every v1 source", statusAll.sources.length >= 7, statusAll.sources.length);
check("status filters to one country", statusNg.sources.length === 1, statusNg.sources.length);

// --- error path
const badCountry = await client.callTool({ name: "get_official_rate", arguments: { country: "XX" } });
check("unknown country is a clean isError, not a crash", badCountry.isError === true);

// --- determinism: identical calls must return byte-identical structured output
const repeat = sc<unknown>(await client.callTool({ name: "get_official_rate", arguments: { country: "NG" } }));
check("mock output is deterministic", JSON.stringify(repeat) === JSON.stringify(official));

await client.close();
await server.close();

// ===================== Part 2: the money-path primitives =====================

// The francophone thousands-separator bug: "1 550,00" must be 1550, not 155000.
check("parseNumber 1,550.00", parseNumber("1,550.00") === 1550, parseNumber("1,550.00"));
check("parseNumber '1 550,00'", parseNumber("1 550,00") === 1550, parseNumber("1 550,00"));
check("parseNumber 1.550,00", parseNumber("1.550,00") === 1550, parseNumber("1.550,00"));
check("parseNumber 1550.25", parseNumber("1550.25") === 1550.25, parseNumber("1550.25"));
check("parseNumber 1550", parseNumber("1550") === 1550, parseNumber("1550"));

// Row selection must key off the configured currency column, not any mention of "USD".
// NG config: currencyColumn=1, valueColumn=3, so the table must have the code in column 1
// and the rate in column 3. A commentary cell in column 1 that merely mentions USD must not
// match.
const TABLE = `
<table>
  <tr><th> </th><th>Currency</th><th>Buying</th><th>Selling</th></tr>
  <tr><td>—</td><td>Rates quoted against USD on 2026-09-16</td><td>0</td><td>0</td></tr>
  <tr><td>—</td><td>GBP</td><td>1,980.00</td><td>1,990.00</td></tr>
  <tr><td>—</td><td>USD</td><td>1,548.00</td><td>1,550.00</td></tr>
</table>`;
const parsedRate = extractRateFromHtml(TABLE, OFFICIAL_SOURCES.NG as SourceConfig, "USD");
console.log("scraped USD rate ->", parsedRate);
check("scraper picks the USD row's configured column", parsedRate === 1550, parsedRate);

// The sanity band must reject an inverted quote and a mis-scaled one.
let inversionRejected = false;
try {
  assertPlausibleRate("NGN", 1 / 1550, "test");
} catch {
  inversionRejected = true;
}
check("inverted NGN quote is rejected", inversionRejected);
check("plausible NGN quote is accepted", assertPlausibleRate("NGN", 1550, "test") === 1550);

// ===================== Part 3: live degradation, with an injected fetch seam ==============

const rwCfg = OFFICIAL_SOURCES.RW as SourceConfig;
const ngCfg = OFFICIAL_SOURCES.NG as SourceConfig;

function officialFor(cfg: SourceConfig, rate: number, fetchedAt = new Date().toISOString()): OfficialRate {
  return {
    country: cfg.country,
    currency: cfg.currency,
    quoteCurrency: "USD",
    rate,
    source: cfg.id,
    asOf: fetchedAt.slice(0, 10),
    fetchedAt,
    stale: false,
  };
}

// A: succeed once, then fail -> must serve last-known-good with stale: true, never throw.
let rwCalls = 0;
const degrading = new LiveFxProvider({
  async fetchOfficial(cfg) {
    rwCalls += 1;
    if (rwCalls === 1) return officialFor(cfg, 1380);
    throw new SourceUnavailableError(503, cfg.label, "test");
  },
});
const firstRw = await degrading.getOfficialRate("RW");
const secondRw = await degrading.getOfficialRate("RW");
console.log("live RW first ->", JSON.stringify(firstRw), "\nlive RW after failure ->", JSON.stringify(secondRw));
check("first live fetch is fresh", firstRw.stale === false && firstRw.rate === 1380, firstRw);
check("failed fetch serves last-known-good", secondRw.rate === 1380, secondRw.rate);
check("degraded value is flagged stale", secondRw.stale === true);
const rwStatus = await degrading.getRateStatus("RW");
console.log("live RW status ->", JSON.stringify(rwStatus));
check("failed source reports BROKEN", rwStatus[0]?.docs_status === "BROKEN", rwStatus[0]?.docs_status);

// B: a source that was never fetched must not claim to be LIVE.
const untouched = await new LiveFxProvider({}).getRateStatus("KE");
check("never-fetched source is not reported LIVE", untouched[0]?.docs_status === "UNAVAILABLE", untouched[0]);
check("never-fetched source has the -1 age sentinel", untouched[0]?.age_hours === -1, untouched[0]?.age_hours);

// C: no cached value at all -> the tool errors rather than inventing a number.
let erroredWithoutCache = false;
try {
  await new LiveFxProvider({
    async fetchOfficial(cfg) {
      throw new SourceUnreachableError(cfg.label, "test");
    },
  }).getOfficialRate("RW");
} catch {
  erroredWithoutCache = true;
}
check("no cache + failure errors honestly", erroredWithoutCache);

// D: 3 consecutive failures promote the independent cross-check to primary.
const promoting = new LiveFxProvider({
  async fetchOfficial(cfg) {
    throw new SourceUnavailableError(500, cfg.label, "test");
  },
  async fetchCrossCheck(_cfg, _currency) {
    return { rate: 1560, asOf: "2026-09-16" };
  },
});
let promoted: { rate: number; source: string } | null = null;
for (let i = 0; i < 3; i++) {
  promoted = await promoting.getOfficialRate("NG").catch(() => null);
}
console.log("live NG after 3 failures ->", JSON.stringify(promoted));
check("cross-check is promoted after 3 failures", promoted?.rate === 1560, promoted);
check("promotion is disclosed in the source", /promoted fallback/.test(promoted?.source ?? ""), promoted?.source);

// E: reconcile must never compare a source against itself.
// Egypt's primary IS Frankfurter (no confirmed CBE scrape), so the Frankfurter cross-check
// has to be dropped — one row, not two identical ones claiming independent agreement.
const egProvider = new LiveFxProvider({
  async fetchCrossCheck(_cfg, _currency) {
    return { rate: 48.2, asOf: "2026-09-16" };
  },
});
const egRec = await egProvider.reconcileRate("EG", "EGP");
console.log("live EG reconcile ->", JSON.stringify(egRec));
check("EG does not read one source twice", egRec.official.length === 1, egRec.official);
check("EG reports no false agreement", egRec.discrepancy_flag === false);

// ...whereas Nigeria has a genuinely separate primary and cross-check: two rows.
const ngProvider = new LiveFxProvider({
  async fetchOfficial(cfg) {
    return officialFor(cfg, 1550);
  },
  async fetchCrossCheck(_cfg, _currency) {
    return { rate: 1553.1, asOf: "2026-09-16" };
  },
  async fetchParallel(cfg) {
    return { ...officialFor(cfg, 1610), quoteCurrency: "USDT" };
  },
});
const ngRec = await ngProvider.reconcileRate("NG", "NGN");
console.log("live NG reconcile ->", JSON.stringify(ngRec));
check("NG compares two independent sources", ngRec.official.length === 2, ngRec.official);
check("NG live sources are distinct", ngRec.official[0]?.source !== ngRec.official[1]?.source);
check("NG live spread is computed", ngRec.spread_pct === 3.87, ngRec.spread_pct);

// F: a successful fetch whose value is older than the threshold is still stale.
const agedIso = new Date(Date.now() - 100 * 3_600_000).toISOString();
const agedRw = await new LiveFxProvider({
  async fetchOfficial(cfg) {
    return officialFor(cfg, 1380, agedIso);
  },
}).getOfficialRate("RW");
check("a value older than the threshold is stale", agedRw.stale === true, agedRw);

// G: v1 has no parallel history source — a parallel history request must not return official data.
const liveParallelHistory = await ngProvider.getRateHistory("NG", "NGN", "parallel", "2026-09-01", "2026-09-16");
check("live parallel history is empty, not official data", liveParallelHistory.length === 0, liveParallelHistory.length);

// ===================== verdict =====================

if (failures.length > 0) {
  console.error(`\nFX SMOKE FAIL — ${failures.length} check(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\nFX SMOKE OK — all checks passed");
process.exit(0);
