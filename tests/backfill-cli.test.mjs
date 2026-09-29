import test from 'node:test';
import assert from 'node:assert/strict';
import { runBackfillCli, USAGE } from '../src/backfill-cli.mjs';
import { CONFIG, STATE, env, fakeFs, fakeReader } from './helpers.mjs';

const HOME = '/fake-home';
const ENDPOINT = 'https://api.example.com/usage';

function baseEnv(extra = {}) {
  return env({ CLAUDE_CONFIG_DIR: HOME, ...extra });
}

const noticeShown = { [STATE]: JSON.stringify({ noticeShown: true }) };

function fakeListFs(tree) {
  return {
    readdirSync(dir) {
      if (!(dir in tree)) throw new Error(`ENOENT: ${dir}`);
      return tree[dir];
    },
    statSync(dir) {
      return { isDirectory: () => dir in tree };
    },
  };
}

test('usage help lists every flag', () => {
  assert.match(USAGE, /--since/);
  assert.match(USAGE, /--force/);
});

test('--help prints usage and exits 0', async () => {
  const { text, code } = await runBackfillCli(['--help'], { env: baseEnv(), readFile: fakeReader({}), fs: fakeFs() });
  assert.equal(code, 0);
  assert.match(text, /--since/);
});

test('a bad --since value is reported as an error, not thrown', async () => {
  const { text, code } = await runBackfillCli(['--since', 'nonsense'], { env: baseEnv(), readFile: fakeReader({}), fs: fakeFs() });
  assert.equal(code, 1);
  assert.match(text, /Error: not a valid date/);
});

test('rejects an unknown flag', async () => {
  const { text, code } = await runBackfillCli(['--bogus'], { env: baseEnv(), readFile: fakeReader({}), fs: fakeFs() });
  assert.equal(code, 1);
  assert.match(text, /Unknown argument/);
});

test('parses every filter and toggle flag without error', async () => {
  const { code } = await runBackfillCli(
    ['--project', 'a', '--session', 's1', '--include-disabled', '--force', '--until', '2026-09-01'],
    { env: baseEnv(), readFile: fakeReader({}), fs: fakeFs() },
  );
  assert.equal(code, 0);
});

test('--send without --yes and no confirm callback defaults to cancelling', async () => {
  const PROJECTS = `${HOME}/projects`;
  const entry = { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } };
  const assistant = { type: 'assistant', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', requestId: 'r1', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } };
  const jsonl = [entry, assistant].map((e) => JSON.stringify(e)).join('\n');
  const files = { ...noticeShown, [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }), [`${PROJECTS}/repo/s1.jsonl`]: jsonl };
  const listFs = fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] });
  const { text, code } = await runBackfillCli(['--send'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs: fakeFs(files),
    exists: () => false,
    listFs,
    post: async () => assert.fail('must not send'),
  });
  assert.equal(code, 0);
  assert.match(text, /Cancelled/);
});

test('without --send it only previews and makes no dispatch call', async () => {
  const { text, code } = await runBackfillCli([], {
    env: baseEnv(),
    readFile: fakeReader({}),
    fs: fakeFs(),
    post: async () => assert.fail('must not send'),
  });
  assert.equal(code, 0);
  assert.match(text, /No matching turns found\./);
});

test('--send refuses with no usageEndpoint configured', async () => {
  const { text, code } = await runBackfillCli(['--send', '--yes'], {
    env: baseEnv(),
    readFile: fakeReader({}),
    fs: fakeFs(),
    post: async () => assert.fail('must not send'),
  });
  assert.equal(code, 1);
  assert.match(text, /No usageEndpoint configured/);
});

test('--send refuses before the first-run notice has ever been shown', async () => {
  const files = { [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }) };
  const { text, code } = await runBackfillCli(['--send', '--yes'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs: fakeFs(files),
    post: async () => assert.fail('must not send'),
  });
  assert.equal(code, 1);
  assert.match(text, /first-run notice has not been shown/);
});

test('--send without --yes asks for confirmation and honours "no"', async () => {
  const PROJECTS = `${HOME}/projects`;
  const entry = { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } };
  const assistant = { type: 'assistant', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', requestId: 'r1', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } };
  const jsonl = [entry, assistant].map((e) => JSON.stringify(e)).join('\n');
  const files = { ...noticeShown, [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }), [`${PROJECTS}/repo/s1.jsonl`]: jsonl };
  const fs = fakeFs(files);
  const listFs = fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] });
  let asked = false;
  const { text, code } = await runBackfillCli(['--send'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs,
    exists: () => false,
    listFs,
    post: async () => assert.fail('must not send'),
    confirm: async ({ count, host }) => { asked = true; assert.equal(count, 1); assert.equal(host, 'api.example.com'); return false; },
  });
  assert.equal(asked, true);
  assert.equal(code, 0);
  assert.match(text, /Cancelled/);
});

test('--send --yes with nothing left to send reports that and previews the skips', async () => {
  const PROJECTS = `${HOME}/projects`;
  const key = 's1:p1';
  const entry = { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } };
  const assistant = { type: 'assistant', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', requestId: 'r1', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } };
  const jsonl = [entry, assistant].map((e) => JSON.stringify(e)).join('\n');
  const files = {
    ...noticeShown,
    [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }),
    [`${PROJECTS}/repo/s1.jsonl`]: jsonl,
    [`${HOME}/claude-usage-backfill-state.json`]: JSON.stringify({ reported: { [key]: true } }),
  };
  const fs = fakeFs(files);
  const listFs = fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] });
  const { text, code } = await runBackfillCli(['--send', '--yes'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs,
    exists: () => false,
    listFs,
    post: async () => assert.fail('must not send'),
  });
  assert.equal(code, 0);
  assert.match(text, /Nothing to send\./);
});

test('--send --yes reports a failed push without needing an explicit `now`', async () => {
  const PROJECTS = `${HOME}/projects`;
  const entry = { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } };
  const assistant = { type: 'assistant', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', requestId: 'r1', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } };
  const jsonl = [entry, assistant].map((e) => JSON.stringify(e)).join('\n');
  const files = { ...noticeShown, [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }), [`${PROJECTS}/repo/s1.jsonl`]: jsonl };
  const listFs = fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] });
  const { text, code } = await runBackfillCli(['--send', '--yes'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs: fakeFs(files),
    exists: () => false,
    listFs,
    post: async () => ({ ok: false, status: 500, error: 'HTTP 500' }),
  });
  assert.equal(code, 0);
  assert.match(text, /Failed \/ queued for retry: 1/);
});

test('--send --yes pushes matching records and reports a summary', async () => {
  const PROJECTS = `${HOME}/projects`;
  const entry = { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'hi' } };
  const assistant = { type: 'assistant', promptId: 'p1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', requestId: 'r1', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } };
  const jsonl = [entry, assistant].map((e) => JSON.stringify(e)).join('\n');
  const files = { ...noticeShown, [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }), [`${PROJECTS}/repo/s1.jsonl`]: jsonl };
  const fs = fakeFs(files);
  const listFs = fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] });
  const sent = [];
  const { text, code } = await runBackfillCli(['--send', '--yes'], {
    env: baseEnv(),
    readFile: fakeReader(files),
    fs,
    exists: () => false,
    listFs,
    post: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; },
  });
  assert.equal(code, 0);
  assert.match(text, /Sent: 1/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].turn_id, 's1:p1');
});
