/**
 * Hook orchestration. Pure with respect to IO: every side effect arrives
 * through `deps`, so the whole flow is testable without touching the disk,
 * the network, or a real Claude Code session.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, logPath, queuePath, shouldDisplay, statePath } from './config.mjs';
import { deriveProject } from './project.mjs';
import { loadPricing } from './pricing.mjs';
import { FIRST_RUN_NOTICE, buildPayload, formatReport } from './report.mjs';
import { dispatch } from './sender.mjs';
import { appendLog, drain, fsDefaults, readJson, writeJson } from './store.mjs';
import { extractTurn, readTranscript, sessionSummary } from './transcript.mjs';

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

export function handleSessionStart(input, overrides = {}) {
  const deps = defaults(overrides);
  const { config, warnings } = loadConfig({ env: deps.env, readFile: deps.readFile });
  const { notice } = consumeNotice(deps, deps.env);

  // Flush anything that failed to send in an earlier session (FRD §14 Q3).
  if (config.usageEndpoint && config.usageRetry && !notice) {
    const pending = drain(queuePath(deps.env), deps.fs, { clear: false });
    if (pending.length) {
      deps.dispatchImpl([], { script: deps.senderScript, env: deps.env });
    }
  }
  return output(join([notice, ...warnings]));
}

export function handleStop(input, overrides = {}) {
  const deps = defaults(overrides);
  const { config, warnings } = loadConfig({ env: deps.env, readFile: deps.readFile });
  const { notice, state, path: stateFile } = consumeNotice(deps, deps.env);

  const entries = readTranscript(input.transcript_path, deps.readFile);
  const turn = extractTurn(entries);
  if (!turn || turn.tokens.total === 0) return output(join([notice, ...warnings]));

  // Stop can fire more than once for the same turn; report it only once.
  const turnKey = `${turn.sessionId}:${turn.promptId || turn.tokens.total}`;
  if (state.lastTurn === turnKey) return output(join([notice, ...warnings]));
  writeJson(stateFile, { ...state, noticeShown: true, lastTurn: turnKey }, deps.fs);

  const datetime = deps.now().toISOString();
  const project = deriveProject(input.cwd || turn.cwd, deps.exists);
  const payload = buildPayload({
    project,
    datetime,
    prompt: turn.prompt,
    sessionId: turn.sessionId || input.session_id || '',
    tokens: turn.tokens,
    model: turn.model,
    user: config.usageUser,
    promptMode: config.usagePromptMode,
  });

  const messages = [notice, ...warnings];

  // FR-16 / PD-1: the first run discloses before it can ever transmit.
  if (config.usageEndpoint && !notice) {
    const launched = deps.dispatchImpl([payload], { script: deps.senderScript, env: deps.env });
    if (!launched) {
      appendLog(logPath(deps.env), 'failed to launch usage sender', deps.fs, deps.now);
      messages.push('Claude Usage Reporter: could not start the background sender; this call was not reported.');
    }
  }

  if (shouldDisplay(config)) {
    messages.push(
      formatReport({
        project,
        datetime,
        tokens: turn.tokens,
        model: turn.model,
        session: sessionSummary(entries),
        endpointConfigured: Boolean(config.usageEndpoint),
        models: deps.models || loadPricing(),
      }),
    );
  }
  return output(join(messages));
}

function output(systemMessage) {
  const result = { suppressOutput: true };
  if (systemMessage) result.systemMessage = systemMessage;
  return result;
}

export function handle(input, overrides = {}) {
  if (input.hook_event_name === 'SessionStart') return handleSessionStart(input, overrides);
  if (input.hook_event_name === 'Stop') return handleStop(input, overrides);
  return { suppressOutput: true };
}
