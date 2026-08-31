/**
 * Settings resolution for the usage reporter.
 *
 * Precedence (§10 of the FRD): plugin config file > environment variable >
 * built-in default. Every value is validated at this boundary; an invalid
 * value never reaches the network layer, it falls back to the default and
 * emits a warning instead.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How the user actually types the config command. Claude Code namespaces plugin
 * commands as `/<plugin>:<command>`, so the bare `/usage-config` does not
 * resolve. Defined once here because it appears in the notice, the terminal
 * report, and the command's own help.
 */
export const COMMAND = '/claude-usage-reporter:usage-config';

export const AUTH_TYPES = ['None', 'Bearer', 'Basic', 'Header', 'Key Pair'];
export const DISPLAY_MODES = ['auto', 'always', 'off'];
export const PROMPT_MODES = ['full', 'none'];

/** Values that must never be printed, logged, or echoed back to the user. */
export const SECRET_KEYS = new Set([
  'usageAuthToken',
  'usageHeaderValue',
  'usageKeyIdValue',
  'usageKeySecretValue',
]);

/** Config key -> environment variable fallback. */
export const ENV_KEYS = {
  usageEndpoint: 'CC_USAGE_ENDPOINT',
  usageAuthType: 'CC_USAGE_AUTH_TYPE',
  usageAuthToken: 'CC_USAGE_AUTH_TOKEN',
  usageHeaderName: 'CC_USAGE_HEADER_NAME',
  usageHeaderValue: 'CC_USAGE_HEADER_VALUE',
  usageKeyIdHeaderName: 'CC_USAGE_KEY_ID_HEADER_NAME',
  usageKeyIdValue: 'CC_USAGE_KEY_ID_VALUE',
  usageKeySecretHeaderName: 'CC_USAGE_KEY_SECRET_HEADER_NAME',
  usageKeySecretValue: 'CC_USAGE_KEY_SECRET_VALUE',
  usageDisplay: 'CC_USAGE_DISPLAY',
  usageEnabled: 'CC_USAGE_ENABLED',
  usageUser: 'CC_USAGE_USER',
  usagePromptMode: 'CC_USAGE_PROMPT_MODE',
  usageRetry: 'CC_USAGE_RETRY',
  usageTimeoutMs: 'CC_USAGE_TIMEOUT_MS',
  usageCurrency: 'CC_USAGE_CURRENCY',
  usageCurrencyRate: 'CC_USAGE_CURRENCY_RATE',
};

export const DEFAULTS = {
  usageEndpoint: '',
  usageAuthType: 'None',
  usageAuthToken: '',
  usageHeaderName: 'X-API-Key',
  usageHeaderValue: '',
  usageKeyIdHeaderName: 'X-API-Key-Id',
  usageKeyIdValue: '',
  usageKeySecretHeaderName: 'X-API-Key-Secret',
  usageKeySecretValue: '',
  usageDisplay: 'auto',
  // Master switch: false stops the reporter cold — no terminal report, no
  // network push, for whatever this applies to (globally, or one project via
  // `usageProject:<project>:usageEnabled false`). Unlike `usageDisplay: off`,
  // which only silences the terminal, this also stops sending to the endpoint.
  usageEnabled: true,
  // Per-project friendly names, keyed by the `project` value (repo/dir name) a
  // report would otherwise use. Set via `usageProjectLabel:<project>`, not
  // directly — see cli.mjs. File-only: there's no sane single env var for a map.
  // A project with no entry here reports under its real repo/directory name.
  usageProjectLabels: {},
  // Per-project setting overrides (own endpoint, own auth, or `usageEnabled:
  // false` to opt a project out entirely), keyed the same way. Set via
  // `usageProject:<project>:<key>`, not directly — see cli.mjs. File-only.
  // A project with no entry here uses the settings above unchanged.
  usageProjects: {},
  usageUser: '',
  usagePromptMode: 'full',
  usageRetry: true,
  usageTimeoutMs: 5000,
  // Display currency for the cost estimate. The price table is USD; any other
  // 3-letter code (e.g. IDR) translates the estimate live at report time.
  // 'USD' (default) disables translation entirely.
  usageCurrency: 'USD',
  // Optional manual USD→currency rate override. When set to a positive number
  // it always wins and no FX fetch happens — useful for pinning a settlement
  // rate or working fully offline. Empty/null means "fetch live".
  usageCurrencyRate: '',
};

