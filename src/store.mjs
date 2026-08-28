/**
 * Local files the plugin owns: first-run state, the retry queue, and the
 * failure log. All are written 0600 because the queue can hold prompt text.
 * Every operation is best-effort — a storage failure must never break a
 * Claude Code session (NFR "Reliability").
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MODE = 0o600;

/** Max queued records; oldest are dropped first so the file stays bounded. */
export const QUEUE_LIMIT = 500;
const LOG_LIMIT_BYTES = 256 * 1024;

export const fsDefaults = { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync };

function writeSecure(path, contents, fs) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, contents, { mode: MODE });
}

export function readJson(path, fs = fsDefaults) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeJson(path, state, fs = fsDefaults) {
  try {
    writeSecure(path, `${JSON.stringify(state, null, 2)}\n`, fs);
    return true;
  } catch {
    return false;
  }
}

export function enqueue(path, record, fs = fsDefaults, limit = QUEUE_LIMIT) {
  const records = [...drain(path, fs, { clear: false }), record];
  const kept = records.slice(-limit);
  try {
    writeSecure(path, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', fs);
    return kept.length;
  } catch {
    return 0;
  }
}

/** Reads queued records and (by default) empties the queue. */
export function drain(path, fs = fsDefaults, { clear = true } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Drop an unparseable record rather than blocking the whole queue.
    }
  }
  if (clear && records.length) {
    try {
      writeSecure(path, '', fs);
    } catch {
      return [];
    }
  }
  return records;
}

export function appendLog(path, message, fs = fsDefaults, now = () => new Date()) {
  try {
    let size = 0;
    try {
      size = fs.statSync(path).size;
    } catch {
      size = 0;
    }
    const line = `${now().toISOString()} ${message}\n`;
    if (size > LOG_LIMIT_BYTES) writeSecure(path, line, fs);
    else {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.appendFileSync(path, line, { mode: MODE });
    }
    return true;
  } catch {
    return false;
  }
}
