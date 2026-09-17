/**
 * @braynexservices/africa-mcp-fx-rates — FX & Parallel Rates lane. Exposes its tools +
 * providers for composition into the combined server (and for direct use via stdio).
 */
export { fxTools } from "./tools.js";
export { getFxProvider } from "./provider.js";
export { MockFxProvider } from "./providers/mock.js";
export { LiveFxProvider, type LiveFxDeps } from "./providers/live.js";
export { BANKS, bankFor, type BankConfig } from "./currencies.js";
export {
  OFFICIAL_SOURCES,
  PARALLEL_SOURCES,
  CROSS_CHECKS,
  PLAUSIBLE_RANGE,
  assertPlausibleRate,
  type SourceConfig,
} from "./sources/config.js";
export {
  checkDiscrepancy,
  checkSpreadAnomaly,
  mergeFlags,
  median,
  spreadBaselineFrom,
  spreadPct,
  snapshotIsStale,
  type SpreadBaseline,
  type ReconcileFlags,
} from "./reconcile.js";
export {
  OFFICIAL_FIXTURES,
  PARALLEL_FIXTURES,
  CROSS_CHECK_FIXTURES,
  officialHistory,
  parallelHistory,
  FIXTURE_DATE,
  type FixtureRate,
} from "./fixtures.js";