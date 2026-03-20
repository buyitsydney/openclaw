/**
 * Shared time parsing utilities for all feishu-her tools.
 *
 * All tool schemas should accept ISO 8601 strings (e.g. "2026-03-19T09:00:00+08:00").
 * LLMs should NEVER be asked to compute Unix timestamps manually.
 * These helpers convert human-readable input to whatever format each Feishu API needs.
 */

/**
 * Parse any time input to Unix milliseconds.
 * Accepts: ISO 8601 string, Unix ms (number >1e12), Unix seconds (number >1e9).
 * Returns fallbackMs if value is undefined or unparseable.
 */
export function parseTime(value: string | number | undefined, fallbackMs?: number): number {
  if (value === undefined || value === null) return fallbackMs ?? Date.now();

  if (typeof value === "number") {
    // Already a number: distinguish seconds vs milliseconds
    if (value > 1e12) return Math.floor(value); // Unix ms
    if (value > 1e9) return Math.floor(value * 1000); // Unix seconds → ms
    return fallbackMs ?? Date.now();
  }

  // String: try as number first (handles "1773849600" or "1773849600000")
  const n = Number(value);
  if (!Number.isNaN(n) && n > 1e9) {
    return n > 1e12 ? Math.floor(n) : Math.floor(n * 1000);
  }

  // String: try as ISO 8601 / date string
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return d;

  return fallbackMs ?? Date.now();
}

/** Convert to Unix seconds (number) — for knowledge_qa, search APIs. */
export function toUnixSeconds(value: string | number): number {
  return Math.floor(parseTime(value) / 1000);
}

/** Convert to Unix seconds (string) — for calendar API. */
export function toUnixSecondsStr(value: string | number): string {
  return String(toUnixSeconds(value));
}

/** Convert to Unix milliseconds (string) — for task API. */
export function toUnixMsStr(value: string | number): string {
  return String(parseTime(value));
}

/** Convert to RFC 3339 UTC string — for freebusy API. */
export function toRfc3339(value: string | number): string {
  return new Date(parseTime(value)).toISOString();
}
