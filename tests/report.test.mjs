import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_RUN_NOTICE, applyPromptMode, buildPayload, formatReport, formatUtc } from '../src/report.mjs';

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
    datetime: 'd',
    prompt: 'secret prompt',
    sessionId: 's',
    tokens: TOKENS,
    model: '',
    user: '',
    promptMode: 'none',
  });
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
  assert.match(text, /\/usage-config set usageEndpoint <url>/);
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
