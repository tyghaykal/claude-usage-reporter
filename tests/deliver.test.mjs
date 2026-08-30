import test from 'node:test';
import assert from 'node:assert/strict';
import { deliver } from '../src/deliver.mjs';
import { CONFIG, LOG, QUEUE, env, fakeFs, fakeReader } from './helpers.mjs';

const ENDPOINT = 'https://api.example.com/usage';

const setup = (settings = {}, files = {}) => ({
  env: env(),
  readFile: fakeReader({ [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT, ...settings }) }),
  fs: fakeFs(files),
  now: () => new Date('2026-08-28T10:15:00Z'),
});

test('deliver posts each record with the configured auth headers', async () => {
  const deps = setup({ usageAuthType: 'Key Pair', usageKeyIdValue: 'id', usageKeySecretValue: 'sec' });
  const seen = [];
  const result = await deliver([{ a: 1 }, { a: 2 }], {
    ...deps,
    post: async (args) => {
      seen.push(args);
      return { ok: true, status: 202 };
    },
  });
  assert.deepEqual(result, { sent: 2, failed: 0, skipped: false });
  assert.equal(seen[0].url, ENDPOINT);
  assert.deepEqual(seen[0].headers, { 'X-API-Key-Id': 'id', 'X-API-Key-Secret': 'sec' });
  assert.equal(seen[0].timeoutMs, 5000);
});

test('deliver queues everything when the endpoint was cleared meanwhile', async () => {
  const deps = { env: env(), readFile: fakeReader({}), fs: fakeFs(), now: () => new Date() };
  const result = await deliver([{ a: 1 }], { ...deps, post: async () => assert.fail('must not send') });
  assert.deepEqual(result, { sent: 0, failed: 1, skipped: true });
  assert.match(deps.fs.files.get(QUEUE), /"a":1/);
});

test('deliver flushes the retry queue ahead of new records', async () => {
  const deps = setup({}, { [QUEUE]: '{"old":true}\n' });
  const order = [];
  await deliver([{ fresh: true }], {
    ...deps,
    post: async ({ payload }) => {
      order.push(payload);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(order, [{ old: true }, { fresh: true }]);
  assert.equal(deps.fs.files.get(QUEUE), '');
});

test('deliver leaves the queue alone when retry is disabled', async () => {
  const deps = setup({ usageRetry: false }, { [QUEUE]: '{"old":true}\n' });
  const sent = [];
  await deliver([{ fresh: true }], {
    ...deps,
    post: async ({ payload }) => {
      sent.push(payload);
      return { ok: false, status: 500, error: 'HTTP 500' };
    },
  });
  assert.deepEqual(sent, [{ fresh: true }]);
  assert.equal(deps.fs.files.get(QUEUE), '{"old":true}\n');
  assert.match(deps.fs.files.get(LOG), /push to api\.example\.com failed: HTTP 500/);
  assert.doesNotMatch(deps.fs.files.get(LOG), /queued for retry/);
});

test('deliver re-queues a failed record and logs the host, never the URL', async () => {
  const deps = setup({ usageEndpoint: 'https://user:pass@api.example.com/usage' });
  await deliver([{ a: 1 }], { ...deps, post: async () => ({ ok: false, status: 0, error: 'ETIMEDOUT' }) });
  assert.match(deps.fs.files.get(QUEUE), /"a":1/);
  const log = deps.fs.files.get(LOG);
  assert.match(log, /push to api\.example\.com failed: ETIMEDOUT — queued for retry/);
  assert.doesNotMatch(log, /pass/);
});

test('deliver logs config and auth warnings for later inspection', async () => {
  const { now, ...deps } = setup({ usageDisplay: 'loud', usageAuthType: 'Bearer' });
  await deliver([{ a: 1 }], { ...deps, post: async () => ({ ok: true, status: 200 }) });
  const log = deps.fs.files.get(LOG);
  assert.match(log, /Unknown usageDisplay/);
  assert.match(log, /usageAuthToken is not set/);
});

test('deliver routes each project to its own endpoint and auth', async () => {
  const deps = setup({
    usageProjects: {
      client: { usageEndpoint: 'https://client.example/usage', usageAuthType: 'Bearer', usageAuthToken: 'sk-client' },
    },
  });
  const seen = [];
  const result = await deliver(
    [{ project: 'client', a: 1 }, { project: 'other', a: 2 }],
    { ...deps, post: async (args) => { seen.push(args); return { ok: true, status: 200 }; } },
  );
  assert.deepEqual(result, { sent: 2, failed: 0, skipped: false });
  const client = seen.find((s) => s.payload.project === 'client');
  const other = seen.find((s) => s.payload.project === 'other');
  assert.equal(client.url, 'https://client.example/usage');
  assert.deepEqual(client.headers, { Authorization: 'Bearer sk-client' });
  assert.equal(other.url, ENDPOINT);
  assert.deepEqual(other.headers, {});
});

test('deliver holds only the records for a project with no endpoint, and sends the rest', async () => {
  const deps = setup({ usageProjects: { internal: { usageEndpoint: '' } } });
  const sent = [];
  const result = await deliver(
    [{ project: 'internal', a: 1 }, { project: 'other', a: 2 }],
    { ...deps, post: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; } },
  );
  assert.deepEqual(result, { sent: 1, failed: 1, skipped: true });
  assert.deepEqual(sent, [{ project: 'other', a: 2 }]);
  assert.match(deps.fs.files.get(QUEUE), /"project":"internal"/);
});

test('deliver tolerates a malformed queue entry with no project field', async () => {
  const deps = setup({}, { [QUEUE]: 'null\n' });
  const sent = [];
  const result = await deliver([{ project: 'other', a: 1 }], {
    ...deps,
    post: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; },
  });
  assert.deepEqual(result, { sent: 2, failed: 0, skipped: false });
  assert.deepEqual(sent, [null, { project: 'other', a: 1 }]);
});

test('deliver runs on real defaults without arguments', async () => {
  const result = await deliver([], { env: env(), readFile: fakeReader({}), fs: fakeFs() });
  assert.equal(result.skipped, true);
});