/** Directory holding the plugin's own files (config, state, queue, log). */
export function dataDir(env = process.env) {
  return env.CLAUDE_USAGE_HOME || join(homedir(), '.claude');
}

export function configPath(env = process.env) {
  return env.CLAUDE_USAGE_CONFIG || join(dataDir(env), 'claude-usage.json');
}

export function statePath(env = process.env) {
  return join(dataDir(env), 'claude-usage-state.json');
}

export function queuePath(env = process.env) {
  return join(dataDir(env), 'claude-usage-queue.jsonl');
}

export function logPath(env = process.env) {
  return join(dataDir(env), 'claude-usage.log');
}

/** Reads the config file. A missing or malformed file is not an error. */
export function readConfigFile(path, readFile = readFileSync) {
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch {
    return { data: {}, warnings: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, warnings: [`${path} is not a JSON object — ignoring it.`] };
    }
    return { data: parsed, warnings: [] };
  } catch {
    return { data: {}, warnings: [`${path} is not valid JSON — ignoring it.`] };
  }
}

function normalizeAuthType(value, warnings) {
  const key = String(value).toLowerCase().replace(/[\s_-]+/g, '');
  const match = AUTH_TYPES.find((t) => t.toLowerCase().replace(/\s+/g, '') === key);
  if (match) return match;
  warnings.push(`Unknown usageAuthType "${value}" — falling back to "None".`);
  return 'None';
}

function normalizeEndpoint(value, warnings) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    warnings.push(`usageEndpoint "${value}" is not a valid URL — no data will be sent.`);
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warnings.push(`usageEndpoint must be http(s) — "${value}" is not. No data will be sent.`);
    return '';
  }
  return url.toString();
}

function normalizePromptMode(value, warnings) {
  const raw = String(value).trim();
  if (PROMPT_MODES.includes(raw)) return raw;
  const truncate = /^truncate:(\d+)$/.exec(raw);
  if (truncate && Number(truncate[1]) > 0) return `truncate:${Number(truncate[1])}`;
  warnings.push(`Unknown usagePromptMode "${value}" — falling back to "full".`);
  return 'full';
}

function normalizeBool(value) {
  if (typeof value === 'boolean') return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function normalizeProjectLabels(value, warnings) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  warnings.push('usageProjectLabels is not an object — ignoring it.');
  return {};
}

function normalizeProjectOverrides(value, warnings) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  warnings.push('usageProjects is not an object — ignoring it.');
  return {};
}

function normalizeTimeout(value, warnings) {
  const ms = Number(value);
  if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);
  warnings.push(`usageTimeoutMs "${value}" is not a positive number — using ${DEFAULTS.usageTimeoutMs}.`);
  return DEFAULTS.usageTimeoutMs;
}

function normalizeCurrencyCode(value, warnings) {
  const raw = String(value).trim().toUpperCase();
  if (raw === '' || raw === 'USD') return 'USD';
  if (/^[A-Z]{3}$/.test(raw)) return raw;
  warnings.push(`Unknown usageCurrency "${value}" — falling back to "USD" (no translation).`);
  return 'USD';
}

function normalizeCurrencyRate(value, warnings) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  warnings.push(`usageCurrencyRate "${value}" is not a positive number — ignoring it (will fetch live).`);
  return '';
}

/** The routing/behaviour fields — shared by the global config and any per-project override. */
function normalizeCore(config, warnings) {
  if (config.usageEndpoint) config.usageEndpoint = normalizeEndpoint(config.usageEndpoint, warnings);
  config.usageAuthType = normalizeAuthType(config.usageAuthType, warnings);
  if (!DISPLAY_MODES.includes(config.usageDisplay)) {
    warnings.push(`Unknown usageDisplay "${config.usageDisplay}" — falling back to "auto".`);
    config.usageDisplay = 'auto';
  }
  config.usagePromptMode = normalizePromptMode(config.usagePromptMode, warnings);
  config.usageRetry = normalizeBool(config.usageRetry);
  config.usageEnabled = normalizeBool(config.usageEnabled);
  config.usageTimeoutMs = normalizeTimeout(config.usageTimeoutMs, warnings);
  config.usageUser = String(config.usageUser);
  config.usageCurrency = normalizeCurrencyCode(config.usageCurrency, warnings);
  config.usageCurrencyRate = normalizeCurrencyRate(config.usageCurrencyRate, warnings);
  return config;
}

