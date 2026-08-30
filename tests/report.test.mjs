import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND } from '../src/config.mjs';
import { USAGE } from '../src/cli.mjs';
import { FIRST_RUN_NOTICE, applyPromptMode, buildPayload, errorMark, formatReport, formatUtc } from '../src/report.mjs';

const TOKENS = { input: 1234, cache_read: 800, cache_write: 200, output: 450, total: 2684 };
const MODELS = { m: { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 } };

test('applyPromptMode honours full, none and truncate:N', () => {
  assert.equal(applyPromptMode('hello world', 'full'), 'hello world');
  assert.equal(applyPromptMode('hello world', 'none'), '');
  assert.equal(applyPromptMode('hello world', 'truncate:5'), 'hello…');
  assert.equal(applyPromptMode('hi', 'truncate:5'), 'hi');
});

test('buildPayload matches the documented shape', () => {
  const payload = buildPayload({
    project: 'my-project',
    projectLabel: 'Client Alpha',
    datetime: '2026-08-28T10:15:00.000Z',
    prompt: 'fix the login bug',
    sessionId: 'abc-123',
    tokens: TOKENS,
    model: 'claude-sonnet-5',
    user: 'ana',
    promptMode: 'full',
  });
  assert.deepEqual(payload, {
    project: 'my-project',
    project_label: 'Client Alpha',
    datetime: '2026-08-28T10:15:00.000Z',
    prompt: 'fix the login bug',
    session_id: 'abc-123',
    tokens: TOKENS,
    model: 'claude-sonnet-5',
    user: 'ana',
  });
});

test('buildPayload omits optional fields and applies the prompt mode', () => {
  const payload = buildPayload({
    project: 'p',
    projectLabel: '',
    datetime: 'd',
    prompt: 'secret prompt',
    sessionId: 's',
    tokens: TOKENS,
    model: '',
    user: '',
    promptMode: 'none',
  });
  assert.equal('project_label' in payload, false);
  assert.equal('model' in payload, false);
  assert.equal('user' in payload, false);
  assert.equal(payload.prompt, '');
});

test('buildPayload never carries credential material', () => {
  const payload = buildPayload({
    project: 'p',
    datetime: 'd',
    prompt: 'x',
    sessionId: 's',
    tokens: TOKENS,
    promptMode: 'full',
  });
  assert.deepEqual(Object.keys(payload).sort(), ['datetime', 'project', 'prompt', 'session_id', 'tokens']);
});

test('buildPayload omits the error mark on a successful turn', () => {
  const payload = buildPayload({
    project: 'p',
    datetime: 'd',
    prompt: 'x',
    sessionId: 's',
    tokens: TOKENS,
    promptMode: 'full',
  });
  assert.equal('error' in payload, false);
  assert.equal('error_type' in payload, false);
  assert.equal('error_details' in payload, false);
});

test('buildPayload marks a failed turn without leaking unbounded details', () => {
  const payload = buildPayload({
    project: 'p',
    datetime: 'd',
    prompt: 'x',
    sessionId: 's',
    tokens: TOKENS,
    promptMode: 'full',
    error: { type: 'rate_limit', details: 'retry in 2s' },
  });
  assert.equal(payload.error, true);
  assert.equal(payload.error_type, 'rate_limit');
  assert.equal(payload.error_details, 'retry in 2s');
});

test('errorMark sanitises the type and truncates details', () => {
  assert.equal(errorMark(null), null);
  assert.equal(errorMark(undefined), null);
  assert.deepEqual(errorMark({ type: 'server_error' }), { type: 'server_error' });
  assert.deepEqual(errorMark({ type: 'Not A Type', details: 12 }), { type: 'unknown' });
  assert.deepEqual(errorMark({ type: '', details: 'x' }), { type: 'unknown', details: 'x' });
  const long = 'n'.repeat(400);
  assert.equal(errorMark({ type: 'unknown', details: long }).details.length, 300);
});

