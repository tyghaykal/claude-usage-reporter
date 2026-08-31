/**
 * Live currency translation for the cost estimate.
 *
 * The price table is in USD (FRD §16). This module converts that estimate into
 * the user's display currency (e.g. IDR) using a live exchange rate, with:
 *   - a manual override (`usageCurrencyRate`) that always wins when set,
 *   - a short-lived in-process cache so we never hammer the FX API,
 *   - a graceful offline fallback: when no rate can be fetched we simply omit
 *     the translated figure and keep showing USD (never block a report).
 *
 * Rate semantics: `rate` is "how many <currency> per 1 USD". So
 * `usd * rate = amount in <currency>` (e.g. 1 USD ≈ 16,300 IDR → rate 16300).
 */

/** Free, key-less FX endpoint. `base` is always USD here. */
const FX_URL = (currency) =>
  `https://api.exchangerate.host/latest?base=USD&symbols=${encodeURIComponent(currency)}`;

/** In-process cache: currency -> { rate, fetchedAt }. */
const rateCache = new Map();

/** Rates are considered fresh for this long; FX barely moves intra-hour. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CODE_RE = /^[A-Za-z]{3}$/;

/**
 * Normalises a currency code. Returns the 3-letter uppercase code, or 'USD'
 * (the no-translation default) for anything invalid.
 */
export function normalizeCurrency(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === '' ) return 'USD';
  return CODE_RE.test(raw) ? raw : 'USD';
}

/** Whether this currency needs translation (anything other than USD). */
export function needsTranslation(currency) {
  return normalizeCurrency(currency) !== 'USD';
}

/**
 * A positive manual rate override, or null when unset/invalid. The override is
 * authoritative: a user who knows their bank/settlement rate can pin it and we
 * never touch the network for that currency.
 */
export function manualRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolves the USD→currency rate.
 *
 * Order of precedence:
 *   1. `override` (usageCurrencyRate) when it is a positive number,
 *   2. a fresh cached rate,
 *   3. a live fetch (cached on success),
 *   4. `null` when nothing is available (caller shows USD only).
 *
 * `fetchFn` and `now` are injectable for tests; production uses global fetch.
 *
 * @returns {Promise<number|null>} units of `currency` per 1 USD, or null.
 */
export async function resolveRate(currency, { override = null, fetchFn = globalThis.fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  const code = normalizeCurrency(currency);
  if (code === 'USD') return 1;

  const pinned = manualRate(override);
  if (pinned !== null) return pinned;

  const cached = rateCache.get(code);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rate;

  if (typeof fetchFn !== 'function') return cached ? cached.rate : null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchFn(FX_URL(code), { signal: controller.signal });
    clearTimeout(timer);
    if (!res || !res.ok) return cached ? cached.rate : null;
    const body = await res.json();
    const rate = body && body.rates ? Number(body.rates[code]) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) return cached ? cached.rate : null;
    rateCache.set(code, { rate, fetchedAt: now() });
    return rate;
  } catch {
    // Offline / aborted / bad JSON — fall back to any stale cache, else omit.
    return cached ? cached.rate : null;
  }
}

/** Clears the in-process rate cache (used by tests). */
export function clearRateCache() {
  rateCache.clear();
}

/**
 * Synchronous rate for the display path. Returns the manual override, else a
 * fresh cached rate, else `null` (caller shows USD only). Never touches the
 * network — see `warmRate` for the non-blocking fetch that fills the cache.
 *
 * Hooks run per-prompt and must never block on I/O, so the report path uses
 * this sync resolver and kicks off `warmRate` in the background for next time.
 */
export function resolveRateSync(currency, { override = null, now = Date.now } = {}) {
  const code = normalizeCurrency(currency);
  if (code === 'USD') return 1;
  const pinned = manualRate(override);
  if (pinned !== null) return pinned;
  const cached = rateCache.get(code);
  return cached && now() - cached.fetchedAt < CACHE_TTL_MS ? cached.rate : null;
}

/**
 * Kicks off a background live fetch to (re)fill the cache, without awaiting
 * it. Safe to call fire-and-forget; errors are swallowed (offline → stale
 * cache or USD-only). Returns the promise so tests can await it if they want.
 */
export function warmRate(currency, options = {}) {
  const code = normalizeCurrency(currency);
  if (code === 'USD') return Promise.resolve(1);
  const cached = rateCache.get(code);
  const now = options.now || Date.now;
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.rate);
  const promise = resolveRate(code, options).catch(() => (cached ? cached.rate : null));
  // Never let an unhandled rejection surface from a fire-and-forget warm.
  promise.catch(() => {});
  return promise;
}

/**
 * Converts a USD estimate into `currency` at `rate`.
 * @returns {number|null} the converted amount, or null if inputs are unusable.
 */
export function convertCost(usd, rate) {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return null;
  return usd * rate;
}

/** Currencies we render with a dedicated symbol instead of the ISO code. */
const SYMBOLS = {
  IDR: 'Rp',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  SGD: 'S$',
};

/**
 * Human-readable amount in a currency. IDR-style currencies (large numbers, no
 * cents) are grouped with the locale's thousands separator and no fraction;
 * small-unit currencies keep two decimals.
 */
export function formatCurrency(amount, currency) {
  const code = normalizeCurrency(currency);
  if (!Number.isFinite(amount)) return '';
  const zeroDecimal = code === 'IDR' || code === 'JPY';
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  });
  const symbol = SYMBOLS[code];
  return symbol ? `${symbol}${formatted}` : `${code} ${formatted}`;
}
