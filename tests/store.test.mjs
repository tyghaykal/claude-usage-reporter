import test from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_LIMIT, appendLog, drain, enqueue, fsDefaults, readJson, writeJson } from '../src/store.mjs';
import { fakeFs } from './helpers.mjs';

test('fsDefaults exposes the real filesystem functions', () => {
  assert.equal(typeof fsDefaults.readFileSync, 'function');
  assert.equal(typeof fsDefaults.appendFileSync, 'function');
});

test('readJson returns an object, or {} for anything unusable', () => {
  assert.deepEqual(readJson('/s.json', fakeFs({ '/s.json': '{"a":1}' })), { a: 1 });
  assert.deepEqual(readJson('/s.json', fakeFs({ '/s.json': '[1]' })), {});
  assert.deepEqual(readJson('/s.json', fakeFs({ '/s.json': 'null' })), {});
  assert.deepEqual(readJson('/s.json', fakeFs({ '/s.json': '{oops' })), {});
  assert.deepEqual(readJson('/missing', fakeFs()), {});
});

test('writeJson writes 0600 and reports failure instead of throwing', () => {
  const fs = fakeFs();
  assert.equal(writeJson('/s.json', { a: 1 }, fs), true);
  assert.equal(JSON.parse(fs.files.get('/s.json')).a, 1);

  fs.fail.add('write');
  assert.equal(writeJson('/s.json', { a: 2 }, fs), false);
});

test('writeJson uses mode 0600 so queued prompt text stays private', () => {
  const seen = [];
  const fs = { ...fakeFs(), writeFileSync: (p, d, opts) => seen.push(opts) };
  writeJson('/s.json', {}, fs);
  assert.deepEqual(seen, [{ mode: 0o600 }]);
});

test('enqueue appends and drain empties', () => {
  const fs = fakeFs();
  assert.equal(enqueue('/q.jsonl', { a: 1 }, fs), 1);
  assert.equal(enqueue('/q.jsonl', { a: 2 }, fs), 2);
  assert.deepEqual(drain('/q.jsonl', fs), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(drain('/q.jsonl', fs), []);
});

test('enqueue caps the queue at the newest records', () => {
  const fs = fakeFs();
  for (let i = 0; i < 5; i += 1) enqueue('/q.jsonl', { i }, fs, 3);
  assert.deepEqual(drain('/q.jsonl', fs), [{ i: 2 }, { i: 3 }, { i: 4 }]);
  assert.equal(QUEUE_LIMIT, 500);
});

test('enqueue reports 0 when the queue cannot be written', () => {
  const fs = fakeFs();
  fs.fail.add('write');
  assert.equal(enqueue('/q.jsonl', { a: 1 }, fs), 0);
});

test('drain skips unparseable records and can preview without clearing', () => {
  const fs = fakeFs({ '/q.jsonl': '{"a":1}\n\n{bad}\n{"b":2}\n' });
  assert.deepEqual(drain('/q.jsonl', fs, { clear: false }), [{ a: 1 }, { b: 2 }]);
  assert.ok(fs.files.get('/q.jsonl').includes('"a":1'));
  assert.deepEqual(drain('/missing', fs), []);
});

test('drain returns nothing when it cannot clear the queue, so records are not lost twice', () => {
  const fs = fakeFs({ '/q.jsonl': '{"a":1}\n' });
  fs.fail.add('write');
  assert.deepEqual(drain('/q.jsonl', fs), []);
});

test('appendLog appends, rotates past the size cap, and never throws', () => {
  const fs = fakeFs();
  const now = () => new Date('2026-08-28T10:15:00Z');
  assert.equal(appendLog('/u.log', 'first', fs, now), true);
  assert.equal(appendLog('/u.log', 'second', fs, now), true);
  assert.equal(fs.files.get('/u.log'), '2026-08-28T10:15:00.000Z first\n2026-08-28T10:15:00.000Z second\n');

  fs.files.set('/u.log', 'x'.repeat(300 * 1024));
  assert.equal(appendLog('/u.log', 'rotated', fs, now), true);
  assert.equal(fs.files.get('/u.log'), '2026-08-28T10:15:00.000Z rotated\n');

  fs.fail.add('append');
  assert.equal(appendLog('/u.log', 'nope', fs, now), false);
});

test('appendLog defaults its clock', () => {
  const fs = fakeFs();
  assert.equal(appendLog('/u.log', 'now', fs), true);
});
