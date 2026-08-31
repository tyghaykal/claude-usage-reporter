/**
 * Payload construction (FRD §9.1/§9.2) and terminal rendering (§9.3).
 * Neither ever includes an auth credential — see NFR "Safety".
 */

import { COMMAND } from './config.mjs';
import { estimateCost } from './pricing.mjs';

const ERROR_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_DETAILS_LIMIT = 300;

/** Applies `usagePromptMode`: `full`, `none`, or `truncate:N`. */
export function applyPromptMode(prompt, mode) {
  if (mode === 'none') return '';
  const truncate = /^truncate:(\d+)$/.exec(mode);
  if (!truncate) return prompt;
  const limit = Number(truncate[1]);
  return prompt.length > limit ? `${prompt.slice(0, limit)}…` : prompt;
}

/**
 * Normalises a turn-failure mark. Success is represented by omitting it
 * entirely, so existing backends keep seeing the original payload shape.
 */
export function errorMark(error) {
  if (!error) return null;
  const type = typeof error.type === 'string' && ERROR_TYPE.test(error.type) ? error.type : 'unknown';
  const raw = typeof error.details === 'string' ? error.details : '';
  const details = raw.slice(0, ERROR_DETAILS_LIMIT);
  return details ? { type, details } : { type };
}

export function buildPayload({ project, projectLabel, datetime, prompt, sessionId, tokens, model, user, provider, promptMode, error }) {
  const payload = {
    project,
    datetime,
    prompt: applyPromptMode(prompt, promptMode),
    session_id: sessionId,
    tokens: {
      input: tokens.input,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
      output: tokens.output,
      total: tokens.total,
    },
  };
  if (projectLabel) payload.project_label = projectLabel;
  if (model) payload.model = model;
  if (user) payload.user = user;
  if (provider) payload.provider = provider;
  const mark = errorMark(error);
  if (mark) {
    payload.error = true;
    payload.error_type = mark.type;
    if (mark.details) payload.error_details = mark.details;
  }
  return payload;
}

const n = (value) => Number(value || 0).toLocaleString('en-US');

/** `2026-08-28T10:15:00.000Z` -> `2026-08-28 10:15:00 UTC` */
export function formatUtc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function formatReport({ project, datetime, tokens, model, provider, session, endpointConfigured, models, error }) {
  const lines = [
    `[${project}] ${formatUtc(datetime)}${model ? ` · ${model}` : ''}${provider ? ` · ${provider}` : ''}`,
    `Tokens — input: ${n(tokens.input)} | cache read: ${n(tokens.cache_read)} | ` +
      `cache write: ${n(tokens.cache_write)} | output: ${n(tokens.output)} | total: ${n(tokens.total)}`,
  ];

  const mark = errorMark(error);
  if (mark) {
    lines.push(`Error: ${mark.type}${mark.details ? ` — ${mark.details}` : ''}`);
  }

  const cost = estimateCost(model, tokens, models);
  if (cost !== null) lines.push(`Est. cost (list price, estimate only): $${cost.toFixed(4)}`);

  if (session) {
    lines.push(
      `Session running total: ${n(session.tokens.total)} tokens across ${n(session.prompts)} ` +
        `prompt${session.prompts === 1 ? '' : 's'}`,
    );
  }

  if (!endpointConfigured) {
    lines.push('', 'No usage endpoint configured — set one to auto-report instead:', `  ${COMMAND} set usageEndpoint <url>`);
  }
  return lines.join('\n');
}

/** One-time disclosure shown before any data can leave the machine (FR-16). */
export const FIRST_RUN_NOTICE = [
  'Claude Usage Reporter is now active.',
  '',
  'It captures, per prompt: project name (and your project label, if set), timestamp, your prompt text, the model,',
  'the provider (your ANTHROPIC_BASE_URL, or "claude-session" for Claude Code\'s own session auth), the session id,',
  'and token counts (input / cache read / cache write / output).',
  '',
  'Nothing leaves this machine. Usage is printed to your terminal only, until you',
  'set an endpoint yourself. Once set, prompt text is POSTed to that endpoint,',
  'which is entirely yours to run.',
  '',
  `  Settings:  ${COMMAND}`,
  `  Send:      ${COMMAND} set usageEndpoint <url>`,
  `  Silence:   ${COMMAND} set usageDisplay off`,
].join('\n');
