import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SENDER_SCRIPT,
  handle,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleStopFailure,
  handleSubagentStop,
  handleUserPromptSubmit,
} from '../src/handler.mjs';
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
const STOP_FAILURE = {
  hook_event_name: 'StopFailure',
  transcript_path: TRANSCRIPT,
  cwd: '/work/my-repo',
  session_id: 's1',
  error: 'rate_limit',
  error_details: 'retry in 2s',
};
const SESSION_END = {
  hook_event_name: 'SessionEnd',
  transcript_path: TRANSCRIPT,
  cwd: '/work/my-repo',
  session_id: 's1',
  reason: 'prompt_input_exit',
};
const SUBAGENT_STOP = { hook_event_name: 'SubagentStop', transcript_path: TRANSCRIPT, cwd: '/work/my-repo', session_id: 's1' };
const PROMPT_SUBMIT = { hook_event_name: 'UserPromptSubmit', transcript_path: TRANSCRIPT, cwd: '/work/my-repo', session_id: 's1' };

test('the sender script path resolves to the shipped binary', () => {
  assert.match(SENDER_SCRIPT, /bin\/send\.mjs$/);
});

test('handle dispatches on the hook event and ignores anything else', () => {
  const d = deps();
  assert.ok(handle({ hook_event_name: 'SessionStart' }, d).suppressOutput);
  assert.ok(handle(STOP, d).systemMessage);
  assert.ok(handle(STOP_FAILURE, deps()).systemMessage);
  assert.ok(handle(SESSION_END, deps()).systemMessage);
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
    { settings: { usageEndpoint: ENDPOINT, usageEnabled: false }, files: { [QUEUE]: '{"a":1}\n' } },
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
  assert.match(systemMessage, /^\[my-repo] 2026-08-28 10:15:00 UTC · claude-sonnet-5 · claude-session$/m);
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
      project_label: 'my-repo',
      datetime: '2026-08-28T10:15:00.000Z',
      prompt: 'hi',
      session_id: 's1',
      tokens: { input: 100, cache_read: 800, cache_write: 200, output: 50, total: 1150 },
      model: 'claude-sonnet-5',
      user: 'ana',
      provider: 'claude-session',
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

test('a usageProjectLabels override renames the terminal report and rides along in the payload as project_label, alongside the real project', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always', usageProjectLabels: { 'my-repo': 'Client Alpha' } },
    dispatched,
  });
  const { systemMessage } = handleStop(STOP, d);
  assert.match(systemMessage, /^\[Client Alpha]/m);
  assert.equal(dispatched[0].records[0].project, 'my-repo');
  assert.equal(dispatched[0].records[0].project_label, 'Client Alpha');
});

test('a project with no override reports project_label as its own real name', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always', usageProjectLabels: { 'other-repo': 'Someone Else' } },
    dispatched,
  });
  const { systemMessage } = handleStop(STOP, d);
  assert.match(systemMessage, /^\[my-repo]/m);
  assert.equal(dispatched[0].records[0].project_label, 'my-repo');
});

test('usageProject:<project>:usageEnabled false stops both the report and the push for that project', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always', usageProjects: { 'my-repo': { usageEnabled: false } } },
    dispatched,
  });
  const result = handleStop(STOP, d);
  assert.equal(result.systemMessage, undefined);
  assert.deepEqual(dispatched, []);
});

test('a project with no usageEnabled override still reports as usual', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always', usageProjects: { 'other-repo': { usageEnabled: false } } },
    dispatched,
  });
  const { systemMessage } = handleStop(STOP, d);
  assert.match(systemMessage, /^\[my-repo]/m);
  assert.equal(dispatched.length, 1);
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

test('StopFailure still submits used tokens and marks the payload as an error', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  const result = handleStopFailure(STOP_FAILURE, d);
  assert.equal(result.systemMessage, undefined);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].records[0].tokens, {
    input: 100,
    cache_read: 800,
    cache_write: 200,
    output: 50,
    total: 1150,
  });
  assert.equal(dispatched[0].records[0].error, true);
  assert.equal(dispatched[0].records[0].error_type, 'rate_limit');
  assert.equal(dispatched[0].records[0].error_details, 'retry in 2s');
});

