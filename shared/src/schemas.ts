/**
 * Normalized, agent-facing data contracts. The SAME shape is returned regardless of
 * which upstream source served the request — this stability is the product.
 * This package is published publicly: it carries contracts for the lanes it ships with.
 */
import { z } from "zod";

// ---------- FX & parallel rates ----------

/** Lifecycle of a data source, mirroring the registry's docs_status semantics. */
export const DocsStatus = z.enum(["LIVE", "BROKEN", "UNAVAILABLE", "SHUT_DOWN"]);
export type DocsStatus = z.infer<typeof DocsStatus>;

/** One observed exchange rate: 1 {quote} = {rate} {base} (e.g. 1 USD = 1550 NGN). */
export const OfficialRate = z.object({
  country: z.string().describe("ISO-2 country code, e.g. NG"),
  currency: z.string().describe("Local currency ISO-4217 code, e.g. NGN"),
  quoteCurrency: z.string().describe("Quote currency ISO-4217 code, e.g. USD"),
  rate: z.number().describe("Units of local currency per 1 quote currency"),
  source: z.string().describe("Which source served this rate (e.g. 'bnr', 'frankfurter', 'mock')"),
  asOf: z.string().describe("The rate's publication date (ISO-8601, from the source)"),
  fetchedAt: z.string().describe("ISO-8601 timestamp when this rate was fetched"),
  stale: z.boolean().describe("True when served from last-known-good cache past the staleness threshold"),
});
export type OfficialRate = z.infer<typeof OfficialRate>;

/** A parallel/street-market rate observation — market observation only, labeled by source. */
export const ParallelRate = z.object({
  country: z.string(),
  currency: z.string(),
  quoteCurrency: z.string(),
  rate: z.number(),
  source: z.string(),
  asOf: z.string(),
  fetchedAt: z.string(),
  stale: z.boolean(),
});
export type ParallelRate = z.infer<typeof ParallelRate>;

/** Per-source health, surfaced by get_rate_status. */
export const SourceStatus = z.object({
  source: z.string(),
  docs_status: DocsStatus,
  last_successful_fetch: z.string().describe("ISO-8601 timestamp of the last successful fetch"),
  age_hours: z.number(),
  stale_threshold_hours: z.number(),
});
export type SourceStatus = z.infer<typeof SourceStatus>;