/**
 * Builds the effective config.
 * @returns {{config: object, warnings: string[]}}
 */
export function loadConfig({ env = process.env, readFile = readFileSync } = {}) {
  const file = readConfigFile(configPath(env), readFile);
  const warnings = [...file.warnings];
  const config = { ...DEFAULTS };

  for (const key of Object.keys(DEFAULTS)) {
    const fromFile = file.data[key];
    const fromEnv = env[ENV_KEYS[key]];
    const value = fromFile !== undefined && fromFile !== null ? fromFile : fromEnv;
    if (value === undefined || value === '') continue;
    config[key] = value;
  }

  normalizeCore(config, warnings);
  config.usageProjectLabels = normalizeProjectLabels(config.usageProjectLabels, warnings);
  config.usageProjects = normalizeProjectOverrides(config.usageProjects, warnings);

  return { config, warnings };
}

/**
 * Effective config for one project: the global config with that project's
 * overrides (if any) merged in and re-validated the same way a global value
 * would be — an invalid override falls back rather than breaking routing.
 */
export function resolveProjectConfig(config, project) {
  const override = config.usageProjects[project];
  if (!override || typeof override !== 'object' || Array.isArray(override)) return config;
  return normalizeCore({ ...config, ...override }, []);
}

/** The label to show/send for `project`: its configured override, else the real repo/directory name itself. */
export function resolveProjectLabel(config, project) {
  return config.usageProjectLabels[project] || project;
}

/**
 * Whether the terminal report should be printed for this call (FR-17).
 * `auto` shows it only while no endpoint is configured.
 */
export function shouldDisplay(config) {
  if (config.usageDisplay === 'off') return false;
  if (config.usageDisplay === 'always') return true;
  return !config.usageEndpoint;
}

/**
 * Request headers carrying the user's own backend credentials.
 * Credentials are never logged or displayed — see NFR "Safety".
 * @returns {{headers: object, warnings: string[]}}
 */
export function authHeaders(config) {
  const headers = {};
  const warnings = [];
  const require = (value, label) => {
    if (value) return true;
    warnings.push(`usageAuthType is "${config.usageAuthType}" but ${label} is not set — sending unauthenticated.`);
    return false;
  };

  switch (config.usageAuthType) {
    case 'Bearer':
      if (require(config.usageAuthToken, 'usageAuthToken')) {
        headers.Authorization = `Bearer ${config.usageAuthToken}`;
      }
      break;
    case 'Basic':
      if (require(config.usageAuthToken, 'usageAuthToken')) {
        // A "user:pass" value is encoded here; anything else is assumed
        // to be a pre-encoded credential and passed through untouched.
        const token = config.usageAuthToken.includes(':')
          ? Buffer.from(config.usageAuthToken, 'utf8').toString('base64')
          : config.usageAuthToken;
        headers.Authorization = `Basic ${token}`;
      }
      break;
    case 'Header':
      if (require(config.usageHeaderValue, 'usageHeaderValue')) {
        headers[config.usageHeaderName] = config.usageHeaderValue;
      }
      break;
    case 'Key Pair':
      if (require(config.usageKeyIdValue, 'usageKeyIdValue')) {
        headers[config.usageKeyIdHeaderName] = config.usageKeyIdValue;
      }
      if (require(config.usageKeySecretValue, 'usageKeySecretValue')) {
        headers[config.usageKeySecretHeaderName] = config.usageKeySecretValue;
      }
      break;
    default:
      break;
  }
  return { headers, warnings };
}

/** Config with every secret replaced by a placeholder, safe to print. */
export function maskConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEYS.has(key) ? (value ? '***set***' : '') : value;
  }
  return out;
}
