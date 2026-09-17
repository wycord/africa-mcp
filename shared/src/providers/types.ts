/**
 * The provider seam — the moat. Tools depend on these interfaces, never on a concrete
 * provider. Selecting/swapping a provider is one env var; adding one is one new file.
 * This package is published publicly: it carries interfaces for the lanes it ships with.
 */
import type { OfficialRate, ParallelRate, SourceStatus, DocsStatus } from "../schemas.js";

export interface CurrencyCoverage {
  country: string;
  iso_code: string;
  bank: string;
  coverage: "v1" | "expansion";
  official_available: boolean;
  parallel_available: boolean;
}

export interface RateHistoryPoint {
  date: string;
  rate: number;
  source: string;
}

export interface RateSnapshot {
  rate: number;
  source: string;
  as_of: string;
  fetched_at: string;
  stale: boolean;
}

export interface ReconcileResult {
  official: Array<{ source: string; rate: number; as_of: string }>;
  parallel: Array<{ source: string; rate: number; as_of: string }>;
  spread_pct: number;
  discrepancy_flag: boolean;
  discrepancy_reason: string | null;
}

/**
 * FX & parallel-rates provider. One implementation serves a whole country (or the mock
 * serves all countries). Live implementations compose per-bank scrapers/API clients.
 * READ-ONLY by design — observation only, never advice.
 */
export interface FxProvider {
  readonly name: string;
  listCurrencies(): Promise<CurrencyCoverage[]>;
  getOfficialRate(country: string, quoteCurrency?: string): Promise<RateSnapshot>;
  getParallelRate(country: string, quoteCurrency?: string): Promise<RateSnapshot | { available: false; reason: "no_parallel_source" }>;
  getRateHistory(country: string, currency: string, rateType: "official" | "parallel", startDate: string, endDate: string): Promise<RateHistoryPoint[]>;
  reconcileRate(country: string, currency: string): Promise<ReconcileResult>;
  getRateStatus(country?: string): Promise<SourceStatus[]>;
}