/**
 * Rebuilds usage records from Claude Code's own local transcripts
 * (`~/.claude/projects/**\/*.jsonl`) for turns that happened while the
 * plugin was disabled, the endpoint was down, or before an endpoint existed.
 *
 * Reuses the same config resolution, `buildPayload`, and delivery path
 * (`deliver.mjs`) as the live hooks, so a backfilled record is identical in
 * shape to one the hook would have sent at the time — just later, and with
 * its original timestamp preserved.
 */

import { readdirSync, statSync as nodeStatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, dataDir, resolveProjectConfig, resolveProjectLabel, resolveProvider } from './config.mjs';
import { deliver } from './deliver.mjs';
import { deriveProject } from './project.mjs';
import { buildPayload } from './report.mjs';
import { fsDefaults, readJson, writeJson } from './store.mjs';
import { allSubagentUsage, allTurns, readTranscript } from './transcript.mjs';

/** Where Claude Code writes session transcripts — mirrors `dataDir()`. */
export function projectsDir(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** Turns already pushed by a previous `--send` run, so a re-run never resends them. */
export function backfillStatePath(env = process.env) {
  return join(dataDir(env), 'claude-usage-backfill-state.json');
}

export function turnKey(sessionId, promptId) {
  return `${sessionId}:${promptId}`;
}

/** Every `*.jsonl` transcript under `projectsDir()`, recursing one directory per project. */
export function listTranscriptFiles(env = process.env, fs = { readdirSync, statSync: nodeStatSync }) {
  const root = projectsDir(env);
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const files = [];
  for (const name of projectDirs) {
    const dir = join(root, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) files.push(join(dir, entry));
    }
  }
  return files;
}

/**
 * Parses `--since`/`--until` as local time. A bare date (no time component)
 * with `end: true` is pushed to the last instant of that day, so `--until`
 * includes the whole day it names.
 */
