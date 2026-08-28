/**
 * Endpoint delivery.
 *
 * The hook process never awaits the network (FR-9): it hands the payload to a
 * detached child and exits. The child does the POST, and on failure queues the
 * record for the next session (FRD §14 Q3).
 */

import { spawn } from 'node:child_process';

/** Host only — never the full URL, which may carry credentials in userinfo. */
export function safeTarget(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'endpoint';
  }
}

export async function postUsage({ url, headers = {}, payload, timeoutMs = 5000, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * Fires the sender child and returns immediately.
 * @returns {boolean} whether the child was launched.
 */
export function dispatch(records, { script, spawnImpl = spawn, execPath = process.execPath, env = process.env } = {}) {
  try {
    const child = spawnImpl(execPath, [script], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env,
    });
    child.stdin.end(JSON.stringify(records));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The detached child's work: send every record, queue the ones that fail.
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendAll(records, { url, headers, timeoutMs, retry, onFailure, post = postUsage }) {
  let sent = 0;
  let failed = 0;
  for (const record of records) {
    const result = await post({ url, headers, payload: record, timeoutMs });
    if (result.ok) {
      sent += 1;
      continue;
    }
    failed += 1;
    onFailure(record, result, retry);
  }
  return { sent, failed };
}
