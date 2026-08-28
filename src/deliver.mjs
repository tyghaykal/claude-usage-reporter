/**
 * What the detached sender actually does: flush the retry queue, send the new
 * records, and re-queue whatever failed. Runs out of band, so failures are
 * written to the log rather than shown — a dead endpoint is never an
 * interruption (FR-10).
 */

import { readFileSync } from 'node:fs';
import { authHeaders, loadConfig, logPath, queuePath } from './config.mjs';
import { postUsage, safeTarget, sendAll } from './sender.mjs';
import { appendLog, drain, enqueue, fsDefaults } from './store.mjs';

export async function deliver(records, {
  env = process.env,
  readFile = readFileSync,
  fs = fsDefaults,
  post = postUsage,
  now = () => new Date(),
} = {}) {
  const { config, warnings } = loadConfig({ env, readFile });
  const log = (message) => appendLog(logPath(env), message, fs, now);

  if (!config.usageEndpoint) {
    // Endpoint cleared between dispatch and delivery — hold the records.
    for (const record of records) enqueue(queuePath(env), record, fs);
    return { sent: 0, failed: records.length, skipped: true };
  }
  for (const warning of warnings) log(warning);

  const { headers, warnings: authWarnings } = authHeaders(config);
  for (const warning of authWarnings) log(warning);

  const queued = config.usageRetry ? drain(queuePath(env), fs) : [];
  const target = safeTarget(config.usageEndpoint);

  const result = await sendAll([...queued, ...records], {
    url: config.usageEndpoint,
    headers,
    timeoutMs: config.usageTimeoutMs,
    retry: config.usageRetry,
    post,
    onFailure: (record, outcome, retry) => {
      log(`push to ${target} failed: ${outcome.error}${retry ? ' — queued for retry' : ''}`);
      if (retry) enqueue(queuePath(env), record, fs);
    },
  });
  return { ...result, skipped: false };
}
