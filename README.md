# Africa MCP — pan-African data for AI agents

**A [Braynex Services Ltd](https://www.braynexservices.com) product.** Author: Samuel Orie. License: **MIT**.

A neutral aggregation + normalization layer that exposes **pan-African market data** to AI agents (Claude, Cursor, custom agents) as clean **MCP tools** — behind one typed provider seam, each data source family its own server ("lane"). Sibling to [nigeria-mcp](https://github.com/braynexservices/nigeria-mcp), which stays Nigeria-only.

> **Status:** 1 lane shipped (FX & Parallel Rates). `npm run verify` → build + smoke, fully offline on mocks.

## Lanes

| # | Lane | Status | Tools |
|---|---|---|---|
| 1 | **FX & Parallel Rates** — official central-bank + parallel/street rates for 7 v1 African currencies, with cross-provider reconciliation and staleness reporting | 🌐 shipped (mock-mode default; live scrapers/APIs opt-in) | 7 tools — see `lanes/fx-rates/README.md` |

v1 banks: Nigeria (CBN), Ghana (BoG), Kenya (CBK), South Africa (SARB), Tanzania (BoT), Rwanda (BNR), Egypt (CBE — scaffolded, TBD).

## Quickstart

```bash
npm install
npm run build      # builds shared/ core first, then every lane (npm workspaces)
npm run verify     # build + all smokes — fully offline, zero signup, zero network
```

Every lane defaults to a **mock** provider with deterministic fixtures, so the whole repo runs with no signup. Live providers are opt-in via env (see `.env.example`).

## Use the FX lane in Claude Desktop / Code

```jsonc
{
  "mcpServers": {
    "africa-fx-rates": {
      "command": "npx",
      "args": ["-y", "@braynexservices/africa-mcp-fx-rates"],
      "env": { "FX_PROVIDER": "live" }     // live central-bank sources, no key
    }
  }
}
```

Then ask: *"What's the official CBN USD rate and the parallel rate for Nigeria today, and do they reconcile?"*

## Architecture

| Path | What it is |
|---|---|
| `shared/` | Core MCP library — `buildServer`, normalized Zod schemas, the provider seam, `lib/{errors,normalize,cache,fetch}`. |
| `lanes/<lane>/` | One MCP server per data family — `mock` provider (default) + live adapter, tools, smoke test. |

Tools never call a source directly — selecting a provider is one env var; adding a source is one file. The moat is maintained cross-provider **reconciliation**, not aggregation: every official rate is cross-checked against an independent second source, parallel rates are layered on top and never silently blended with official ones, and stale sources degrade to last-known-good with an explicit flag instead of erroring.