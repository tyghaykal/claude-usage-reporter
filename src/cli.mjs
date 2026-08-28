/**
 * `/usage-config` implementation — inspect and edit settings without hand-editing
 * JSON. Secret values are shown as `***set***` and never echoed back (FRD §12).
 */

import { readFileSync } from 'node:fs';
import { DEFAULTS, ENV_KEYS, SECRET_KEYS, configPath, loadConfig, maskConfig } from './config.mjs';
import { fsDefaults, readJson, writeJson } from './store.mjs';

const KEYS = Object.keys(DEFAULTS);

const USAGE = [
  'Usage:',
  '  /usage-config                      show current settings (secrets masked)',
  '  /usage-config set <key> <value>    set a setting',
  '  /usage-config unset <key>          remove a setting',
  '',
  `Keys: ${KEYS.join(', ')}`,
].join('\n');

function show(config, warnings, path, env) {
  const masked = maskConfig(config);
  const rows = KEYS.map((key) => {
    const source = env[ENV_KEYS[key]] !== undefined ? ' (env available)' : '';
    return `  ${key.padEnd(26)} ${JSON.stringify(masked[key])}${source}`;
  });
  return [
    `Config file: ${path}`,
    '',
    ...rows,
    '',
    config.usageEndpoint
      ? `Reporting to ${config.usageEndpoint} — prompt text leaves this machine on every call.`
      : 'No endpoint set — nothing leaves this machine; usage prints to the terminal.',
    ...(warnings.length ? ['', ...warnings.map((w) => `warning: ${w}`)] : []),
  ].join('\n');
}

/**
 * @returns {{text: string, code: number}}
 */
export function runCli(argv, { env = process.env, readFile = readFileSync, fs = fsDefaults } = {}) {
  const path = configPath(env);
  const [command, key, ...rest] = argv;

  if (command === undefined || command === 'show') {
    const { config, warnings } = loadConfig({ env, readFile });
    return { text: show(config, warnings, path, env), code: 0 };
  }

  if (command !== 'set' && command !== 'unset') {
    return { text: `Unknown command "${command}".\n\n${USAGE}`, code: 1 };
  }
  if (!key || !KEYS.includes(key)) {
    return { text: `Unknown setting "${key || ''}".\n\n${USAGE}`, code: 1 };
  }

  const stored = readJson(path, fs);
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
