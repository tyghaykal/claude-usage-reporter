/**
 * Config command implementation — inspect and edit settings without hand-editing
 * JSON. Secret values are shown as `***set***` and never echoed back (FRD §12).
 */

import { readFileSync } from 'node:fs';
import { COMMAND, DEFAULTS, ENV_KEYS, SECRET_KEYS, authHeaders, configPath, loadConfig, maskConfig } from './config.mjs';
import { deriveProject } from './project.mjs';
import { postUsage } from './sender.mjs';
import { fsDefaults, readJson, writeJson } from './store.mjs';

// usageProjectLabels is a map (project name -> label); it's edited only through
// the namespaced usageProjectLabel:<project> key below, never set directly.
const KEYS = Object.keys(DEFAULTS).filter((key) => key !== 'usageProjectLabels');
const PROJECT_LABEL_KEY = /^usageProjectLabel:(.+)$/;

const USAGE = [
  'Usage:',
  `  ${COMMAND}`,
  '      show current settings (secrets masked)',
  `  ${COMMAND} set <key> <value>`,
  `  ${COMMAND} unset <key>`,
  `  ${COMMAND} set usageProjectLabel:<project> <value>`,
  `  ${COMMAND} unset usageProjectLabel:<project>`,
  '      friendlier name for one project — <project> is the repo/dir name shown as "project" in reports;',
  '      a project with no override reports under that real name',
  `  ${COMMAND} test-connection`,
  '      POST one zero-token record to the configured endpoint and report the result',
  '',
  `Keys: ${KEYS.join(', ')}`,
].join('\n');

function show(config, warnings, path, env) {
  const masked = maskConfig(config);
  const rows = KEYS.map((key) => {
    const source = env[ENV_KEYS[key]] !== undefined ? ' (env available)' : '';
    return `  ${key.padEnd(26)} ${JSON.stringify(masked[key])}${source}`;
  });
  const overrides = Object.entries(config.usageProjectLabels);
  return [
    `Config file: ${path}`,
    '',
    ...rows,
    ...(overrides.length
      ? ['', 'Per-project overrides:', ...overrides.map(([p, l]) => `  usageProjectLabel:${p.padEnd(20)} ${JSON.stringify(l)}`)]
      : []),
    '',
    config.usageEndpoint
      ? `Reporting to ${config.usageEndpoint} — prompt text leaves this machine on every call.`
      : 'No endpoint set — nothing leaves this machine; usage prints to the terminal.',
    ...(warnings.length ? ['', ...warnings.map((w) => `warning: ${w}`)] : []),
  ].join('\n');
}

/**
 * Sends one real-shaped record with zero tokens, so the user can verify auth and
 * schema acceptance without waiting for a prompt to complete. This is the only
 * place the plugin talks to the network on demand rather than after a turn.
 */
async function testConnection({ env, readFile, post, cwd, now }) {
  const { config, warnings } = loadConfig({ env, readFile });
  const lines = warnings.map((w) => `warning: ${w}`);

  if (!config.usageEndpoint) {
    lines.push('No usageEndpoint set — there is nothing to test.', '', `Set one with:  ${COMMAND} set usageEndpoint <url>`);
    return { text: lines.join('\n'), code: 1 };
  }

  const { headers, warnings: authWarnings } = authHeaders(config);
  lines.push(...authWarnings.map((w) => `warning: ${w}`));

  const names = Object.keys(headers);
  lines.push(
    `Endpoint: ${config.usageEndpoint}`,
    `Auth:     ${config.usageAuthType}${names.length ? ` — sending ${names.join(', ')}` : ' — sending no auth header'}`,
    '',
  );

  const result = await post({
    url: config.usageEndpoint,
    headers,
    timeoutMs: config.usageTimeoutMs,
    payload: {
      project: deriveProject(cwd),
      datetime: now().toISOString(),
      prompt: 'connection test from claude-usage-reporter',
      session_id: 'test-connection',
      tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0, total: 0 },
    },
  });

  if (result.ok) {
    lines.push(`OK — ${result.status}. The endpoint accepted a test record.`, 'It stored a zero-token entry; remove it if your backend keeps it.');
    return { text: lines.join('\n'), code: 0 };
  }

  lines.push(`FAILED — ${result.error}.`);
  if (result.body) lines.push(`Response: ${result.body}`);
  if (result.status === 401 || result.status === 403) {
    lines.push('', `The endpoint rejected the credentials. Current usageAuthType is "${config.usageAuthType}".`, 'The response above usually names the header it wants.');
  } else if (result.status === 0) {
    lines.push('', 'No HTTP response — check the URL, that the service is running, and usageTimeoutMs.');
  }
  return { text: lines.join('\n'), code: 1 };
}

/**
 * @returns {Promise<{text: string, code: number}>}
 */
export async function runCli(argv, {
  env = process.env,
  readFile = readFileSync,
  fs = fsDefaults,
  post = postUsage,
  cwd = process.cwd(),
  now = () => new Date(),
} = {}) {
  const path = configPath(env);
  const [command, key, ...rest] = argv;

  if (command === undefined || command === 'show') {
    const { config, warnings } = loadConfig({ env, readFile });
    return { text: show(config, warnings, path, env), code: 0 };
  }

  if (command === 'test-connection') return testConnection({ env, readFile, post, cwd, now });

  if (command !== 'set' && command !== 'unset') {
    return { text: `Unknown command "${command}".\n\n${USAGE}`, code: 1 };
  }

  const projectMatch = key ? PROJECT_LABEL_KEY.exec(key) : null;
  if (!key || !(KEYS.includes(key) || projectMatch)) {
    return { text: `Unknown setting "${key || ''}".\n\n${USAGE}`, code: 1 };
  }

  const stored = readJson(path, fs);

  if (projectMatch) {
    const project = projectMatch[1];
    const labels = { ...(stored.usageProjectLabels || {}) };
    if (command === 'unset') {
      delete labels[project];
    } else {
      const value = rest.join(' ');
      if (!value) return { text: `set ${key} needs a value.\n\n${USAGE}`, code: 1 };
      labels[project] = value;
    }
    stored.usageProjectLabels = labels;
    if (!writeJson(path, stored, fs)) return { text: `Could not write ${path}.`, code: 1 };
    const verb = command === 'unset' ? `Removed ${key}.` : `Set ${key} = ${JSON.stringify(labels[project])}.`;
    return { text: `${verb} Takes effect on the next prompt.`, code: 0 };
  }

  if (command === 'unset') {
    delete stored[key];
  } else {
    const value = rest.join(' ');
    if (!value) return { text: `set ${key} needs a value.\n\n${USAGE}`, code: 1 };
    stored[key] = value;
  }

  if (!writeJson(path, stored, fs)) {
    return { text: `Could not write ${path}.`, code: 1 };
  }

  const shown = SECRET_KEYS.has(key) ? '***set***' : JSON.stringify(stored[key]);
  const verb = command === 'unset' ? `Removed ${key}.` : `Set ${key} = ${shown}.`;
  return { text: `${verb} Takes effect on the next prompt.`, code: 0 };
}

export { USAGE };
