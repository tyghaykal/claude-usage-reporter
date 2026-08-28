import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import {
  authHeaders,
  configPath,
  dataDir,
  loadConfig,
  logPath,
  maskConfig,
  queuePath,
  readConfigFile,
  shouldDisplay,
  statePath,
} from '../src/config.mjs';
import { CONFIG, HOME, LOG, QUEUE, STATE, env, fakeReader } from './helpers.mjs';

const load = (files, extraEnv = {}) =>
  loadConfig({ env: env(extraEnv), readFile: fakeReader(files) });

test('paths honour CLAUDE_USAGE_HOME and fall back to the home directory', () => {
  assert.equal(dataDir(env()), HOME);
  assert.equal(configPath(env()), CONFIG);
  assert.equal(statePath(env()), STATE);
  assert.equal(queuePath(env()), QUEUE);
  assert.equal(logPath(env()), LOG);
  assert.ok(dataDir({}).startsWith(homedir()));
  assert.equal(configPath({ CLAUDE_USAGE_CONFIG: '/x.json' }), '/x.json');
});

test('readConfigFile tolerates missing, malformed and non-object files', () => {
  assert.deepEqual(readConfigFile('/nope', fakeReader({})), { data: {}, warnings: [] });

  const bad = readConfigFile('/c.json', fakeReader({ '/c.json': '{oops' }));
  assert.deepEqual(bad.data, {});
  assert.match(bad.warnings[0], /not valid JSON/);

  for (const body of ['[1,2]', 'null']) {
    const result = readConfigFile('/c.json', fakeReader({ '/c.json': body }));
    assert.deepEqual(result.data, {});
    assert.match(result.warnings[0], /not a JSON object/);
  }

  assert.deepEqual(readConfigFile('/c.json', fakeReader({ '/c.json': '{"a":1}' })).data, { a: 1 });
});

test('defaults apply when nothing is configured', () => {
  const { config, warnings } = load({});
  assert.deepEqual(warnings, []);
  assert.equal(config.usageEndpoint, '');
  assert.equal(config.usageAuthType, 'None');
  assert.equal(config.usageDisplay, 'auto');
  assert.equal(config.usagePromptMode, 'full');
  assert.equal(config.usageRetry, true);
  assert.equal(config.usageTimeoutMs, 5000);
  assert.equal(config.usageHeaderName, 'X-API-Key');
});

test('config file wins over environment, environment wins over default', () => {
  const { config } = load(
    { [CONFIG]: JSON.stringify({ usageEndpoint: 'https://file.example/x', usageUser: null }) },
    { CC_USAGE_ENDPOINT: 'https://env.example/y', CC_USAGE_USER: 'ana' },
  );
  assert.equal(config.usageEndpoint, 'https://file.example/x');
  assert.equal(config.usageUser, 'ana');
});

test('empty values are ignored rather than overriding defaults', () => {
  const { config } = load({ [CONFIG]: JSON.stringify({ usageHeaderName: '' }) }, { CC_USAGE_HEADER_NAME: '' });
  assert.equal(config.usageHeaderName, 'X-API-Key');
});

test('endpoint must be a valid http(s) URL', () => {
  const bad = load({ [CONFIG]: JSON.stringify({ usageEndpoint: 'not a url' }) });
  assert.equal(bad.config.usageEndpoint, '');
  assert.match(bad.warnings[0], /not a valid URL/);

  const ftp = load({ [CONFIG]: JSON.stringify({ usageEndpoint: 'ftp://host/x' }) });
  assert.equal(ftp.config.usageEndpoint, '');
  assert.match(ftp.warnings[0], /must be http/);

  const ok = load({ [CONFIG]: JSON.stringify({ usageEndpoint: 'https://ok.example/u' }) });
  assert.equal(ok.config.usageEndpoint, 'https://ok.example/u');
  assert.deepEqual(ok.warnings, []);
});

test('auth type accepts spacing variants and rejects unknown values', () => {
  for (const value of ['Key Pair', 'key_pair', 'keypair', 'KEY-PAIR']) {
    assert.equal(load({ [CONFIG]: JSON.stringify({ usageAuthType: value }) }).config.usageAuthType, 'Key Pair');
  }
  const bad = load({ [CONFIG]: JSON.stringify({ usageAuthType: 'HMAC' }) });
  assert.equal(bad.config.usageAuthType, 'None');
  assert.match(bad.warnings[0], /Unknown usageAuthType/);
});

test('display mode falls back to auto when unrecognised', () => {
  const bad = load({ [CONFIG]: JSON.stringify({ usageDisplay: 'loud' }) });
  assert.equal(bad.config.usageDisplay, 'auto');
  assert.match(bad.warnings[0], /Unknown usageDisplay/);
  assert.equal(load({ [CONFIG]: JSON.stringify({ usageDisplay: 'always' }) }).config.usageDisplay, 'always');
});

