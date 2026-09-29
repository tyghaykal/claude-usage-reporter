import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillStatePath,
  collectRecords,
  formatPreview,
  listTranscriptFiles,
  markReported,
  parseBound,
  projectsDir,
  sendRecords,
  turnKey,
} from '../src/backfill.mjs';
import { CONFIG, env, fakeFs, fakeReader } from './helpers.mjs';

const HOME = '/fake-home';
const PROJECTS = `${HOME}/projects`;

/** A minimal listTranscriptFiles-compatible fake fs over a { dir: [names] } tree. */
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

function turnEntries({ sessionId, cwd, promptId, timestamp, prompt = 'hi', usages = [], model = 'claude-sonnet-5' }) {
  const entries = [
    { type: 'user', promptSource: 'typed', promptId, sessionId, cwd, timestamp, message: { content: prompt } },
  ];
  usages.forEach((usage, i) => {
    entries.push({
      type: 'assistant',
      promptId,
      sessionId,
      cwd,
      timestamp,
      requestId: `req-${promptId}-${i}`,
      message: { model, usage },
    });
  });
  return entries;
}

const USAGE_A = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 };

function baseEnv(extra = {}) {
  return env({ CLAUDE_CONFIG_DIR: HOME, ...extra });
}

test('projectsDir respects CLAUDE_CONFIG_DIR', () => {
  assert.equal(projectsDir(baseEnv()), PROJECTS);
});

test('projectsDir falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
  assert.match(projectsDir({}), /\.claude\/projects$/);
});

test('parseBound treats a bare --until date as the end of that day, local time', () => {
  const since = parseBound('2026-09-01', false);
  const until = parseBound('2026-09-01', true);
  assert.ok(until > since);
  assert.equal(new Date(until).getHours(), 23);
});

test('parseBound rejects an unparseable date', () => {
  assert.throws(() => parseBound('not-a-date'), /not a valid date/);
});

test('listTranscriptFiles walks one level of project directories', () => {
  const fs = fakeListFs({
    [PROJECTS]: ['repo-a', 'repo-b'],
    [`${PROJECTS}/repo-a`]: ['s1.jsonl', 'notes.txt'],
    [`${PROJECTS}/repo-b`]: ['s2.jsonl'],
  });
  const files = listTranscriptFiles(baseEnv(), fs);
  assert.deepEqual(files.sort(), [`${PROJECTS}/repo-a/s1.jsonl`, `${PROJECTS}/repo-b/s2.jsonl`].sort());
});

test('listTranscriptFiles returns nothing when the projects dir does not exist', () => {
  assert.deepEqual(listTranscriptFiles(baseEnv(), fakeListFs({})), []);
});

test('listTranscriptFiles skips an entry that is not a directory or cannot be read', () => {
  const fs = {
    readdirSync(dir) {
      if (dir === PROJECTS) return ['repo-a', 'not-a-dir', 'unreadable'];
      if (dir === `${PROJECTS}/repo-a`) return ['s1.jsonl'];
      throw new Error('ENOENT');
    },
    statSync(dir) {
      if (dir === `${PROJECTS}/not-a-dir`) return { isDirectory: () => false };
      if (dir === `${PROJECTS}/unreadable`) return { isDirectory: () => true };
      return { isDirectory: () => true };
    },
  };
  assert.deepEqual(listTranscriptFiles(baseEnv(), fs), [`${PROJECTS}/repo-a/s1.jsonl`]);
});

test('listTranscriptFiles skips an entry whose stat call throws', () => {
  const fs = {
    readdirSync(dir) {
      if (dir === PROJECTS) return ['gone'];
      throw new Error('ENOENT');
    },
    statSync() {
      throw new Error('ENOENT');
    },
  };
  assert.deepEqual(listTranscriptFiles(baseEnv(), fs), []);
});

test('collectRecords filters by --since/--until using each turn\'s own timestamp', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = [
    ...turnEntries({ sessionId: 's1', cwd: '/repo', promptId: 'p1', timestamp: '2026-08-01T10:00:00.000Z', usages: [USAGE_A] }),
    ...turnEntries({ sessionId: 's1', cwd: '/repo', promptId: 'p2', timestamp: '2026-09-05T10:00:00.000Z', usages: [USAGE_A] }),
  ];
  const readFile = fakeReader({ [file]: entries.map((e) => JSON.stringify(e)).join('\n') });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const records = collectRecords({ since: '2026-09-01' }, deps);
  const sendable = records.filter((r) => !r.skip);
  assert.equal(sendable.length, 1);
  assert.equal(sendable[0].promptId, 'p2');
  assert.equal(sendable[0].datetime, '2026-09-05T10:00:00.000Z');
});