test('a successful Stop payload has no error fields', () => {
  const dispatched = [];
  handleStop(STOP, deps({ settings: { usageEndpoint: ENDPOINT }, dispatched }));
  assert.equal('error' in dispatched[0].records[0], false);
  assert.equal('error_type' in dispatched[0].records[0], false);
});

test('StopFailure reports even when the turn produced no tokens', () => {
  const dispatched = [];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageDisplay: 'always' },
    entries: transcript({ usages: [] }),
    dispatched,
  });
  const { systemMessage } = handleStopFailure({ ...STOP_FAILURE, error: 'authentication_failed', error_details: undefined }, d);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].tokens.total, 0);
  assert.equal(dispatched[0].records[0].error, true);
  assert.equal(dispatched[0].records[0].error_type, 'authentication_failed');
  assert.equal('error_details' in dispatched[0].records[0], false);
  assert.match(systemMessage, /Error: authentication_failed/);
});

test('StopFailure with an empty transcript still sends a zero-token error mark', () => {
  const dispatched = [];
  handleStopFailure(
    { ...STOP_FAILURE, error: 'server_error', prompt_id: 'p9' },
    deps({ settings: { usageEndpoint: ENDPOINT }, entries: [], dispatched }),
  );
  assert.equal(dispatched[0].records[0].tokens.total, 0);
  assert.equal(dispatched[0].records[0].error_type, 'server_error');
  assert.equal(dispatched[0].records[0].session_id, 's1');
});

test('StopFailure with no session or prompt id still synthesises a record', () => {
  const dispatched = [];
  handleStopFailure(
    { hook_event_name: 'StopFailure', transcript_path: TRANSCRIPT, error: 'unknown' },
    deps({ settings: { usageEndpoint: ENDPOINT }, entries: [], dispatched }),
  );
  assert.equal(dispatched[0].records[0].session_id, '');
  assert.equal(dispatched[0].records[0].tokens.total, 0);
  assert.equal(dispatched[0].records[0].error, true);
  assert.equal(dispatched[0].records[0].error_type, 'unknown');
});

test('StopFailure sanitises an unknown error type', () => {
  const dispatched = [];
  handleStopFailure(
    { ...STOP_FAILURE, error: 'not a type', error_details: 'x' },
    deps({ settings: { usageEndpoint: ENDPOINT }, dispatched }),
  );
  assert.equal(dispatched[0].records[0].error_type, 'unknown');
});

test('the first run never transmits a StopFailure either', () => {
  const dispatched = [];
  const result = handleStopFailure(STOP_FAILURE, deps({ settings: { usageEndpoint: ENDPOINT }, state: {}, dispatched }));
  assert.deepEqual(dispatched, []);
  assert.match(result.systemMessage, /Nothing leaves this machine/);
});

test('SessionEnd submits leftover unreported usage marked interrupted', () => {
  const dispatched = [];
  handleSessionEnd(SESSION_END, deps({ settings: { usageEndpoint: ENDPOINT }, dispatched }));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].error, true);
  assert.equal(dispatched[0].records[0].error_type, 'interrupted');
  assert.equal(dispatched[0].records[0].error_details, 'prompt_input_exit');
  assert.equal(dispatched[0].records[0].tokens.total, 1150);
});

test('SessionEnd does not resend a turn Stop already reported', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStop(STOP, d);
  handleSessionEnd(SESSION_END, d);
  assert.equal(dispatched.length, 1);
  assert.equal('error' in dispatched[0].records[0], false);
});

test('SessionEnd stays quiet when there is no leftover usage', () => {
  const dispatched = [];
  assert.equal(handleSessionEnd(SESSION_END, deps({ entries: [], dispatched })).systemMessage, undefined);
  assert.deepEqual(dispatched, []);
});

test('a repeated Stop for the same turn is reported only once', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStop(STOP, d);
  handleStop(STOP, d);
  assert.equal(dispatched.length, 1);
  assert.equal(JSON.parse(d.fs.files.get(STATE)).lastTurn, 's1:p1');
});

test('StopFailure and SessionEnd de-duplicate the same turn', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStopFailure(STOP_FAILURE, d);
  handleSessionEnd(SESSION_END, d);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].error_type, 'rate_limit');
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

