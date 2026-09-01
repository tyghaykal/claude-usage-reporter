import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountCredits,
  clearUsageCache,
  fetchUsage,
  findCredits,
  formatCredits,
  peekUsageCache,
} from '../src/credits.mjs';

const SAMPLE_USAGE = {
  key_prefix: '***',
  credit_used: 123456,
  credit_remaining: 595453231,
  recent: [
    { ts: 200, public_model: 'amanai/deepseek-v4-flash', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, credits: 1313 },
    { ts: 100, public_model: 'amanai/deepseek-v4-flash', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, credits: 999 },
    { ts: 50, public_model: 'amanai/glm-5.3', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, credits: 42 },
  ],
};

test('fetchUsage returns null without an api key', async () => {
  clearUsageCache();
  assert.equal(await fetchUsage(''), null);
  assert.equal(await fetchUsage(undefined), null);
});

test('fetchUsage parses a valid /v1/usage body and caches it', async () => {
  clearUsageCache();
  let calls = 0;
  const fetchFn = async () => { calls += 1; return { ok: true, json: async () => SAMPLE_USAGE }; };
  const body = await fetchUsage('sk-test', { fetchFn, now: () => 1000 });
  assert.equal(body, SAMPLE_USAGE);
  assert.equal(calls, 1);
  // Now cached — peek returns it without another call.
  assert.equal(peekUsageCache(), SAMPLE_USAGE);
  assert.equal(await fetchUsage('sk-test', { fetchFn, now: () => 1001 }), SAMPLE_USAGE);
  assert.equal(calls, 1);
});

test('fetchUsage tolerates offline / bad key / malformed JSON', async () => {
  clearUsageCache();
  const throwFn = async () => { throw new Error('offline'); };
  assert.equal(await fetchUsage('sk', { fetchFn: throwFn }), null);
  const badKey = async () => ({ ok: false });
  assert.equal(await fetchUsage('sk', { fetchFn: badKey }), null);
  const badJson = async () => ({ ok: true, json: async () => ({ foo: 1 }) }); // no recent[]
  assert.equal(await fetchUsage('sk', { fetchFn: badJson }), null);
});

test('fetchUsage returns stale cache on a later failure', async () => {
  clearUsageCache();
  const good = async () => ({ ok: true, json: async () => SAMPLE_USAGE });
  await fetchUsage('sk', { fetchFn: good, now: () => 1000 });
  const bad = async () => { throw new Error('down'); };
  // Within TTL the cache is served by the wrapper anyway; simulate past TTL by
  // a fresh fetch that fails — should still surface the cached data.
  assert.equal(await fetchUsage('sk', { fetchFn: bad, now: () => 1000 + 999999 }), SAMPLE_USAGE);
});

test('findCredits matches exact model + token profile, most recent wins', () => {
  const c = findCredits(SAMPLE_USAGE, 'deepseek-v4-flash', { input: 1000, output: 500, cache_read: 0 });
  assert.equal(c, 1313); // most recent (ts 200)
  const c2 = findCredits(SAMPLE_USAGE, 'amanai/deepseek-v4-flash', { input: 1000, output: 500, cache_read: 0 });
  assert.equal(c2, 1313);
});

test('findCredits returns null when nothing matches or usage is null', () => {
  assert.equal(findCredits(null, 'x', { input: 1 }), null);
  assert.equal(findCredits({}, 'x', { input: 1 }), null);
  assert.equal(findCredits(SAMPLE_USAGE, 'deepseek-v4-flash', { input: 1, output: 1, cache_read: 0 }), null);
  assert.equal(findCredits(SAMPLE_USAGE, 'unknown-model', { input: 1000, output: 500, cache_read: 0 }), null);
});

test('formatCredits renders integer grouping and tolerates bad input', () => {
  assert.equal(formatCredits(1313), '1,313');
  assert.equal(formatCredits(595453231), '595,453,231');
  assert.equal(formatCredits(NaN), '');
});

test('accountCredits extracts used/remaining or null', () => {
  assert.deepEqual(accountCredits(SAMPLE_USAGE), { used: 123456, remaining: 595453231 });
  assert.equal(accountCredits(null), null);
  assert.equal(accountCredits({ foo: 1 }), null);
});
