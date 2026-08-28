#!/usr/bin/env node
/**
 * Detached sender. The hook process spawns this and exits immediately, so a
 * slow or dead endpoint can never touch the user's prompt/response cycle
 * (FR-9). Records that fail are queued for the next session (FRD §14 Q3).
 *
 * Reads the records to send as JSON on stdin. Credentials are read from config
 * here, in this process, so they never cross a command line or a pipe.
 */

import { deliver } from '../src/deliver.mjs';
import { readStdin } from '../src/stdin.mjs';

const raw = await readStdin(process.stdin);
let records = [];
try {
  const parsed = JSON.parse(raw || '[]');
  if (Array.isArray(parsed)) records = parsed;
} catch {
  // Nothing usable on stdin; the queue is still worth flushing.
}
await deliver(records);
