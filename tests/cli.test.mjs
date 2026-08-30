import test from 'node:test';
import assert from 'node:assert/strict';
import { USAGE, runCli } from '../src/cli.mjs';
import { CONFIG, env, fakeFs, fakeReader } from './helpers.mjs';

const run = async (argv, { files = {}, extraEnv = {}, fs = fakeFs(files), ...rest } = {}) => ({
  fs,
  ...(await runCli(argv, { env: env(extraEnv), readFile: fakeReader(files), fs, ...rest })),
});

const ENDPOINT = 'https://api.example.com/usage';
const withEndpoint = (extra = {}) => ({ [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT, ...extra }) });
const testDeps = { cwd: '/work/my-repo', now: () => new Date('2026-08-28T10:15:00Z') };

test('with no arguments it shows every setting and the config path', async () => {
  const { text } = await run([]);
  assert.match(text, /Config file: .*claude-usage\.json/);
  assert.match(text, /usageEndpoint\s+""/);
  assert.match(text, /usageDisplay\s+"auto"/);
  assert.match(text, /No endpoint set — nothing leaves this machine/);
});

test('the usage help lists every settable key and every command', () => {
  assert.match(USAGE, /usageEndpoint/);
  assert.match(USAGE, /usageKeySecretValue/);
  assert.match(USAGE, /test-connection/);
});

test('show reports the endpoint and the privacy consequence of having one', async () => {
  const { text } = await run(['show'], { files: withEndpoint() });
  assert.match(text, /prompt text leaves this machine on every call/);
});

test('show masks secrets and flags settings available from the environment', async () => {
  const { text } = await run(['show'], {
    files: { [CONFIG]: JSON.stringify({ usageAuthToken: 'super-secret' }) },
    extraEnv: { CC_USAGE_ENDPOINT: 'https://env.example/u' },
  });
  assert.match(text, /usageAuthToken\s+"\*\*\*set\*\*\*"/);
  assert.equal(text.includes('super-secret'), false);
  assert.match(text, /usageEndpoint.*\(env available\)/);
});

test('show surfaces validation warnings', async () => {
  const { text } = await run(['show'], { files: { [CONFIG]: JSON.stringify({ usageDisplay: 'loud' }) } });
  assert.match(text, /warning: Unknown usageDisplay/);
});

test('set writes the value and confirms it', async () => {
  const { text, code, fs } = await run(['set', 'usageEndpoint', ENDPOINT]);
  assert.equal(code, 0);
  assert.match(text, /Set usageEndpoint = "https:\/\/api\.example\.com\/usage"\. Takes effect on the next prompt\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), { usageEndpoint: ENDPOINT });
});

test('set never echoes a secret back', async () => {
  const { text, fs } = await run(['set', 'usageAuthToken', 'sk-live-1234']);
  assert.match(text, /Set usageAuthToken = \*\*\*set\*\*\*/);
  assert.equal(text.includes('sk-live-1234'), false);
  assert.equal(JSON.parse(fs.files.get(CONFIG)).usageAuthToken, 'sk-live-1234');
});

test('set joins a multi-word value', async () => {
  const { fs } = await run(['set', 'usageUser', 'Ana', 'Lopez']);
  assert.equal(JSON.parse(fs.files.get(CONFIG)).usageUser, 'Ana Lopez');
});

test('unset removes a key', async () => {
  const fs = fakeFs({ [CONFIG]: JSON.stringify({ usageEndpoint: ENDPOINT, usageUser: 'ana' }) });
  const { text, code } = await run(['unset', 'usageEndpoint'], { fs });
  assert.equal(code, 0);
  assert.match(text, /Removed usageEndpoint\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), { usageUser: 'ana' });
});

test('set/unset usageProjectLabel:<project> edits only that project\'s override', async () => {
  const fs = fakeFs();
  const set = await run(['set', 'usageProjectLabel:client', 'Client', 'Alpha'], { fs });
  assert.equal(set.code, 0);
  assert.match(set.text, /Set usageProjectLabel:client = "Client Alpha"\. Takes effect on the next prompt\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), { usageProjectLabels: { client: 'Client Alpha' } });

  const setAnother = await run(['set', 'usageProjectLabel:other', 'Other'], { fs });
  assert.equal(setAnother.code, 0);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)).usageProjectLabels, { client: 'Client Alpha', other: 'Other' });

  const unset = await run(['unset', 'usageProjectLabel:client'], { fs });
  assert.equal(unset.code, 0);
  assert.match(unset.text, /Removed usageProjectLabel:client\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)).usageProjectLabels, { other: 'Other' });
});

