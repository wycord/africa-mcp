/**
 * Normalization helpers. Lane adapters map raw provider payloads into the schemas in
 * schemas.ts and stamp provenance via these helpers.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Stamp source + retrievedAt onto a normalized record. */
export function stamp<T extends object>(
  record: T,
  source: string,
): T & { source: string; retrievedAt: string } {
  return { ...record, source, retrievedAt: nowIso() };
}

/**
 * Hours elapsed since an ISO timestamp (0 when the timestamp is in the future).
 *
 * An unparseable timestamp returns Infinity, not NaN: staleness checks compare with `>`,
 * and NaN makes every such comparison false, which would silently report a rate of unknown
 * age as fresh. Money data fails closed — no provenance means maximally stale.
 */
export function ageHours(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  const ms = Date.now() - parsed;
  return ms <= 0 ? 0 : ms / 3_600_000;
}

/** True when a fetched-at timestamp is older than thresholdHours (or unparseable). */
export function isStale(fetchedAtIso: string, thresholdHours: number): boolean {
  return ageHours(fetchedAtIso) > thresholdHours;
}