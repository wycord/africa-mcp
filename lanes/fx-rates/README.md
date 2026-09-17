# Pan-African FX & Parallel Rates MCP

**A [Braynex Services Ltd](https://www.braynexservices.com) product.** License: MIT. Part of [africa-mcp](https://github.com/wycord/africa-mcp).

Official **central-bank** exchange rates and **parallel/street-market** rates for 7 v1 African currencies, in one MCP — with cross-provider reconciliation and explicit staleness reporting. The moat is maintained reconciliation, not aggregation: every official rate is cross-checked against an independent second source, parallel rates are layered on top and never silently blended with official ones.

> Parallel rates are **market observation only**, labeled by source. They are not "the real rate" and this server never advises away from official channels.

## Tools (7)

| Tool | What it does |
|---|---|
| `list_currencies` | Covered countries: ISO code, central bank, v1/expansion coverage, official/parallel availability |
| `get_official_rate` | Official central-bank rate (default vs USD). Degrades to last-known-good with `stale: true` instead of erroring |
| `get_parallel_rate` | Parallel/street rate where a source exists; `{ available: false, reason: "no_parallel_source" }` otherwise |
| `get_rate_history` | Daily official/parallel history between two dates |
| `convert` | Convert an amount at the official (default) or parallel rate |
| `reconcile_rate` | Official (direct + independent cross-check) + parallel rates, `spread_pct`, discrepancy flags |
| `get_rate_status` | Per-source health: `docs_status`, last successful fetch, age, staleness threshold |

## v1 coverage

| Country | Currency | Bank | Source | Parallel |
|---|---|---|---|---|
| 🇳🇬 NG | NGN | CBN | Scrape (`cbn.gov.ng`) + Frankfurter cross-check | Quidax USDT/NGN (free, no auth) |
| 🇬🇭 GH | GHS | Bank of Ghana | Scrape + OpenDataForAfrica cross-check | — |
| 🇰🇪 KE | KES | CBK | Scrape + Frankfurter cross-check | — |
| 🇿🇦 ZA | ZAR | SARB | Web API (contract being confirmed) + Frankfurter cross-check | — |
| 🇹🇿 TZ | TZS | Bank of Tanzania | Scrape + Frankfurter cross-check | — |
| 🇷🇼 RW | RWF | National Bank of Rwanda | **Official API** (`fxrates.bnr.rw`) | — |
| 🇪🇬 EG | EGP | Central Bank of Egypt | TBD — direct scrape scaffolded only, pending source verification | — |

Expansion (not built yet): UGX (BoU), ZMW (BoZ), MAD (BAM), ETB (NBE), XOF (BCEAO — one build covers 8 countries).

## Reconciliation checks

1. **Cross-provider discrepancy** — direct source vs an independent second source (Frankfurter.dev / OpenDataForAfrica); flagged when the delta exceeds 1% (per-currency configurable).
2. **Spread anomaly** — official-vs-parallel spread vs the 30-day rolling median; `ABNORMAL_SPREAD` beyond 2× the median.
3. **Staleness** — per-source `docs_status` (LIVE/BROKEN/UNAVAILABLE/SHUT_DOWN); stale sources serve last-known-good with `stale: true`; 3 consecutive failures auto-promote the cross-check to primary. The service degrades and discloses rather than going down.

## Quickstart

```bash
npm install
npm run smoke     # in-memory end-to-end test of all 7 tools — offline, zero signup
```

Defaults to a **mock** provider with deterministic fixtures. Live mode (no API key required):

```bash
FX_PROVIDER=live npm run start:stdio
```

## Claude Desktop / Code

```jsonc
{
  "mcpServers": {
    "africa-fx-rates": {
      "command": "npx",
      "args": ["-y", "@braynexservices/africa-mcp-fx-rates"],
      "env": { "FX_PROVIDER": "live" }
    }
  }
}
```

Then ask: *"Reconcile the Nigerian naira: official CBN rate, parallel rate, and any discrepancy."*

## Scraping politeness

One fetch per source per publish cadence, custom Wycord User-Agent with a contact address, jittered capped retries, robots.txt respected, and last-known-good caching so a down source degrades instead of failing tool calls. Scrapers are config-driven (`src/sources/config.ts`) — a site redesign is a config diff, not a code rewrite.