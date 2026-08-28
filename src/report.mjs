/**
 * Payload construction (FRD §9.1/§9.2) and terminal rendering (§9.3).
 * Neither ever includes an auth credential — see NFR "Safety".
 */

import { estimateCost } from './pricing.mjs';

/** Applies `usagePromptMode`: `full`, `none`, or `truncate:N`. */
export function applyPromptMode(prompt, mode) {
  if (mode === 'none') return '';
  const truncate = /^truncate:(\d+)$/.exec(mode);
  if (!truncate) return prompt;
  const limit = Number(truncate[1]);
  return prompt.length > limit ? `${prompt.slice(0, limit)}…` : prompt;
}

export function buildPayload({ project, datetime, prompt, sessionId, tokens, model, user, promptMode }) {
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
  if (model) payload.model = model;
  if (user) payload.user = user;
  return payload;
}

const n = (value) => Number(value || 0).toLocaleString('en-US');

/** `2026-08-28T10:15:00.000Z` -> `2026-08-28 10:15:00 UTC` */
export function formatUtc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export function formatReport({ project, datetime, tokens, model, session, endpointConfigured, models }) {
  const lines = [
    `[${project}] ${formatUtc(datetime)}${model ? ` · ${model}` : ''}`,
    `Tokens — input: ${n(tokens.input)} | cache read: ${n(tokens.cache_read)} | ` +
      `cache write: ${n(tokens.cache_write)} | output: ${n(tokens.output)} | total: ${n(tokens.total)}`,
  ];

  const cost = estimateCost(model, tokens, models);
  if (cost !== null) lines.push(`Est. cost (list price, estimate only): $${cost.toFixed(4)}`);

  if (session) {
    lines.push(
      `Session running total: ${n(session.tokens.total)} tokens across ${n(session.prompts)} ` +
        `prompt${session.prompts === 1 ? '' : 's'}`,
    );
  }

  if (!endpointConfigured) {
    lines.push('', 'No usage endpoint configured — set one to auto-report instead:', '  /usage-config set usageEndpoint <url>');
  }
  return lines.join('\n');
}

/** One-time disclosure shown before any data can leave the machine (FR-16). */
export const FIRST_RUN_NOTICE = [
  'Claude Usage Reporter is now active.',
  '',
  'It captures, per prompt: project name, timestamp, your prompt text, the model,',
  'the session id, and token counts (input / cache read / cache write / output).',
  '',
  'Nothing leaves this machine. Usage is printed to your terminal only, until you',
  'set an endpoint yourself with:  /usage-config set usageEndpoint <url>',
  'Once set, prompt text is POSTed to that endpoint, which is entirely yours to run.',
  '',
  'Config: /usage-config    Disable terminal output: /usage-config set usageDisplay off',
].join('\n');