test('set usageProjectLabel:<project> without a value is rejected', async () => {
  const { text, code } = await run(['set', 'usageProjectLabel:client']);
  assert.equal(code, 1);
  assert.match(text, /needs a value/);
});

test('usageProjectLabels is not directly settable and shows as per-project overrides', async () => {
  const bad = await run(['set', 'usageProjectLabels', '{}']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /Unknown setting/);

  const { text } = await run(['show'], {
    files: { [CONFIG]: JSON.stringify({ usageProjectLabels: { client: 'Client Alpha' } }) },
  });
  assert.match(text, /Per-project overrides:/);
  assert.match(text, /usageProjectLabel:client\s+"Client Alpha"/);
});

test('set/unset usageProject:<project>:<key> edits only that project\'s override', async () => {
  const fs = fakeFs();
  const set = await run(['set', 'usageProject:client:usageEndpoint', 'https://client.example/usage'], { fs });
  assert.equal(set.code, 0);
  assert.match(set.text, /Set usageProject:client:usageEndpoint = "https:\/\/client\.example\/usage"\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)), {
    usageProjects: { client: { usageEndpoint: 'https://client.example/usage' } },
  });

  const setDisplay = await run(['set', 'usageProject:internal:usageDisplay', 'off'], { fs });
  assert.equal(setDisplay.code, 0);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)).usageProjects, {
    client: { usageEndpoint: 'https://client.example/usage' },
    internal: { usageDisplay: 'off' },
  });

  const unset = await run(['unset', 'usageProject:client:usageEndpoint'], { fs });
  assert.equal(unset.code, 0);
  assert.match(unset.text, /Removed usageProject:client:usageEndpoint\./);
  assert.deepEqual(JSON.parse(fs.files.get(CONFIG)).usageProjects, { internal: { usageDisplay: 'off' } });
});

test('set usageProject:<project>:<key> never echoes a secret, and rejects an unknown key', async () => {
  const { text, fs } = await run(['set', 'usageProject:client:usageAuthToken', 'sk-live-1234']);
  assert.match(text, /Set usageProject:client:usageAuthToken = \*\*\*set\*\*\*/);
  assert.equal(text.includes('sk-live-1234'), false);
  assert.equal(JSON.parse(fs.files.get(CONFIG)).usageProjects.client.usageAuthToken, 'sk-live-1234');

  const bad = await run(['set', 'usageProject:client:nonsense', 'x']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /Unknown setting/);
});

test('set usageProject:<project>:<key> without a value is rejected', async () => {
  const { text, code } = await run(['set', 'usageProject:client:usageEndpoint']);
  assert.equal(code, 1);
  assert.match(text, /needs a value/);
});

test('an unwritable config file is reported for a per-project setting too', async () => {
  const fs = fakeFs();
  fs.fail.add('write');
  const { text, code } = await run(['set', 'usageProject:client:usageEndpoint', 'https://client.example/usage'], { fs });
  assert.equal(code, 1);
  assert.match(text, /Could not write/);
});

test('usageProjects is not directly settable and shows as per-project settings', async () => {
  const bad = await run(['set', 'usageProjects', '{}']);
  assert.equal(bad.code, 1);
  assert.match(bad.text, /Unknown setting/);

  const { text } = await run(['show'], {
    files: {
      [CONFIG]: JSON.stringify({
        usageProjects: { client: { usageEndpoint: 'https://client.example/usage', usageAuthToken: 'sk-live-1234' } },
      }),
    },
  });
  assert.match(text, /Per-project settings:/);
  assert.match(text, /usageProject:client:usageEndpoint\s+"https:\/\/client\.example\/usage"/);
  assert.match(text, /usageProject:client:usageAuthToken\s+"\*\*\*set\*\*\*"/);
  assert.equal(text.includes('sk-live-1234'), false);
});

test('bad input is rejected with usage help and a non-zero code', async () => {
  for (const argv of [['frobnicate'], ['set'], ['set', 'nonsense', 'x'], ['unset', 'nonsense']]) {
    const { text, code } = await run(argv);
    assert.equal(code, 1);
    assert.match(text, /Usage:/);
  }
});

test('set without a value is rejected', async () => {
  const { text, code } = await run(['set', 'usageEndpoint']);
  assert.equal(code, 1);
  assert.match(text, /needs a value/);
});