test('collectRecords filters by --project and --session', () => {
  const fileA = `${PROJECTS}/repo-a/s1.jsonl`;
  const fileB = `${PROJECTS}/repo-b/s2.jsonl`;
  const entriesA = turnEntries({ sessionId: 's1', cwd: '/work/repo-a', promptId: 'pa', timestamp: '2026-09-01T00:00:00Z', usages: [USAGE_A] });
  const entriesB = turnEntries({ sessionId: 's2', cwd: '/work/repo-b', promptId: 'pb', timestamp: '2026-09-01T00:00:00Z', usages: [USAGE_A] });
  const readFile = fakeReader({
    [fileA]: entriesA.map((e) => JSON.stringify(e)).join('\n'),
    [fileB]: entriesB.map((e) => JSON.stringify(e)).join('\n'),
  });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo-a', 'repo-b'], [`${PROJECTS}/repo-a`]: ['s1.jsonl'], [`${PROJECTS}/repo-b`]: ['s2.jsonl'] }),
  };
  const byProject = collectRecords({ projects: ['repo-a'] }, deps).filter((r) => !r.skip);
  assert.equal(byProject.length, 1);
  assert.equal(byProject[0].project, 'repo-a');

  const bySession = collectRecords({ sessions: ['s2'] }, deps).filter((r) => !r.skip);
  assert.equal(bySession.length, 1);
  assert.equal(bySession[0].sessionId, 's2');
});

test('collectRecords uses process.env when no env dep is given, and skips an empty transcript file', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = PROJECTS.slice(0, -'/projects'.length);
  try {
    const records = collectRecords({}, { readFile: fakeReader({ [`${PROJECTS}/repo/empty.jsonl`]: '' }), exists: () => false, listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['empty.jsonl'] }) });
    assert.deepEqual(records, []);
  } finally {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  }
});

test('collectRecords derives project from the working directory when no entry carries a cwd', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = turnEntries({ sessionId: 's1', cwd: undefined, promptId: 'p1', timestamp: '2026-09-01T00:00:00Z', usages: [USAGE_A] });
  entries.forEach((e) => delete e.cwd);
  const readFile = fakeReader({ [file]: entries.map((e) => JSON.stringify(e)).join('\n') });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const [record] = collectRecords({}, deps).filter((r) => !r.skip);
  assert.equal(record.project, 'unknown');
});

test('collectRecords skips a disabled project unless --include-disabled', () => {
  const file = `${PROJECTS}/off/s1.jsonl`;
  const entries = turnEntries({ sessionId: 's1', cwd: '/work/off', promptId: 'p1', timestamp: '2026-09-01T00:00:00Z', usages: [USAGE_A] });
  const readFile = fakeReader({
    [CONFIG]: JSON.stringify({ usageProjects: { off: { usageEnabled: false } } }),
    [file]: entries.map((e) => JSON.stringify(e)).join('\n'),
  });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['off'], [`${PROJECTS}/off`]: ['s1.jsonl'] }),
  };
  assert.equal(collectRecords({}, deps).filter((r) => !r.skip).length, 0);
  assert.equal(collectRecords({ includeDisabled: true }, deps).filter((r) => !r.skip).length, 1);
});

test('collectRecords carries each project\'s usagePromptMode into the record', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = turnEntries({ sessionId: 's1', cwd: '/work/repo', promptId: 'p1', timestamp: '2026-09-01T00:00:00Z', prompt: 'secret stuff', usages: [USAGE_A] });
  const readFile = fakeReader({
    [CONFIG]: JSON.stringify({ usageProjects: { repo: { usagePromptMode: 'none' } } }),
    [file]: entries.map((e) => JSON.stringify(e)).join('\n'),
  });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const [record] = collectRecords({}, deps).filter((r) => !r.skip);
  assert.equal(record.promptMode, 'none');
});

test('collectRecords counts zero-token and missing-timestamp turns as skips, not sends', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = [
    ...turnEntries({ sessionId: 's1', cwd: '/repo', promptId: 'p1', timestamp: '', usages: [USAGE_A] }),
    ...turnEntries({ sessionId: 's1', cwd: '/repo', promptId: 'p2', timestamp: '2026-09-01T00:00:00Z', usages: [] }),
  ];
  const readFile = fakeReader({ [file]: entries.map((e) => JSON.stringify(e)).join('\n') });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const records = collectRecords({}, deps);
  assert.equal(records.filter((r) => !r.skip).length, 0);
  assert.equal(records.filter((r) => r.skip === 'no-timestamp').length, 1);
  assert.equal(records.filter((r) => r.skip === 'zero-tokens').length, 1);
});

test('collectRecords includes subagent usage as its own record, filtered by range', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = [
    { type: 'user', isSidechain: true, sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:00:00Z', message: { content: 'subtask' } },
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', cwd: '/repo', timestamp: '2026-09-01T00:01:00Z', message: { model: 'claude-haiku-4-5', usage: USAGE_A } },
  ];
  const readFile = fakeReader({ [file]: entries.map((e) => JSON.stringify(e)).join('\n') });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const sendable = collectRecords({}, deps).filter((r) => !r.skip);
  assert.equal(sendable.length, 1);
  assert.equal(sendable[0].promptId, 'subagent');

  const outOfRange = collectRecords({ until: '2026-08-01' }, deps).filter((r) => !r.skip);
  assert.equal(outOfRange.length, 0);

  const otherSession = collectRecords({ sessions: ['does-not-exist'] }, deps).filter((r) => !r.skip);
  assert.equal(otherSession.length, 0);
});