test('prompt mode supports full, none and truncate:N', () => {
  assert.equal(load({ [CONFIG]: JSON.stringify({ usagePromptMode: 'none' }) }).config.usagePromptMode, 'none');
  assert.equal(load({ [CONFIG]: JSON.stringify({ usagePromptMode: 'truncate:80' }) }).config.usagePromptMode, 'truncate:80');

  for (const value of ['truncate:0', 'truncate:x', 'redact']) {
    const result = load({ [CONFIG]: JSON.stringify({ usagePromptMode: value }) });
    assert.equal(result.config.usagePromptMode, 'full');
    assert.match(result.warnings[0], /Unknown usagePromptMode/);
  }
});

test('retry coerces string and boolean forms', () => {
  assert.equal(load({ [CONFIG]: JSON.stringify({ usageRetry: false }) }).config.usageRetry, false);
  assert.equal(load({}, { CC_USAGE_RETRY: 'off' }).config.usageRetry, false);
  assert.equal(load({}, { CC_USAGE_RETRY: 'yes' }).config.usageRetry, true);
});

test('timeout must be a positive number', () => {
  assert.equal(load({}, { CC_USAGE_TIMEOUT_MS: '2500.9' }).config.usageTimeoutMs, 2500);
  const bad = load({}, { CC_USAGE_TIMEOUT_MS: '-1' });
  assert.equal(bad.config.usageTimeoutMs, 5000);
  assert.match(bad.warnings[0], /positive number/);
});

test('shouldDisplay implements the auto/always/off rules of FR-17', () => {
  assert.equal(shouldDisplay({ usageDisplay: 'off', usageEndpoint: '' }), false);
  assert.equal(shouldDisplay({ usageDisplay: 'always', usageEndpoint: 'https://x/' }), true);
  assert.equal(shouldDisplay({ usageDisplay: 'auto', usageEndpoint: '' }), true);
  assert.equal(shouldDisplay({ usageDisplay: 'auto', usageEndpoint: 'https://x/' }), false);
});

test('authHeaders builds the right shape for each of the five auth types', () => {
  const base = {
    usageHeaderName: 'X-API-Key',
    usageKeyIdHeaderName: 'X-Id',
    usageKeySecretHeaderName: 'X-Secret',
  };

  assert.deepEqual(authHeaders({ ...base, usageAuthType: 'None' }), { headers: {}, warnings: [] });

  assert.deepEqual(
    authHeaders({ ...base, usageAuthType: 'Bearer', usageAuthToken: 'tok' }).headers,
    { Authorization: 'Bearer tok' },
  );

  assert.deepEqual(
    authHeaders({ ...base, usageAuthType: 'Basic', usageAuthToken: 'user:pass' }).headers,
    { Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` },
  );
  assert.deepEqual(
    authHeaders({ ...base, usageAuthType: 'Basic', usageAuthToken: 'cHJlLWVuY29kZWQ=' }).headers,
    { Authorization: 'Basic cHJlLWVuY29kZWQ=' },
  );

  assert.deepEqual(
    authHeaders({ ...base, usageAuthType: 'Header', usageHeaderValue: 'v' }).headers,
    { 'X-API-Key': 'v' },
  );

  assert.deepEqual(
    authHeaders({ ...base, usageAuthType: 'Key Pair', usageKeyIdValue: 'id', usageKeySecretValue: 'sec' }).headers,
    { 'X-Id': 'id', 'X-Secret': 'sec' },
  );
});

test('authHeaders warns instead of sending a half-configured credential', () => {
  for (const config of [
    { usageAuthType: 'Bearer', usageAuthToken: '' },
    { usageAuthType: 'Basic', usageAuthToken: '' },
    { usageAuthType: 'Header', usageHeaderValue: '' },
  ]) {
    const result = authHeaders(config);
    assert.deepEqual(result.headers, {});
    assert.equal(result.warnings.length, 1);
  }

  const pair = authHeaders({
    usageAuthType: 'Key Pair',
    usageKeyIdHeaderName: 'X-Id',
    usageKeyIdValue: 'id',
    usageKeySecretValue: '',
  });
  assert.deepEqual(pair.headers, { 'X-Id': 'id' });
  assert.equal(pair.warnings.length, 1);
});

test('maskConfig hides every secret and leaves the rest readable', () => {
  const masked = maskConfig({
    usageEndpoint: 'https://x/',
    usageAuthToken: 'super-secret',
    usageHeaderValue: '',
    usageKeyIdValue: 'id',
    usageKeySecretValue: 'sec',
  });
  assert.deepEqual(masked, {
    usageEndpoint: 'https://x/',
    usageAuthToken: '***set***',
    usageHeaderValue: '',
    usageKeyIdValue: '***set***',
    usageKeySecretValue: '***set***',
  });
  assert.equal(JSON.stringify(masked).includes('super-secret'), false);
});
