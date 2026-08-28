import test from 'node:test';
import assert from 'node:assert/strict';
import { USAGE, runCli } from '../src/cli.mjs';
import { CONFIG, env, fakeFs, fakeReader } from './helpers.mjs';

const run = (argv, { files = {}, extraEnv = {}, fs = fakeFs(files) } = {}) => ({
  fs,
  ...runCli(argv, { env: env(extraEnv), readFile: fakeReader(files), fs }),
});

test('with no arguments it shows every setting and the config path', () => {
  const { text } = run([]);
  assert.match(text, /Config file: .*claude-usage\.json/);
  assert.match(text, /usageEndpoint\s+""/);
  assert.match(text, /usageDisplay\s+"auto"/);
  assert.match(text, /No endpoint set — nothing leaves this machine/);
});

test('the usage help lists every settable key', () => {
  assert.match(USAGE, /usageEndpoint/);
  assert.match(USAGE, /usageKeySecretValue/);
});

test('show reports the endpoint and the privacy consequence of having one', () => {
  const { text } = run(['show'], { files: { [CONFIG]: JSON.stringify({ usageEndpoint: 'https://api.example.com/u' }) } });
  assert.match(text, /prompt text leaves this machine on every call/);
});

test('show masks secrets and flags settings available from the environment', () => {
  const { text } = run(['show'], {
    files: { [CONFIG]: JSON.stringify({ usageAuthToken: 'super-secret' }) },
    extraEnv: { CC_USAGE_ENDPOINT: 'https://env.example/u' },
  });
  assert.match(text, /usageAuthToken\s+"\*\*\*set\*\*\*"/);
  assert.equal(text.includes('super-secret'), false);
  assert.match(text, /usageEndpoint.*\(env available\)/);
});

test('show surfaces validation warnings', () => {
  const { text } = run(['show'], { files: { [CONFIG]: JSON.stringify({ usageDisplay: 'loud' }) } });
  assert.match(text, /warning: Unknown usageDisplay/);
});

test('set writes the value and confirms it', () => {
  const { text, code, fs } = run(['set', 'usageEndpoint', 'https://api.example.com/u']);
  assert.equal(code, 0);
  assert.match(text, /Set usageEndpoint = "https:\/\/api\.example\.com\/u"\. Takes effect on the next prompt\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), { usageEndpoint: 'https://api.example.com/u' });
});

test('set never echoes a secret back', () => {
  const { text, fs } = run(['set', 'usageAuthToken', 'sk-live-1234']);
  assert.match(text, /Set usageAuthToken = \*\*\*set\*\*\*/);
  assert.equal(text.includes('sk-live-1234'), false);
  assert.equal(JSON.parse(fs.files.get(CONFIG)).usageAuthToken, 'sk-live-1234');
});

test('set joins a multi-word value', () => {
  const { fs } = run(['set', 'usageUser', 'Ana', 'Lopez']);
  assert.equal(JSON.parse(fs.files.get(CONFIG)).usageUser, 'Ana Lopez');
});

test('unset removes a key', () => {
  const fs = fakeFs({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://x/', usageUser: 'ana' }) });
  const { text, code } = run(['unset', 'usageEndpoint'], { fs });
  assert.equal(code, 0);
  assert.match(text, /Removed usageEndpoint\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), { usageUser: 'ana' });
});

test('bad input is rejected with usage help and a non-zero code', () => {
  for (const argv of [['frobnicate'], ['set'], ['set', 'nonsense', 'x'], ['unset', 'nonsense']]) {
    const { text, code } = run(argv);
    assert.equal(code, 1);
    assert.match(text, /Usage:/);
  }
});

test('set without a value is rejected', () => {
  const { text, code } = run(['set', 'usageEndpoint']);
  assert.equal(code, 1);
  assert.match(text, /needs a value/);
});

test('an unwritable config file is reported, not thrown', () => {
  const fs = fakeFs();
  fs.fail.add('write');
  const { text, code } = run(['set', 'usageUser', 'ana'], { fs });
  assert.equal(code, 1);
  assert.match(text, /Could not write/);
});

test('runCli works on real defaults for a read-only command', () => {
  const { code } = runCli(['frobnicate']);
  assert.equal(code, 1);
});
