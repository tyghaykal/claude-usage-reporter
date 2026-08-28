import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SENDER_SCRIPT, handle, handleSessionStart, handleStop } from '../src/handler.mjs';
import { CONFIG, LOG, QUEUE, STATE, USAGE_A, env, fakeFs, fakeReader, transcript } from './helpers.mjs';

const TRANSCRIPT = '/session.jsonl';
const ENDPOINT = 'https://api.example.com/usage';
const SEEN = { noticeShown: true };

function deps({ settings, files = {}, entries = transcript({ usages: [USAGE_A] }), state = SEEN, dispatched } = {}) {
  const configFile = settings ? { [CONFIG]: JSON.stringify(settings) } : {};
  return {
    env: env(),
    fs: fakeFs({ [STATE]: JSON.stringify(state), ...files }),
    readFile: fakeReader({ ...configFile, [TRANSCRIPT]: entries.map((e) => JSON.stringify(e)).join('\n') }),
    exists: () => false,
    now: () => new Date('2026-08-28T10:15:00Z'),
    models: { 'claude-sonnet-5': { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 } },
    dispatchImpl: (records, options) => {
      if (dispatched) dispatched.push({ records, options });
      return true;
    },
  };
}

const STOP = { hook_event_name: 'Stop', transcript_path: TRANSCRIPT, cwd: '/work/my-repo', session_id: 's1' };

test('the sender script path resolves to the shipped binary', () => {
  assert.match(SENDER_SCRIPT, /bin\/send\.mjs$/);
});

test('handle dispatches on the hook event and ignores anything else', () => {
  const d = deps();
  assert.ok(handle({ hook_event_name: 'SessionStart' }, d).suppressOutput);
  assert.ok(handle(STOP, d).systemMessage);
  assert.deepEqual(handle({ hook_event_name: 'PreToolUse' }, d), { suppressOutput: true });
});

test('the first run shows the disclosure notice exactly once', () => {
  const d = deps({ state: {} });
  const first = handleSessionStart({}, d);
  assert.match(first.systemMessage, /Claude Usage Reporter is now active/);
  assert.equal(JSON.parse(d.fs.files.get(STATE)).noticeShown, true);
  assert.equal(handleSessionStart({}, d).systemMessage, undefined);
});

test('the first run never transmits, even with an endpoint already configured', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, state: {}, dispatched });
  const result = handleStop(STOP, d);
  assert.deepEqual(dispatched, []);
  assert.match(result.systemMessage, /Nothing leaves this machine/);
});

test('SessionStart flushes a non-empty retry queue', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, files: { [QUEUE]: '{"a":1}\n' }, dispatched });
  handleSessionStart({}, d);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].records, []);
  assert.equal(dispatched[0].options.script, SENDER_SCRIPT);
  // The queue is left intact — the detached sender owns draining it.
  assert.equal(d.fs.files.get(QUEUE), '{"a":1}\n');
});

test('SessionStart does not spawn a sender with an empty queue, no endpoint, or retry off', () => {
  for (const options of [
    { settings: { usageEndpoint: ENDPOINT } },
    { settings: {}, files: { [QUEUE]: '{"a":1}\n' } },
    { settings: { usageEndpoint: ENDPOINT, usageRetry: false }, files: { [QUEUE]: '{"a":1}\n' } },
  ]) {
    const dispatched = [];
    handleSessionStart({}, deps({ ...options, dispatched }));
    assert.deepEqual(dispatched, []);
  }
});

test('SessionStart surfaces config warnings', () => {
  const d = deps({ settings: { usageEndpoint: 'nope' } });
  assert.match(handleSessionStart({}, d).systemMessage, /not a valid URL/);
});

test('with no endpoint, Stop prints a per-call report and sends nothing', () => {
  const dispatched = [];
  const d = deps({ dispatched });
  const { systemMessage } = handleStop(STOP, d);
  assert.deepEqual(dispatched, []);
  assert.match(systemMessage, /^\[my-repo] 2026-08-28 10:15:00 UTC · claude-sonnet-5$/m);
  assert.match(systemMessage, /input: 100 \| cache read: 800 \| cache write: 200 \| output: 50 \| total: 1,150/);
  assert.match(systemMessage, /Session running total: 1,150 tokens across 1 prompt/);
  assert.match(systemMessage, /No usage endpoint configured/);
});

