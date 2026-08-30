/**
 * What the detached sender actually does: flush the retry queue, send the new
 * records, and re-queue whatever failed. Runs out of band, so failures are
 * written to the log rather than shown — a dead endpoint is never an
 * interruption (FR-10).
 */

import { readFileSync } from 'node:fs';
import { authHeaders, loadConfig, logPath, queuePath, resolveProjectConfig } from './config.mjs';
import { postUsage, safeTarget, sendAll } from './sender.mjs';
import { appendLog, drain, enqueue, fsDefaults } from './store.mjs';

/** Groups records by their `project` field, so each project can route to its own override. */
function groupByProject(records) {
  const groups = new Map();
  for (const record of records) {
    const project = record && typeof record === 'object' ? record.project : undefined;
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(record);
  }
  return groups;
}

export async function deliver(records, {
  env = process.env,
  readFile = readFileSync,
  fs = fsDefaults,
  post = postUsage,
  now = () => new Date(),
} = {}) {
  const { config, warnings } = loadConfig({ env, readFile });
  const log = (message) => appendLog(logPath(env), message, fs, now);
  for (const warning of warnings) log(warning);

  const queued = config.usageRetry ? drain(queuePath(env), fs) : [];
  const all = [...queued, ...records];
  if (all.length === 0) return { sent: 0, failed: 0, skipped: !config.usageEndpoint };

  let sent = 0;
  let failed = 0;
  let skipped = false;

  for (const [project, groupRecords] of groupByProject(all)) {
    const projectConfig = resolveProjectConfig(config, project);
    if (!projectConfig.usageEndpoint) {
      // No endpoint for this project (cleared, or never set) — hold its records.
      for (const record of groupRecords) enqueue(queuePath(env), record, fs);
      failed += groupRecords.length;
      skipped = true;
      continue;
    }

    const { headers, warnings: authWarnings } = authHeaders(projectConfig);
    for (const warning of authWarnings) log(warning);
    const target = safeTarget(projectConfig.usageEndpoint);

    const result = await sendAll(groupRecords, {
      url: projectConfig.usageEndpoint,
      headers,
      timeoutMs: projectConfig.usageTimeoutMs,
      retry: projectConfig.usageRetry,
      post,
      onFailure: (record, outcome, retry) => {
        log(`push to ${target} failed: ${outcome.error}${retry ? ' — queued for retry' : ''}`);
        if (retry) enqueue(queuePath(env), record, fs);
      },
    });
    sent += result.sent;
    failed += result.failed;
  }

  return { sent, failed, skipped };
}