test('handle routes SubagentStop', () => {
  const entries = [
    { type: 'user', isSidechain: true, sessionId: 's1', cwd: '/work/my-repo', message: { content: 'subtask' } },
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', cwd: '/work/my-repo', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
  ];
  const d = deps({ entries });
  assert.ok(handle(SUBAGENT_STOP, d).systemMessage);
});

test('a mixed-model turn dispatches one payload per model, in a single call', () => {
  const dispatched = [];
  const entries = [
    { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/work/my-repo', message: { content: 'hi' } },
    { type: 'assistant', promptId: 'p1', requestId: 'r1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
    { type: 'assistant', promptId: 'p1', requestId: 'r2', message: { model: 'claude-sonnet-5', usage: { output_tokens: 10 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched });
  handleStop(STOP, d);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(
    dispatched[0].records.map((r) => [r.model, r.tokens.total]),
    [
      ['claude-haiku-4-5', 4],
      ['claude-sonnet-5', 10],
    ],
  );
});

test('SubagentStop reports sidechain usage per model, and stays quiet with none', () => {
  const dispatched = [];
  const entries = [
    { type: 'user', isSidechain: true, sessionId: 's1', cwd: '/work/my-repo', message: { content: 'run tests' } },
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', cwd: '/work/my-repo', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched });
  const result = handleSubagentStop(SUBAGENT_STOP, d);
  assert.equal(result.systemMessage, undefined);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].model, 'claude-haiku-4-5');
  assert.equal(dispatched[0].records[0].tokens.total, 4);
  assert.equal(dispatched[0].records[0].prompt, 'run tests');

  assert.equal(handleSubagentStop(SUBAGENT_STOP, deps({ entries: [] })).systemMessage, undefined);
});

test('a repeated SubagentStop for the same subagent is reported only once', () => {
  const dispatched = [];
  const entries = [
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched });
  handleSubagentStop(SUBAGENT_STOP, d);
  handleSubagentStop(SUBAGENT_STOP, d);
  assert.equal(dispatched.length, 1);
});

test('a second subagent call only reports its own fresh usage', () => {
  const dispatched = [];
  const first = [
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries: first, dispatched });
  handleSubagentStop(SUBAGENT_STOP, d);

  const second = [
    ...first,
    { type: 'assistant', isSidechain: true, requestId: 'sub2', sessionId: 's1', message: { model: 'claude-opus-5', usage: { output_tokens: 7 } } },
  ];
  d.readFile = fakeReader({ [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }), [TRANSCRIPT]: second.map((e) => JSON.stringify(e)).join('\n') });
  handleSubagentStop(SUBAGENT_STOP, d);

  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].records[0].model, 'claude-opus-5');
  assert.equal(dispatched[1].records[0].tokens.total, 7);
});

test('SubagentStop dedup state does not collide with the main-turn dedup state', () => {
  const dispatched = [];
  const subagentEntries = [
    { type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
  ];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries: subagentEntries, dispatched });
  handleSubagentStop(SUBAGENT_STOP, d);

  // The main turn (a different transcript state) still reports normally afterwards.
  d.readFile = fakeReader({
    [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }),
    [TRANSCRIPT]: transcript({ usages: [USAGE_A] }).map((e) => JSON.stringify(e)).join('\n'),
  });
  handleStop(STOP, d);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].records[0].tokens.total, 1150);
});

test('a mixed-model turn prints one report block per model, session total on the last', () => {
  const entries = [
    { type: 'user', promptSource: 'typed', promptId: 'p1', sessionId: 's1', cwd: '/work/my-repo', message: { content: 'hi' } },
    { type: 'assistant', promptId: 'p1', requestId: 'r1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } },
    { type: 'assistant', promptId: 'p1', requestId: 'r2', message: { model: 'claude-sonnet-5', usage: { output_tokens: 10 } } },
  ];
  const { systemMessage } = handleStop(STOP, deps({ entries }));
  assert.match(systemMessage, /claude-haiku-4-5/);
  assert.match(systemMessage, /claude-sonnet-5/);
  assert.match(systemMessage, /Session running total/);
  assert.equal((systemMessage.match(/Session running total/g) || []).length, 1);
});

test('SubagentStop stays quiet when the fresh entries carried no tokens', () => {
  const dispatched = [];
  const entries = [{ type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: {} }];
  const result = handleSubagentStop(SUBAGENT_STOP, deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched }));
  assert.equal(result.systemMessage, undefined);
  assert.deepEqual(dispatched, []);
});

