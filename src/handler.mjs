/**
 * Hook orchestration. Pure with respect to IO: every side effect arrives
 * through `deps`, so the whole flow is testable without touching the disk,
 * the network, or a real Claude Code session.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, logPath, queuePath, resolveProjectConfig, resolveProjectLabel, resolveProvider, shouldDisplay, statePath } from './config.mjs';
import { deriveProject } from './project.mjs';
import { loadPricing } from './pricing.mjs';
import { FIRST_RUN_NOTICE, buildPayload, formatReport } from './report.mjs';
import { dispatch } from './sender.mjs';
import { appendLog, drain, fsDefaults, readJson, writeJson } from './store.mjs';
import { EMPTY_TOKENS, extractSubagentUsage, extractTurn, previousTurn, readTranscript, sessionSummary } from './transcript.mjs';

export const SENDER_SCRIPT = fileURLToPath(new URL('../bin/send.mjs', import.meta.url));

function defaults(overrides = {}) {
  return {
    env: process.env,
    fs: fsDefaults,
    readFile: readFileSync,
    exists: existsSync,
    now: () => new Date(),
    models: undefined,
    senderScript: SENDER_SCRIPT,
    dispatchImpl: dispatch,
    ...overrides,
  };
}

function join(parts) {
  return parts.filter(Boolean).join('\n\n');
}

/** Shows the first-run notice once, and reports whether pushing is allowed yet. */
function consumeNotice(deps, env) {
  const path = statePath(env);
  const state = readJson(path, deps.fs);
  if (state.noticeShown) return { notice: '', state, path };
  writeJson(path, { ...state, noticeShown: true }, deps.fs);
  return { notice: FIRST_RUN_NOTICE, state, path };
}

function emptyTurn(input) {
  return {
    prompt: '',
    tokens: { ...EMPTY_TOKENS },
    model: '',
    models: [{ model: '', tokens: { ...EMPTY_TOKENS } }],
    sessionId: input.session_id || '',
    cwd: input.cwd || '',
    promptId: input.prompt_id || '',
  };
}

/**
 * Builds one payload per model bucket, pushes them in a single dispatch call,
 * and appends the terminal report (one block per model, session total on the
 * last). Shared by the main-turn and subagent capture paths.
 */
function deliverUsage({ deps, notice, projectConfig, projectLabel, project, datetime, prompt, sessionId, models, error, messages, entries }) {
  const provider = resolveProvider(deps.env);
  // FR-16 / PD-1: the first run discloses before it can ever transmit.
  if (projectConfig.usageEndpoint && !notice) {
    const payloads = models.map(({ model, tokens }) =>
      buildPayload({
        project,
        projectLabel,
        datetime,
        prompt,
        sessionId,
        tokens,
        model,
        user: projectConfig.usageUser,
        provider,
        promptMode: projectConfig.usagePromptMode,
        error,
      }),
    );
    const launched = deps.dispatchImpl(payloads, { script: deps.senderScript, env: deps.env });
    if (!launched) {
      appendLog(logPath(deps.env), 'failed to launch usage sender', deps.fs, deps.now);
      messages.push('Claude Usage Reporter: could not start the background sender; this call was not reported.');
    }
  }

  if (shouldDisplay(projectConfig)) {
    models.forEach(({ model, tokens }, i) => {
      messages.push(
        formatReport({
          project: projectLabel,
          datetime,
          tokens,
          model,
          provider,
          session: i === models.length - 1 ? sessionSummary(entries) : null,
          endpointConfigured: Boolean(projectConfig.usageEndpoint),
          models: deps.models || loadPricing(),
          error,
        }),
      );
    });
  }
}

/**
 * Shared capture path for Stop / StopFailure / SessionEnd / UserPromptSubmit.
 *
 * `skipEmpty` keeps a successful Stop (and a clean SessionEnd) from sending a
 * zero-token record. StopFailure still reports even with no tokens, because
 * the error mark itself is the signal — an auth failure often never produced
 * usage. `extract` picks which turn out of the transcript: the latest one
 * (the default) for Stop/StopFailure/SessionEnd, or the one before the
 * newest prompt for UserPromptSubmit, catching a turn the user cancelled.
 */
function reportTurn(input, overrides, { error = null, skipEmpty = true, allowEmptyTurn = false, extract = extractTurn } = {}) {
  const deps = defaults(overrides);
  const { config, warnings } = loadConfig({ env: deps.env, readFile: deps.readFile });
  const { notice, state, path: stateFile } = consumeNotice(deps, deps.env);

  const entries = readTranscript(input.transcript_path, deps.readFile);
  const turn = extract(entries) || (allowEmptyTurn ? emptyTurn(input) : null);
  if (!turn) return output(join([notice, ...warnings]));
  if (skipEmpty && turn.tokens.total === 0) return output(join([notice, ...warnings]));

  // Stop can fire more than once for the same turn; report it only once.
  // Stop and StopFailure are mutually exclusive per turn, but SessionEnd and
  // UserPromptSubmit may still see leftover usage from an unreported
  // (interrupted) prior turn — this key keeps either from resending one
  // Stop/StopFailure already reported.
  const turnKey = `${turn.sessionId || input.session_id || ''}:${turn.promptId || turn.tokens.total}`;
  if (state.lastTurn === turnKey) return output(join([notice, ...warnings]));
  writeJson(stateFile, { ...state, noticeShown: true, lastTurn: turnKey }, deps.fs);

  const datetime = deps.now().toISOString();
  const project = deriveProject(input.cwd || turn.cwd, deps.exists);
  const projectConfig = resolveProjectConfig(config, project);
  if (!projectConfig.usageEnabled) return output(join([notice, ...warnings]));
  const projectLabel = resolveProjectLabel(config, project);

  const messages = [notice, ...warnings];
  deliverUsage({
    deps,
    notice,
    projectConfig,
    projectLabel,
    project,
    datetime,
    prompt: turn.prompt,
    sessionId: turn.sessionId || input.session_id || '',
    models: turn.models,
    error,
    messages,
    entries,
  });
  return output(join(messages));
}