export function parseBound(value, end = false) {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const iso = bare && end ? `${value.trim()}T23:59:59.999` : value.trim();
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not a valid date: "${value}"`);
  return ms;
}

function firstCwd(entries) {
  const withCwd = entries.find((e) => e && e.cwd);
  return withCwd ? withCwd.cwd : '';
}

/**
 * Every candidate usage record found across all transcripts, filtered per
 * `options`. A record is either a sendable payload (has `key`/`tokens`) or a
 * skip marker (`{ skip: 'no-timestamp' | 'zero-tokens', project }`) counted
 * in the summary but never sent.
 */
export function collectRecords(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const readFile = deps.readFile;
  const exists = deps.exists;
  const fs = deps.listFs;

  const { config } = loadConfig({ env, readFile });
  const sinceMs = options.since ? parseBound(options.since, false) : null;
  const untilMs = options.until ? parseBound(options.until, true) : null;
  const projects = options.projects && options.projects.length ? options.projects : null;
  const sessions = options.sessions && options.sessions.length ? options.sessions : null;
  const turns = options.turns && options.turns.length ? new Set(options.turns) : null;
  const provider = resolveProvider(env);

  const records = [];
  const inRange = (iso) => {
    const ms = Date.parse(iso);
    if (sinceMs !== null && ms < sinceMs) return false;
    if (untilMs !== null && ms > untilMs) return false;
    return true;
  };

  const addModels = ({ project, projectLabel, projectConfig, sessionId, promptId, timestamp, prompt, models }) => {
    for (const { model, tokens } of models) {
      if (tokens.total === 0) {
        records.push({ skip: 'zero-tokens', project });
        continue;
      }
      records.push({
        project,
        projectLabel,
        sessionId,
        promptId,
        key: turnKey(sessionId, promptId),
        datetime: timestamp,
        prompt,
        model,
        tokens,
        user: projectConfig.usageUser,
        provider,
        promptMode: projectConfig.usagePromptMode,
      });
    }
  };

  for (const file of listTranscriptFiles(env, fs)) {
    const entries = readTranscript(file, readFile);
    if (!entries.length) continue;

    const project = deriveProject(firstCwd(entries), exists);
    if (projects && !projects.includes(project)) continue;
    const projectConfig = resolveProjectConfig(config, project);
    if (!options.includeDisabled && !projectConfig.usageEnabled) continue;
    const projectLabel = resolveProjectLabel(config, project);

    for (const turn of allTurns(entries)) {
      if (sessions && !sessions.includes(turn.sessionId)) continue;
      if (turns && !turns.has(turnKey(turn.sessionId, turn.promptId))) continue;
      if (!turn.timestamp) {
        records.push({ skip: 'no-timestamp', project });
        continue;
      }
      if (!inRange(turn.timestamp)) continue;
      addModels({ project, projectLabel, projectConfig, sessionId: turn.sessionId, promptId: turn.promptId, timestamp: turn.timestamp, prompt: turn.prompt, models: turn.models });
    }

    const sub = allSubagentUsage(entries);
    if (sub && (!sessions || sessions.includes(sub.sessionId)) && (!turns || turns.has(turnKey(sub.sessionId, 'subagent')))) {
      if (!sub.timestamp) {
        records.push({ skip: 'no-timestamp', project });
      } else if (inRange(sub.timestamp)) {
        addModels({ project, projectLabel, projectConfig, sessionId: sub.sessionId, promptId: 'subagent', timestamp: sub.timestamp, prompt: sub.prompt, models: sub.models });
      }
    }
  }
  return records;
}

/** Marks each sendable record as already reported (or not), against the backfill state file. */
export function markReported(records, env = process.env, fs = fsDefaults) {
  const state = readJson(backfillStatePath(env), fs);
  const reported = state.reported || {};
  return records.map((record) => (record.skip ? record : { ...record, alreadyReported: Boolean(reported[record.key]) }));
}

/** Groups sendable records by project then session for the preview table. */
export function groupForPreview(records) {
  const byProject = new Map();
  for (const record of records) {
    const project = record.project || 'unknown';
    if (!byProject.has(project)) byProject.set(project, new Map());
    const bySession = byProject.get(project);
    if (record.skip) continue;
    const key = record.sessionId || 'unknown';
    if (!bySession.has(key)) bySession.set(key, { turns: new Set(), tokens: 0, reported: 0, total: 0 });
    const bucket = bySession.get(key);
    bucket.turns.add(record.promptId);
    bucket.tokens += record.tokens.total;
    bucket.total += 1;
    if (record.alreadyReported) bucket.reported += 1;
  }
  return byProject;
}

export function formatPreview(records) {
  const groups = groupForPreview(records);
  if (groups.size === 0) return 'No matching turns found.';
  const lines = [];
  for (const [project, sessions] of groups) {
    lines.push(`${project}:`);
    for (const [sessionId, b] of sessions) {
      lines.push(`  ${sessionId}  turns: ${b.turns.size}  tokens: ${b.tokens.toLocaleString('en-US')}  already reported: ${b.reported}/${b.total}`);
    }
  }
  const skipped = {};
  for (const record of records) {
    if (record.skip) skipped[record.skip] = (skipped[record.skip] || 0) + 1;
  }
  if (skipped['no-timestamp']) lines.push('', `Skipped (no timestamp): ${skipped['no-timestamp']}`);
  if (skipped['zero-tokens']) lines.push(`Skipped (zero tokens): ${skipped['zero-tokens']}`);
  return lines.join('\n');
}

/**
 * One line per sendable record — its key (for `--turn`), date, project,
 * session, model, tokens, and whether it's already been backfilled. Lets you
 * find the exact key(s) to pass to `--turn` before committing to a send.
 */
export function formatList(records) {
  const sendable = records.filter((r) => !r.skip);
  if (!sendable.length) return 'No matching turns found.';
  return sendable
    .map((r) => `${r.key}  ${r.datetime}  ${r.project}  ${r.model || 'unknown-model'}  ${r.tokens.total.toLocaleString('en-US')} tokens${r.alreadyReported ? '  (already reported)' : ''}`)
    .join('\n');
}

/**
 * Sends the selected records through the same `deliver()` path the live
 * sender uses — same retry queue, same log, same per-project routing — then
 * persists the sent keys so a re-run without `--force` never resends them.
 * @returns {Promise<{sent: number, failed: number, skippedReported: number}>}
 */
export async function sendRecords(records, { env = process.env, readFile, fs = fsDefaults, post, now = () => new Date(), force = false } = {}) {
  const sendable = records.filter((r) => !r.skip && (force || !r.alreadyReported));
  const skippedReported = records.filter((r) => !r.skip && r.alreadyReported).length;
  const payloads = sendable.map((r) =>
    buildPayload({
      project: r.project,
      projectLabel: r.projectLabel,
      datetime: r.datetime,
      prompt: r.prompt,
      sessionId: r.sessionId,
      tokens: r.tokens,
      model: r.model,
      user: r.user,
      provider: r.provider,
      promptMode: r.promptMode,
      turnId: r.key,
    }),
  );

  const result = await deliver(payloads, { env, readFile, fs, post, now });

  const state = readJson(backfillStatePath(env), fs);
  const reported = { ...(state.reported || {}) };
  for (const record of sendable) reported[record.key] = true;
  writeJson(backfillStatePath(env), { ...state, reported }, fs);

  return { ...result, skippedReported };
}