test('SubagentStop respects usageEnabled false for the project', () => {
  const dispatched = [];
  const entries = [{ type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } }];
  const d = deps({
    settings: { usageEndpoint: ENDPOINT, usageProjects: { 'my-repo': { usageEnabled: false } } },
    entries,
    dispatched,
  });
  assert.equal(handleSubagentStop(SUBAGENT_STOP, d).systemMessage, undefined);
  assert.deepEqual(dispatched, []);
});

test('SubagentStop falls back to the hook input for session id, and the transcript for cwd', () => {
  const dispatched = [];
  const entries = [{ type: 'assistant', isSidechain: true, requestId: 'sub1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } }];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched });
  handleSubagentStop({ ...SUBAGENT_STOP, session_id: undefined }, d);
  assert.equal(dispatched[0].records[0].session_id, '');

  const withCwd = [{ type: 'assistant', isSidechain: true, requestId: 'sub2', cwd: '/work/my-repo', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } }];
  const d2 = deps({ settings: { usageEndpoint: ENDPOINT }, entries: withCwd, dispatched });
  handleSubagentStop({ ...SUBAGENT_STOP, cwd: undefined }, d2);
  assert.equal(dispatched[1].records[0].project, 'my-repo');
});

test('a second SubagentStop with no prior watermark on record starts fresh', () => {
  const dispatched = [];
  const entries = [{ type: 'assistant', isSidechain: true, requestId: 'sub1', sessionId: 's1', message: { model: 'claude-haiku-4-5', usage: { output_tokens: 4 } } }];
  const state = { noticeShown: true, subagentSession: 's1' };
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, entries, state, dispatched });
  handleSubagentStop(SUBAGENT_STOP, d);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].tokens.total, 4);
});

test('handle routes UserPromptSubmit', () => {
  const entries = [
    ...transcript({ prompt: 'cancelled', promptId: 'p1', usages: [{ output_tokens: 7 }] }),
    { type: 'user', promptSource: 'typed', promptId: 'p2', sessionId: 's1', cwd: '/work/my-repo', message: { content: 'next' } },
  ];
  assert.ok(handle(PROMPT_SUBMIT, deps({ entries })).systemMessage);
});

test('UserPromptSubmit flushes a turn the user cancelled, marked interrupted', () => {
  const dispatched = [];
  const entries = [
    ...transcript({ prompt: 'cancelled', promptId: 'p1', usages: [{ output_tokens: 7 }] }),
    { type: 'user', promptSource: 'typed', promptId: 'p2', sessionId: 's1', cwd: '/work/my-repo', message: { content: 'next' } },
  ];
  const result = handleUserPromptSubmit(PROMPT_SUBMIT, deps({ settings: { usageEndpoint: ENDPOINT }, entries, dispatched }));
  assert.equal(result.systemMessage, undefined);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].records[0].tokens.total, 7);
  assert.equal(dispatched[0].records[0].error, true);
  assert.equal(dispatched[0].records[0].error_type, 'interrupted');
});

test('UserPromptSubmit stays quiet on the first prompt of a session', () => {
  const d = deps({ entries: transcript({ usages: [USAGE_A] }) });
  assert.equal(handleUserPromptSubmit(PROMPT_SUBMIT, d).systemMessage, undefined);
});

test('UserPromptSubmit does not resend a turn Stop already reported', () => {
  const dispatched = [];
  const d = deps({ settings: { usageEndpoint: ENDPOINT }, dispatched });
  handleStop(STOP, d);

  d.readFile = fakeReader({
    [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT }),
    [TRANSCRIPT]: [
      ...transcript({ usages: [USAGE_A] }),
      { type: 'user', promptSource: 'typed', promptId: 'p2', sessionId: 's1', cwd: '/work/my-repo', message: { content: 'next' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n'),
  });
  handleUserPromptSubmit(PROMPT_SUBMIT, d);
  assert.equal(dispatched.length, 1);
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
