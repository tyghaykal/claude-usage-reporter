#!/usr/bin/env node
/**
 * Hook entry point. Reads Claude Code's hook JSON on stdin and writes hook
 * JSON on stdout. It must never throw and never block: a broken reporter is
 * always preferable to a broken session.
 */

import { handle } from '../src/handler.mjs';
import { readStdin } from '../src/stdin.mjs';

const raw = await readStdin(process.stdin);
let result = { suppressOutput: true };
try {
  result = handle(JSON.parse(raw || '{}'));
} catch {
  // Malformed input, or any unexpected failure: stay silent, exit clean.
}
process.stdout.write(JSON.stringify(result));
