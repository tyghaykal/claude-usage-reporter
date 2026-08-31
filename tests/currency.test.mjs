import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRateCache,
  convertCost,
  formatCurrency,
  manualRate,
  needsTranslation,
  normalizeCurrency,
  resolveRate,
  resolveRateSync,
  warmRate,
} from '../src/currency.mjs';

test('normalizeCurrency uppercases and validates 3-letter codes', () => {
  assert.equal(normalizeCurrency('idr'), 'IDR');
  assert.equal(normalizeCurrency(' Usd '), 'USD');
  assert.equal(normalizeCurrency(''), 'USD');
  assert.equal(normalizeCurrency('US'), 'USD'); // not 3 letters
  assert.equal(normalizeCurrency('XXXX'), 'USD'); // not 3 letters
  assert.equal(normalizeCurrency('id1'), 'USD'); // not alpha
});

test('needsTranslation is false for USD and true otherwise', () => {
  assert.equal(needsTranslation('USD'), false);
  assert.equal(needsTranslation('usd'), false);
  assert.equal(needsTranslation('IDR'), true);
});

test('manualRate accepts only positive finite numbers', () => {
  assert.equal(manualRate(16300), 16300);
  assert.equal(manualRate('16300'), 16300);
  assert.equal(manualRate(0), null);
  assert.equal(manualRate(-5), null);
  assert.equal(manualRate('abc'), null);
  assert.equal(manualRate(''), null);
  assert.equal(manualRate(Infinity), null);
});

test('convertCost multiplies usd by rate and guards bad input', () => {
  assert.equal(convertCost(2, 16300), 32600);
  assert.equal(convertCost(0.0123, 16300), 200.49);
  assert.equal(convertCost(2, 0), null);
  assert.equal(convertCost(2, -1), null);
  assert.equal(convertCost(NaN, 16300), null);
  assert.equal(convertCost(2, NaN), null);
});

test('formatCurrency renders IDR grouped with no cents and a Rp symbol', () => {
  assert.equal(formatCurrency(32600, 'IDR'), 'Rp32,600');
  assert.equal(formatCurrency(1234567, 'IDR'), 'Rp1,234,567');
  assert.equal(formatCurrency(1.23, 'USD'), '$1.23');
  assert.equal(formatCurrency(12.5, 'EUR'), '€12.50');
  assert.equal(formatCurrency(12.5, 'XXX'), 'XXX 12.50'); // unknown code prefix
  assert.equal(formatCurrency(NaN, 'IDR'), '');
});

test('resolveRateSync returns 1 for USD and the override for a pinned rate', () => {
  clearRateCache();
  assert.equal(resolveRateSync('USD'), 1);
  assert.equal(resolveRateSync('IDR', { override: 16300 }), 16300);
});

test('resolveRateSync returns null when nothing is cached and no override', () => {
  clearRateCache();
  assert.equal(resolveRateSync('IDR'), null);
});

test('resolveRate fetches live and caches the rate', async () => {
  clearRateCache();
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ rates: { IDR: 16250 } }) };
  };
  const rate = await resolveRate('IDR', { fetchFn, now: () => 1000 });
  assert.equal(rate, 16250);
  assert.equal(calls, 1);
  // Sync resolver now sees the cached rate within the TTL.
  assert.equal(resolveRateSync('IDR', { now: () => 1001 }), 16250);
});

test('resolveRate falls back to a stale cache when the fetch fails', async () => {
  clearRateCache();
  const good = async () => ({ ok: true, json: async () => ({ rates: { IDR: 16000 } }) });
  await resolveRate('IDR', { fetchFn: good, now: () => 1000 });
  // Now past the TTL, fetch throws — we still get the stale cached rate.
  const failing = async () => { throw new Error('offline'); };
  const rate = await resolveRate('IDR', { fetchFn: failing, now: () => 1000 + 99999999 });
  assert.equal(rate, 16000);
});

test('resolveRate returns null on a bad payload and no cache', async () => {
  clearRateCache();
  const bad = async () => ({ ok: true, json: async () => ({ rates: {} }) });
  assert.equal(await resolveRate('IDR', { fetchFn: bad }), null);
  const notOk = async () => ({ ok: false });
  assert.equal(await resolveRate('IDR', { fetchFn: notOk }), null);
});

test('resolveRate honours the override without any network call', async () => {
  clearRateCache();
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new Error('should not be called'); };
  const rate = await resolveRate('IDR', { override: 15900, fetchFn });
  assert.equal(rate, 15900);
  assert.equal(calls, 0);
});

test('warmRate fills the cache in the background without throwing', async () => {
  clearRateCache();
  const fetchFn = async () => ({ ok: true, json: async () => ({ rates: { IDR: 16100 } }) });
  await warmRate('IDR', { fetchFn, now: () => 5000 });
  assert.equal(resolveRateSync('IDR', { now: () => 5001 }), 16100);
});

test('warmRate never rejects even when the fetch blows up', async () => {
  clearRateCache();
  const failing = async () => { throw new Error('offline'); };
  await assert.doesNotReject(warmRate('IDR', { fetchFn: failing }));
});
