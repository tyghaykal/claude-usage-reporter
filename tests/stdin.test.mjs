import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readStdin } from '../src/stdin.mjs';

test('readStdin concatenates the whole stream', async () => {
  assert.equal(await readStdin(Readable.from(['{"a":', '1}'])), '{"a":1}');
  assert.equal(await readStdin(Readable.from([Buffer.from('bytes')])), 'bytes');
});

test('readStdin resolves to an empty string when the stream fails', async () => {
  const broken = Readable.from((async function* () { throw new Error('closed'); })());
  assert.equal(await readStdin(broken), '');
});
