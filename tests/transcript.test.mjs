import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTurn,
  parseLines,
  promptEntries,
  readTranscript,
  sessionSummary,
  sumUsage,
  textOf,
} from '../src/transcript.mjs';
import { USAGE_A, fakeReader, transcript } from './helpers.mjs';

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');

test('parseLines skips blanks and half-written lines', () => {
  const parsed = parseLines('{"a":1}\n\n  \n{"b":2}\n{"c":');
  assert.deepEqual(parsed, [{ a: 1 }, { b: 2 }]);
});

test('readTranscript returns an empty list when the file cannot be read', () => {
  assert.deepEqual(readTranscript('/missing', fakeReader({})), []);
  assert.deepEqual(readTranscript('/t.jsonl', fakeReader({ '/t.jsonl': '{"a":1}' })), [{ a: 1 }]);
});

test('textOf flattens strings, block arrays and anything else', () => {
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, null, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf(42), '');
});

test('promptEntries prefers promptSource-tagged entries', () => {
  const entries = [
    { type: 'user', promptSource: 'typed', message: { content: 'real' } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', message: {} },
    null,
  ];
  assert.deepEqual(promptEntries(entries).map((e) => e.message.content), ['real']);
});

test('promptEntries falls back to plain-text user entries on older transcripts', () => {
  const entries = [
    { type: 'user', message: { content: 'older prompt' } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'user', isSidechain: true, message: { content: 'subagent' } },
  ];
  assert.deepEqual(promptEntries(entries).map((e) => e.message.content), ['older prompt']);
});

test('sumUsage de-duplicates repeated requests and tolerates missing fields', () => {
  const tokens = sumUsage([
    { requestId: 'r1', message: { usage: USAGE_A } },
    { requestId: 'r1', message: { usage: USAGE_A } },
    { uuid: 'u1', message: { usage: { output_tokens: 5 } } },
    { uuid: 'u1', message: { usage: { output_tokens: 5 } } },
    { message: {} },
    { message: { usage: { input_tokens: 1 } } },
  ]);
  assert.deepEqual(tokens, {
    input: 101,
    cache_read: 800,
    cache_write: 200,
    output: 55,
    total: 1156,
  });
});

test('extractTurn returns null when the transcript holds no prompt', () => {
  assert.equal(extractTurn([]), null);
  assert.equal(extractTurn([{ type: 'assistant', message: { usage: USAGE_A } }]), null);
});

test('extractTurn scopes usage to the last prompt and excludes subagents', () => {
  const entries = [
    ...transcript({ prompt: 'first', promptId: 'p1', usages: [USAGE_A] }),
    ...transcript({ prompt: 'second', promptId: 'p2', usages: [{ input_tokens: 7, output_tokens: 3 }] }),
    { type: 'assistant', isSidechain: true, promptId: 'p2', requestId: 'sub', message: { usage: USAGE_A } },
    { type: 'assistant', promptId: 'other', requestId: 'x', message: { usage: USAGE_A } },
  ];
  const turn = extractTurn(entries);
  assert.equal(turn.prompt, 'second');
  assert.equal(turn.promptId, 'p2');
  assert.equal(turn.sessionId, 's1');
  assert.equal(turn.cwd, '/repo');
  assert.equal(turn.model, 'claude-sonnet-5');
  assert.deepEqual(turn.tokens, { input: 7, cache_read: 0, cache_write: 0, output: 3, total: 10 });
});

test('extractTurn groups positionally when promptId is absent, and copes without a model', () => {
  const turn = extractTurn([
    { type: 'user', promptSource: 'typed', message: { content: 'hi' } },
    { type: 'assistant', requestId: 'r1', message: { usage: { output_tokens: 4 } } },
  ]);
  assert.equal(turn.model, '');
  assert.equal(turn.sessionId, '');
  assert.equal(turn.cwd, '');
  assert.equal(turn.promptId, '');
  assert.equal(turn.tokens.total, 4);
});

test('sessionSummary totals the whole session', () => {
  const entries = [
    ...transcript({ promptId: 'p1', usages: [USAGE_A] }),
    ...transcript({ promptId: 'p2', usages: [{ output_tokens: 10 }] }),
  ];
  assert.deepEqual(sessionSummary(entries), {
    tokens: { input: 100, cache_read: 800, cache_write: 200, output: 60, total: 1160 },
    prompts: 2,
  });
});

test('a real-shaped transcript round-trips through the reader', () => {
  const path = '/t.jsonl';
  const entries = readTranscript(path, fakeReader({ [path]: jsonl(transcript({ usages: [USAGE_A] })) }));
  assert.equal(extractTurn(entries).tokens.total, 1150);
});
