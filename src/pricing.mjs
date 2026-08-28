/**
 * Cost estimation against public list price.
 *
 * On subscription plans this is an estimate for visibility only — never a
 * charge. On API-key accounts it should track billed usage closely, but this
 * plugin is still not the system of record (FRD §16).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TABLE_PATH = fileURLToPath(new URL('./pricing.json', import.meta.url));

export function loadPricing(path = TABLE_PATH, readFile = readFileSync) {
  try {
    const table = JSON.parse(readFile(path, 'utf8'));
    return table && typeof table.models === 'object' && table.models ? table.models : {};
  } catch {
    return {};
  }
}

/** Longest matching model prefix wins, so `claude-opus-5-preview` still resolves. */
export function rateFor(model, models) {
  if (!model) return null;
  let best = null;
  for (const [prefix, rate] of Object.entries(models)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, rate };
    }
  }
  return best ? best.rate : null;
}

/** @returns {number|null} estimated USD, or null when the model is unknown. */
export function estimateCost(model, tokens, models = loadPricing()) {
  const rate = rateFor(model, models);
  if (!rate) return null;
  const perToken = (count, price) => ((count || 0) * price) / 1_000_000;
  return (
    perToken(tokens.input, rate.input) +
    perToken(tokens.cache_write, rate.cache_write) +
    perToken(tokens.cache_read, rate.cache_read) +
    perToken(tokens.output, rate.output)
  );
}
