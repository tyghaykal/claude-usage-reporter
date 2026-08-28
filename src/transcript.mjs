/**
 * Reads token usage out of the JSONL transcript Claude Code already writes.
 *
 * Shape notes, verified against a live transcript:
 *  - `assistant` entries carry `message.usage`; the same `requestId` can appear
 *    on several lines with identical usage, so requests are de-duplicated.
 *  - `promptId` groups every entry belonging to one user turn.
 *  - `isSidechain: true` marks subagent traffic, excluded in v1 (FRD §5).
 */

import { readFileSync } from 'node:fs';

export const EMPTY_TOKENS = Object.freeze({
  input: 0,
  cache_read: 0,
  cache_write: 0,
  output: 0,
  total: 0,
});

export function parseLines(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A partially flushed final line is normal while a session is live.
    }
  }
  return entries;
}

export function readTranscript(path, readFile = readFileSync) {
  try {
    return parseLines(readFile(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Flattens `message.content` (string, or a block array) to plain text. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

const isAssistant = (e) => e && e.type === 'assistant' && !e.isSidechain && e.message;

/**
 * User entries that represent a real submitted prompt.
 * Recent Claude Code versions tag these with `promptSource`; older ones do not,
 * so fall back to any non-sidechain user entry whose content is plain text
 * (tool results arrive as block arrays and are excluded either way).
 */
export function promptEntries(entries) {
  const users = entries.filter((e) => e && e.type === 'user' && !e.isSidechain && e.message);
  const tagged = users.filter((e) => typeof e.promptSource === 'string');
  if (tagged.length) return tagged;
  return users.filter((e) => typeof e.message.content === 'string');
}

export function sumUsage(entries) {
  const tokens = { ...EMPTY_TOKENS };
  const seen = new Set();
  for (const entry of entries) {
    const id = entry.requestId || entry.uuid;
    if (id !== undefined && seen.has(id)) continue;
    if (id !== undefined) seen.add(id);
    const usage = entry.message.usage;
    if (!usage) continue;
    tokens.input += usage.input_tokens || 0;
    tokens.cache_read += usage.cache_read_input_tokens || 0;
    tokens.cache_write += usage.cache_creation_input_tokens || 0;
    tokens.output += usage.output_tokens || 0;
  }
  tokens.total = tokens.input + tokens.cache_read + tokens.cache_write + tokens.output;
  return tokens;
}

/**
 * The most recent completed turn: its prompt text and token totals.
 * @returns {{prompt: string, tokens: object, model: string, sessionId: string,
 *            cwd: string, promptId: string}|null}
 */
export function extractTurn(entries) {
  const prompts = promptEntries(entries);
  if (!prompts.length) return null;
  const last = prompts[prompts.length - 1];
  const index = entries.lastIndexOf(last);

  const turnEntries = entries.slice(index).filter((e) => {
    if (!isAssistant(e)) return false;
    // Fall back to positional grouping when promptId is absent.
    return last.promptId === undefined || e.promptId === undefined || e.promptId === last.promptId;
  });

  const withModel = turnEntries.filter((e) => e.message.model);
  return {
    prompt: textOf(last.message.content),
    tokens: sumUsage(turnEntries),
    model: withModel.length ? withModel[withModel.length - 1].message.model : '',
    sessionId: last.sessionId || '',
    cwd: last.cwd || '',
    promptId: last.promptId || '',
  };
}

/**
 * Running totals for the whole session so far.
 * ponytail: re-reads the transcript each turn — O(session) per call, fine for
 * the megabyte-scale files Claude Code writes. Add incremental state if a
 * session transcript ever grows large enough to be felt.
 */
export function sessionSummary(entries) {
  return {
    tokens: sumUsage(entries.filter(isAssistant)),
    prompts: promptEntries(entries).length,
  };
}
