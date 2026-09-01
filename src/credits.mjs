/**
 * Live credits attribution from the amanai usage log.
 *
 * The amanai API returns the *exact* credit cost of every request at
 * `GET https://api.amanai.dev/v1/usage` (with the amanai API key), both as
 * account-level totals (`credit_used` / `credit_remaining`) and as a per-request
 * `recent[]` array where each entry carries its own `credits` figure.
 *
 * There is no public multiplier catalog (the models list carries no pricing),
 * so the accurate source of truth for "how many credits did this actually
 * cost" is the live usage log — this module reads it and attributes the real
 * credit cost to a local usage entry by matching model + token counts.
 *
 * Network is never allowed to block a prompt report: any fetch failure degrades
 * to "unknown credits" and the USD list-price estimate is still shown.
 */

const USAGE_URL = 'https://api.amanai.dev/v1/usage';

/** Short-lived cache so we don't hammer the usage endpoint per prompt. */
const cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60 * 1000; // 1 minute — usage log updates in near-real-time

/**
 * Fetches the amanai usage snapshot. Returns `null` on any failure (offline,
 * bad key, non-2xx, malformed JSON) so callers never have to handle throws.
 *
 * @param {string} apiKey amanai API key (required; Authorization: Bearer).
 * @returns {Promise<object|null>} the parsed `/v1/usage` body, or null.
 */
export async function fetchUsage(apiKey, { fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  if (!apiKey) return null;

  if (cache.data && now() - cache.fetchedAt < CACHE_TTL_MS) return cache.data;

  if (typeof fetchFn !== 'function') return cache.data;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchFn(USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res || !res.ok) return cache.data;
    const body = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray(body.recent)) return cache.data;
    cache.data = body;
    cache.fetchedAt = now();
    return body;
  } catch {
    return cache.data; // offline / aborted / bad JSON — stale cache or null
  }
}

/** Clears the in-memory usage cache (used by tests). */
export function clearUsageCache() {
  cache.data = null;
  cache.fetchedAt = 0;
}

/**
 * Synchronously reads the current in-memory usage snapshot, or null if none is
 * cached yet. Used by the report path to attribute credits WITHOUT awaiting a
 * network fetch (the Claude hook must never block on I/O).
 */
export function peekUsageCache() {
  return cache.data;
}

/**
 * Finds the amanai usage entry whose token profile matches a local request.
 *
 * Matching is on (public_model, input_tokens, output_tokens, cache_read_tokens)
 * because those are the fields both sides report. A model-normalized prefix
 * match plus exact token equality gives the correct attribution; if nothing
 * matches (e.g. the log window rolled over) we return null.
 *
 * @param {object} usage the parsed `/v1/usage` body (or null).
 * @param {string} model local model id (may be bare, e.g. `claude-sonnet-5`).
 * @param {object} tokens `{ input, output, cache_read }`.
 * @returns {number|null} the exact credits for the matched request, or null.
 */
export function findCredits(usage, model, tokens) {
  if (!usage || !Array.isArray(usage.recent) || !tokens) return null;
  const want = {
    input: Number(tokens.input) || 0,
    output: Number(tokens.output) || 0,
    cache_read: Number(tokens.cache_read) || 0,
  };
  const base = String(model || '').toLowerCase();
  // Try exact model match first, then a "endsWith / contains" match so a local
  // bare model id still resolves against the amanai `amanai/<vendor>-<model>`.
  const matches = usage.recent.filter((r) => {
    const m = String(r.public_model || '').toLowerCase();
    const modelOk = m === base || m.endsWith('/' + base) || m.includes(base);
    if (!modelOk) return false;
    return (
      (Number(r.input_tokens) || 0) === want.input &&
      (Number(r.output_tokens) || 0) === want.output &&
      (Number(r.cache_read_tokens) || 0) === want.cache_read
    );
  });
  if (matches.length === 0) return null;
  // Multiple identical token counts within TTL — prefer the most recent.
  matches.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return Number(matches[0].credits) || null;
}

/** Human-readable integer with thousands separators. */
export function formatCredits(n) {
  if (!Number.isFinite(n)) return '';
  return Number(n).toLocaleString('en-US');
}

/** Account-level credit line, or null when the usage snapshot is unavailable. */
export function accountCredits(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const used = usage.credit_used;
  const remaining = usage.credit_remaining;
  if (used === undefined && remaining === undefined) return null;
  return {
    used: Number.isFinite(Number(used)) ? Number(used) : undefined,
    remaining: Number.isFinite(Number(remaining)) ? Number(remaining) : undefined,
  };
}