test('collectRecords counts subagent usage with no timestamp as a skip', () => {
  const file = `${PROJECTS}/repo/s1.jsonl`;
  const entries = [
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', cwd: '/repo', message: { model: 'claude-haiku-4-5', usage: USAGE_A } },
  ];
  const readFile = fakeReader({ [file]: entries.map((e) => JSON.stringify(e)).join('\n') });
  const deps = {
    env: baseEnv(),
    readFile,
    exists: () => false,
    listFs: fakeListFs({ [PROJECTS]: ['repo'], [`${PROJECTS}/repo`]: ['s1.jsonl'] }),
  };
  const records = collectRecords({}, deps);
  assert.equal(records.filter((r) => !r.skip).length, 0);
  assert.equal(records.filter((r) => r.skip === 'no-timestamp').length, 1);
});

test('markReported flags records already recorded in the backfill state file, and leaves skips untouched', () => {
  const key = turnKey('s1', 'p1');
  const fs = fakeFs({ [backfillStatePath(baseEnv())]: JSON.stringify({ reported: { [key]: true } }) });
  const [record, skip] = markReported(
    [{ key, project: 'repo', sessionId: 's1', promptId: 'p1' }, { skip: 'zero-tokens', project: 'repo' }],
    baseEnv(),
    fs,
  );
  assert.equal(record.alreadyReported, true);
  assert.deepEqual(skip, { skip: 'zero-tokens', project: 'repo' });
});

test('formatPreview never touches the network — it is pure string formatting', () => {
  const text = formatPreview([
    { project: 'repo', sessionId: 's1', promptId: 'p1', tokens: { total: 10 }, alreadyReported: false },
    { skip: 'no-timestamp', project: 'repo' },
    { skip: 'zero-tokens', project: 'repo' },
  ]);
  assert.match(text, /repo:/);
  assert.match(text, /turns: 1/);
  assert.match(text, /already reported: 0\/1/);
  assert.match(text, /Skipped \(no timestamp\): 1/);
  assert.match(text, /Skipped \(zero tokens\): 1/);
});

test('formatPreview falls back to "unknown" for a missing project or session id', () => {
  const text = formatPreview([{ sessionId: '', tokens: { total: 1 } }]);
  assert.match(text, /unknown:/);
  assert.match(text, /unknown\s+turns:/);
});

test('sendRecords pushes only unreported records, then persists their keys', async () => {
  const fs = fakeFs({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const readFile = fakeReader({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const sent = [];
  const records = [
    { key: 'k1', project: 'repo', sessionId: 's1', promptId: 'p1', datetime: '2026-09-01T00:00:00Z', prompt: 'a', tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1, total: 2 }, model: 'x', alreadyReported: false },
    { key: 'k2', project: 'repo', sessionId: 's1', promptId: 'p2', datetime: '2026-09-01T00:00:00Z', prompt: 'b', tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1, total: 2 }, model: 'x', alreadyReported: true },
  ];
  const result = await sendRecords(records, {
    env: baseEnv(),
    readFile,
    fs,
    post: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; },
  });
  assert.equal(result.sent, 1);
  assert.equal(result.skippedReported, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].turn_id, 'k1');
  const state = JSON.parse(fs.files.get(backfillStatePath(baseEnv())));
  assert.equal(state.reported.k1, true);
});

test('sendRecords works with the default `now` when a push fails and gets logged', async () => {
  const fs = fakeFs({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const readFile = fakeReader({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const records = [
    { key: 'k1', project: 'repo', sessionId: 's1', promptId: 'p1', datetime: '2026-09-01T00:00:00Z', prompt: 'a', tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1, total: 2 }, model: 'x', alreadyReported: false },
  ];
  const result = await sendRecords(records, {
    env: baseEnv(),
    readFile,
    fs,
    post: async () => ({ ok: false, status: 500, error: 'HTTP 500' }),
  });
  assert.equal(result.failed, 1);
});

test('sendRecords with force resends an already-reported record', async () => {
  const fs = fakeFs({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const readFile = fakeReader({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/usage' }) });
  const sent = [];
  const records = [
    { key: 'k1', project: 'repo', sessionId: 's1', promptId: 'p1', datetime: '2026-09-01T00:00:00Z', prompt: 'a', tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1, total: 2 }, model: 'x', alreadyReported: true },
  ];
  const result = await sendRecords(records, {
    env: baseEnv(),
    readFile,
    fs,
    force: true,
    post: async ({ payload }) => { sent.push(payload); return { ok: true, status: 200 }; },
  });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
});