test('with an endpoint, Stop pushes the documented payload and stays silent', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT, usageUser: 'ana' }, dispatched });
  const result = handleStop(STOP, d);
  assert.equal(result.systemMessage, undefined);
  assert.deepEqual(dispatched[0].records, [
    {
      project: 'my-repo',
      datetime: '2026-08-28T10:15:00.000Z',
      prompt: 'hi',
      session_id: 's1',
      tokens: { input: 100, cache_read: 800, cache_write: 200, output: 50, total: 1150 },
      model: 'claude-sonnet-5',
      user: 'ana',
    },
  ]);
});

test('usageDisplay: always shows the report alongside the push', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always' }, dispatched });
  const { systemMessage } = handleStop(STOP, d);
  assert.equal(dispatched.length, 1);
  assert.match(systemMessage, /total: 1,150/);
  assert.doesNotMatch(systemMessage, /No usage endpoint configured/);
});

test('usageDisplay: off suppresses the report with no endpoint set', () => {
  const d = deps({ settings: { usageDisplay: 'off' } });
  assert.equal(handleStop(STOP, d).systemMessage, undefined);
});

test('usagePromptMode is applied before the prompt ever leaves the machine', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usagePromptMode: 'none' },
    entries: transcript({ prompt: 'my private prompt', usages: [USAGE_A] }),
    dispatched,
  });
  handleStop(STOP, d);
  assert.equal(dispatched[0].records[0].prompt, '');
});

test('Stop stays quiet when there is no turn or no usage to report', () => {
  assert.equal(handleStop(STOP, deps({ entries: [] })).systemMessage, undefined);
  assert.equal(handleStop(STOP, deps({ entries: transcript({ usages: [] }) })).systemMessage, undefined);
});

test('a repeated Stop for the same turn is reported only once', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStop(STOP, d);
  handleStop(STOP, d);
  assert.equal(dispatched.length, 1);
  assert.equal(JSON.parse(d.fs.files.get(STATE)).lastTurn, 's1:p1');
});

test('a turn without a promptId still de-duplicates', () => {
  const entries = [
    { type: 'user', promptSource: 'typed', sessionId: 's1', message: { content: 'hi' } },
    { type: 'assistant', requestId: 'r1', message: { model: 'claude-sonnet-5', usage: { output_tokens: 9 } } },
  ];
  const d = deps({ entries });
  assert.ok(handleStop(STOP, d).systemMessage);
  assert.equal(JSON.parse(d.fs.files.get(STATE)).lastTurn, 's1:9');
});

test('a sender that cannot be launched is logged and reported, not thrown', () => {
  const d = { ...deps({ settings: { usageEndpoint: ENDPOINT } }), dispatchImpl: () => false };
  const { systemMessage } = handleStop(STOP, d);
  assert.match(systemMessage, /could not start the background sender/);
  assert.match(d.fs.files.get(LOG), /failed to launch usage sender/);
});

test('the session id falls back to the hook input when the transcript omits it', () => {
  const dispatched = [];
  const entries = [
    { type: 'user', promptSource: 'typed', message: { content: 'hi' } },
    { type: 'assistant', requestId: 'r1', message: { usage: { output_tokens: 9 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched });
  handleStop(STOP, d);
  assert.equal(dispatched[0].records[0].session_id, 's1');

  const anon = [];
  handleStop({ ...STOP, session_id: undefined }, deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched: anon }));
  assert.equal(anon[0].records[0].session_id, '');
});

test('the project falls back to the transcript cwd when the hook omits it', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStop({ ...STOP, cwd: '' }, d);
  assert.equal(dispatched[0].records[0].project, 'repo');
});

test('the full flow works against the real filesystem with no injected dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const transcriptPath = join(dir, 'session.jsonl');
  writeFileSync(
    transcriptPath,
    transcript({ usages: [USAGE_A] }).map((e) => JSON.stringify(e)).join('\n'),
  );
  const previous = process.env.CLAUDE_USAGE_HOME;
  process.env.CLAUDE_USAGE_HOME = dir;
  try {
    const input = { hook_event_name: 'Stop', transcript_path: transcriptPath, cwd: dir, session_id: 's1' };
    assert.match(handleSessionStart({}).systemMessage, /Claude Usage Reporter is now active/);
    const report = handleStop(input).systemMessage;
    assert.match(report, /total: 1,150/);
    assert.match(report, /Est\. cost \(list price, estimate only\)/);
    assert.equal(statSync(join(dir, 'claude-usage-state.json')).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_USAGE_HOME;
    else process.env.CLAUDE_USAGE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
