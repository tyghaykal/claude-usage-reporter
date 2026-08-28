import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, loadPricing, rateFor } from '../src/pricing.mjs';
import { fakeReader } from './helpers.mjs';

test('loadPricing reads the shipped table', () => {
  const models = loadPricing();
  assert.ok(models['claude-sonnet-5']);
  assert.ok(models['claude-opus-5']);
});

test('loadPricing degrades to an empty table rather than throwing', () => {
  assert.deepEqual(loadPricing('/missing', fakeReader({})), {});
  assert.deepEqual(loadPricing('/p.json', fakeReader({ '/p.json': '{oops' })), {});
  assert.deepEqual(loadPricing('/p.json', fakeReader({ '/p.json': '{"x":1}' })), {});
  assert.deepEqual(loadPricing('/p.json', fakeReader({ '/p.json': '{"models":null}' })), {});
});

test('rateFor picks the longest matching prefix', () => {
  const models = { 'claude-haiku': { input: 1 }, 'claude-haiku-4-5': { input: 2 } };
  assert.equal(rateFor('claude-haiku-4-5-20251001', models).input, 2);
  assert.equal(rateFor('claude-unknown-9', models), null);
  assert.equal(rateFor('', models), null);
});

test('estimateCost prices each token class separately', () => {
  const models = { m: { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 } };
  const cost = estimateCost('m', { input: 1e6, cache_write: 1e6, cache_read: 1e6, output: 1e6 }, models);
  assert.equal(Number(cost.toFixed(2)), 22.05);
});

test('estimateCost returns null for an unknown model and ignores absent classes', () => {
  assert.equal(estimateCost('nope', { input: 10 }, { m: { input: 1 } }), null);
  assert.equal(estimateCost('m', { input: 1e6 }, { m: { input: 3, cache_write: 1, cache_read: 1, output: 1 } }), 3);
});

test('estimateCost defaults to the shipped table', () => {
  assert.ok(estimateCost('claude-sonnet-5', { output: 1e6 }) > 0);
});