test('an unwritable config file is reported, not thrown', async () => {
  const fs = fakeFs();
  fs.fail.add('write');
  const { text, code } = await run(['set', 'usageUser', 'ana'], { fs });
  assert.equal(code, 1);
  assert.match(text, /Could not write/);
});

test('an unwritable config file is reported for a per-project label too', async () => {
  const fs = fakeFs();
  fs.fail.add('write');
  const { text, code } = await run(['set', 'usageProjectLabel:client', 'Client Alpha'], { fs });
  assert.equal(code, 1);
  assert.match(text, /Could not write/);
});

test('runCli works on real defaults for a read-only command', async () => {
  const { code } = await runCli(['frobnicate']);
  assert.equal(code, 1);
});

// --- test-connection -------------------------------------------------------

test('test-connection refuses when no endpoint is configured, without sending', async () => {
  const { text, code } = await run(['test-connection'], {
    ...testDeps,
    post: async () => assert.fail('must not send without an endpoint'),
  });
  assert.equal(code, 1);
  assert.match(text, /No usageEndpoint set — there is nothing to test/);
  assert.match(text, /set usageEndpoint <url>/);
});

test('test-connection posts one zero-token record with the configured auth', async () => {
  let seen;
  const { text, code } = await run(['test-connection'], {
    ...testDeps,
    files: withEndpoint({ usageAuthType: 'Header', usageHeaderValue: 'sk-secret' }),
    post: async (args) => {
      seen = args;
      return { ok: true, status: 202 };
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.url, ENDPOINT);
  assert.deepEqual(seen.headers, { 'X-API-Key': 'sk-secret' });
  assert.deepEqual(seen.payload, {
    project: 'my-repo',
    datetime: '2026-08-28T10:15:00.000Z',
    prompt: 'connection test from claude-usage-reporter',
    session_id: 'test-connection',
    tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 },
  });
  assert.match(text, /Auth:     Header — sending X-API-Key/);
  assert.match(text, /OK — 202\. The endpoint accepted a test record/);
  assert.equal(text.includes('sk-secret'), false);
});

test('test-connection reports the rejection body, which names the missing header', async () => {
  const { text, code } = await run(['test-connection'], {
    ...testDeps,
    files: withEndpoint(),
    post: async () => ({ ok: false, status: 401, error: 'HTTP 401', body: '{"error":"Missing X-API-Key header"}' }),
  });
  assert.equal(code, 1);
  assert.match(text, /Auth:     None — sending no auth header/);
  assert.match(text, /FAILED — HTTP 401/);
  assert.match(text, /Response: \{"error":"Missing X-API-Key header"\}/);
  assert.match(text, /Current usageAuthType is "None"/);
});

test('test-connection explains a 403 the same way and a transport failure differently', async () => {
  const forbidden = await run(['test-connection'], {
    ...testDeps,
    files: withEndpoint(),
    post: async () => ({ ok: false, status: 403, error: 'HTTP 403', body: '' }),
  });
  assert.match(forbidden.text, /rejected the credentials/);
  assert.doesNotMatch(forbidden.text, /Response:/);

  const offline = await run(['test-connection'], {
    ...testDeps,
    files: withEndpoint(),
    post: async () => ({ ok: false, status: 0, error: 'ETIMEDOUT' }),
  });
  assert.match(offline.text, /FAILED — ETIMEDOUT/);
  assert.match(offline.text, /No HTTP response — check the URL/);
});

test('test-connection surfaces config and auth warnings', async () => {
  const { text } = await run(['test-connection'], {
    ...testDeps,
    files: withEndpoint({ usageDisplay: 'loud', usageAuthType: 'Bearer' }),
    post: async () => ({ ok: true, status: 200 }),
  });
  assert.match(text, /warning: Unknown usageDisplay/);
  assert.match(text, /warning: .*usageAuthToken is not set/);
});

test('test-connection uses real defaults for cwd and clock', async () => {
  let seen;
  await runCli(['test-connection'], {
    env: env(),
    readFile: fakeReader(withEndpoint()),
    fs: fakeFs(),
    post: async (args) => {
      seen = args;
      return { ok: true, status: 200 };
    },
  });
  assert.equal(seen.payload.project, 'claude-usage');
  assert.match(seen.payload.datetime, /^\d{4}-\d\d-\d\dT/);
});