/**
 * Captures subagent usage. Sidechain entries carry no per-invocation id
 * (see transcript.mjs), so this tracks a running watermark — a count of
 * sidechain entries already reported for the current session — instead of a
 * turnKey. That also keeps it from colliding with the main-turn dedup state.
 */
function reportSubagentUsage(input, overrides = {}) {
  const deps = defaults(overrides);
  const { config, warnings } = loadConfig({ env: deps.env, readFile: deps.readFile });
  const { notice, state, path: stateFile } = consumeNotice(deps, deps.env);

  const entries = readTranscript(input.transcript_path, deps.readFile);
  const sessionId = input.session_id || '';
  const seenCount = state.subagentSession === sessionId ? state.subagentSeen || 0 : 0;
  const usage = extractSubagentUsage(entries, seenCount);
  if (!usage) return output(join([notice, ...warnings]));

  writeJson(stateFile, { ...state, noticeShown: true, subagentSession: sessionId, subagentSeen: usage.seenCount }, deps.fs);

  const totalTokens = usage.models.reduce((sum, bucket) => sum + bucket.tokens.total, 0);
  if (totalTokens === 0) return output(join([notice, ...warnings]));

  const datetime = deps.now().toISOString();
  const project = deriveProject(input.cwd || usage.cwd, deps.exists);
  const projectConfig = resolveProjectConfig(config, project);
  if (!projectConfig.usageEnabled) return output(join([notice, ...warnings]));
  const projectLabel = resolveProjectLabel(config, project);

  const messages = [notice, ...warnings];
  deliverUsage({
    deps,
    notice,
    projectConfig,
    projectLabel,
    project,
    datetime,
    prompt: usage.prompt,
    sessionId: usage.sessionId || sessionId,
    models: usage.models,
    error: null,
    messages,
    entries,
  });
  return output(join(messages));
}

export function handleSessionStart(input, overrides = {}) {
  const deps = defaults(overrides);
  const { config, warnings } = loadConfig({ env: deps.env, readFile: deps.readFile });
  const { notice } = consumeNotice(deps, deps.env);

  // Flush anything that failed to send in an earlier session (FRD §14 Q3).
  if (config.usageEnabled && config.usageEndpoint && config.usageRetry && !notice) {
    const pending = drain(queuePath(deps.env), deps.fs, { clear: false });
    if (pending.length) {
      deps.dispatchImpl([], { script: deps.senderScript, env: deps.env });
    }
  }
  return output(join([notice, ...warnings]));
}

export function handleStop(input, overrides = {}) {
  return reportTurn(input, overrides, { skipEmpty: true });
}

export function handleStopFailure(input, overrides = {}) {
  return reportTurn(input, overrides, {
    error: { type: input.error, details: input.error_details },
    skipEmpty: false,
    allowEmptyTurn: true,
  });
}

export function handleSubagentStop(input, overrides = {}) {
  return reportSubagentUsage(input, overrides);
}

export function handleSessionEnd(input, overrides = {}) {
  // Last chance: a cancelled turn never fires Stop or StopFailure. If the
  // session dies with leftover unreported usage, send it marked interrupted.
  return reportTurn(input, overrides, {
    error: { type: 'interrupted', details: input.reason },
    skipEmpty: true,
  });
}

export function handleUserPromptSubmit(input, overrides = {}) {
  // Esc/interrupt has no hook of its own. If the user cancels a turn and
  // keeps going in the same session, this catches it right as the next
  // prompt starts — before SessionEnd, which may be a long time away, or
  // never. Only catches the immediately preceding turn: two cancels back to
  // back without ever completing one still lose the first (ponytail: no
  // per-turn watermark yet — add one, like the subagent path's, if that
  // gap starts to matter in practice).
  return reportTurn(input, overrides, {
    error: { type: 'interrupted', details: 'turn cancelled before the next prompt' },
    skipEmpty: true,
    extract: previousTurn,
  });
}

function output(systemMessage) {
  const result = { suppressOutput: true };
  if (systemMessage) result.systemMessage = systemMessage;
  return result;
}

export function handle(input, overrides = {}) {
  if (input.hook_event_name === 'SessionStart') return handleSessionStart(input, overrides);
  if (input.hook_event_name === 'UserPromptSubmit') return handleUserPromptSubmit(input, overrides);
  if (input.hook_event_name === 'Stop') return handleStop(input, overrides);
  if (input.hook_event_name === 'StopFailure') return handleStopFailure(input, overrides);
  if (input.hook_event_name === 'SubagentStop') return handleSubagentStop(input, overrides);
  if (input.hook_event_name === 'SessionEnd') return handleSessionEnd(input, overrides);
  return { suppressOutput: true };
}
