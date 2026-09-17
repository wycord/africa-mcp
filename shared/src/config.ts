/**
 * Environment configuration for the Africa MCP core.
 * No hardcoded secrets — everything comes from process.env. Only shipped lanes are named
 * here (this package is published publicly); any other lane reads its own var via providerKey().
 */

export interface Config {
  fxProvider: string;
  cacheTtlSeconds: number;
  /** Hours after which a daily-publishing bank's cached rate is flagged stale. Default 48 (2 business days). */
  fxStaleThresholdHours: number;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    fxProvider: env.FX_PROVIDER ?? "mock",
    cacheTtlSeconds: num(env.CACHE_TTL_SECONDS, 300),
    fxStaleThresholdHours: num(env.FX_STALE_THRESHOLD_HOURS, 48),
  };
}