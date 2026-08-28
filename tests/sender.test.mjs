import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, postUsage, safeTarget, sendAll } from '../src/sender.mjs';

test('safeTarget exposes only the host, never credentials in the URL', () => {
  assert.equal(safeTarget('https://user:pass@api.example.com/usage'), 'api.example.com');
  assert.equal(safeTarget('nonsense'), 'endpoint');
});

test('postUsage sends JSON with the supplied auth headers', async () => {
  let seen;
  const result = await postUsage({
    url: 'https://api.example.com/u',
    headers: { Authorization: 'Bearer tok' },
    payload: { a: 1 },
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 202 };
    },
  });
  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal(seen.url, 'https://api.example.com/u');
  assert.equal(seen.options.method, 'POST');
  assert.deepEqual(seen.options.headers, { 'content-type': 'application/json', Authorization: 'Bearer tok' });
  assert.equal(seen.options.body, '{"a":1}');
  assert.ok(seen.options.signal);
});

test('postUsage reports a non-2xx response as a failure, with the body when readable', async () => {
  const withBody = await postUsage({
    url: 'https://x/',
    payload: {},
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '  {"error":"Missing X-API-Key header"}\n' }),
  });
  assert.deepEqual(withBody, {
    ok: false,
    status: 401,
    error: 'HTTP 401',
    body: '{"error":"Missing X-API-Key header"}',
  });

  const long = await postUsage({
    url: 'https://x/',
    payload: {},
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'x'.repeat(1000) }),
  });
  assert.equal(long.body.length, 300);

  // A response with no readable body still reports the status.
  const bodiless = await postUsage({
    url: 'https://x/',
    payload: {},
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(bodiless, { ok: false, status: 503, error: 'HTTP 503', body: '' });
});

test('postUsage turns any thrown value into a failure result', async () => {
  const thrown = await postUsage({ url: 'https://x/', payload: {}, fetchImpl: async () => { throw new Error('timed out'); } });
  assert.deepEqual(thrown, { ok: false, status: 0, error: 'timed out' });

  const bare = await postUsage({ url: 'https://x/', payload: {}, fetchImpl: async () => { throw 'boom'; } });
  assert.deepEqual(bare, { ok: false, status: 0, error: 'boom' });
});

test('dispatch launches a detached child, writes the records and does not wait', () => {
  const calls = [];
  let unreffed = false;
  const child = { stdin: { end: (data) => calls.push(data) }, unref: () => { unreffed = true; } };
  const launched = dispatch([{ a: 1 }], {
    script: '/send.mjs',
    execPath: '/node',
    env: { X: '1' },
    spawnImpl: (exe, args, options) => {
      calls.push({ exe, args, options });
      return child;
    },
  });
  assert.equal(launched, true);
  assert.equal(unreffed, true);
  assert.equal(calls[0].exe, '/node');
  assert.deepEqual(calls[0].args, ['/send.mjs']);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(calls[1], '[{"a":1}]');
});

test('dispatch reports failure rather than throwing into the hook', () => {
  assert.equal(dispatch([], { script: '/s.mjs', spawnImpl: () => { throw new Error('no fork'); } }), false);
});

test('sendAll delivers every record and routes failures to onFailure', async () => {
  const failures = [];
  const result = await sendAll([{ id: 1 }, { id: 2 }, { id: 3 }], {
    url: 'https://x/',
    headers: {},
    timeoutMs: 10,
    retry: true,
    onFailure: (record, outcome, retry) => failures.push({ record, outcome, retry }),
    post: async ({ payload }) => (payload.id === 2 ? { ok: false, status: 500, error: 'HTTP 500' } : { ok: true, status: 200 }),
  });
  assert.deepEqual(result, { sent: 2, failed: 1 });
  assert.deepEqual(failures.map((f) => f.record.id), [2]);
  assert.equal(failures[0].retry, true);
});