test('formatUtc renders the documented timestamp', () => {
  assert.equal(formatUtc('2026-08-28T10:15:00.000Z'), '2026-08-28 10:15:00 UTC');
});

test('formatReport shows a per-call breakdown, cost, subtotal and the setup hint', () => {
  const text = formatReport({
    project: 'my-project',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: TOKENS,
    model: 'm',
    session: { tokens: { total: 14320 }, prompts: 6 },
    endpointConfigured: false,
    models: MODELS,
  });
  assert.match(text, /^\[my-project] 2026-08-28 10:15:00 UTC · m$/m);
  assert.match(text, /input: 1,234 \| cache read: 800 \| cache write: 200 \| output: 450 \| total: 2,684/);
  assert.match(text, /Est\. cost \(list price, estimate only\): \$0\.0\d{3}/);
  assert.match(text, /Session running total: 14,320 tokens across 6 prompts/);
  assert.match(text, /No usage endpoint configured/);
  assert.match(text, /\/claude-usage-reporter:usage-config set usageEndpoint <url>/);
});

test('formatReport drops the hint when an endpoint is set and singularises one prompt', () => {
  const text = formatReport({
    project: 'p',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: TOKENS,
    model: 'm',
    session: { tokens: { total: 10 }, prompts: 1 },
    endpointConfigured: true,
    models: MODELS,
  });
  assert.doesNotMatch(text, /No usage endpoint/);
  assert.match(text, /across 1 prompt$/m);
});

test('formatReport copes with an unknown model and no session summary', () => {
  const text = formatReport({
    project: 'p',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: TOKENS,
    model: '',
    session: null,
    endpointConfigured: true,
    models: MODELS,
  });
  assert.equal(text, '[p] 2026-08-28 10:15:00 UTC\nTokens — input: 1,234 | cache read: 800 | cache write: 200 | output: 450 | total: 2,684');
});

test('formatReport shows the error mark on a failed turn', () => {
  const text = formatReport({
    project: 'p',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: TOKENS,
    model: 'm',
    session: null,
    endpointConfigured: true,
    models: MODELS,
    error: { type: 'rate_limit', details: 'retry in 2s' },
  });
  assert.match(text, /Error: rate_limit — retry in 2s/);
});

test('formatReport shows a type-only error mark when there are no details', () => {
  const text = formatReport({
    project: 'p',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: TOKENS,
    model: '',
    session: null,
    endpointConfigured: true,
    models: MODELS,
    error: { type: 'interrupted' },
  });
  assert.match(text, /Error: interrupted$/m);
  assert.doesNotMatch(text, /Error: interrupted —/);
});

test('formatReport renders zeroed token fields', () => {
  const text = formatReport({
    project: 'p',
    datetime: '2026-08-28T10:15:00.000Z',
    tokens: { total: 0 },
    model: '',
    session: null,
    endpointConfigured: true,
    models: MODELS,
  });
  assert.match(text, /input: 0 \| cache read: 0/);
});

test('the first-run notice discloses capture and the local-only default', () => {
  assert.match(FIRST_RUN_NOTICE, /prompt text/);
  assert.match(FIRST_RUN_NOTICE, /Nothing leaves this machine/);
  assert.match(FIRST_RUN_NOTICE, /usageEndpoint/);
});

test('every command we tell the user to type is plugin-namespaced', () => {
  // Claude Code resolves plugin commands as /<plugin>:<command>; the bare
  // /usage-config is "Unknown command". Guard against it creeping back in.
  assert.equal(COMMAND, '/claude-usage-reporter:usage-config');
  const shown = [
    FIRST_RUN_NOTICE,
    USAGE,
    formatReport({
      project: 'p',
      datetime: '2026-08-28T10:15:00.000Z',
      tokens: TOKENS,
      model: '',
      session: null,
      endpointConfigured: false,
      models: MODELS,
    }),
  ];
  for (const text of shown) {
    for (const match of text.match(/\/[\w:-]*usage-config/g) || []) {
      assert.equal(match, COMMAND, `bare command in: ${text}`);
    }
  }
});
