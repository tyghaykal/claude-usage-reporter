#!/usr/bin/env node
/** Backing script for `/claude-usage-reporter:usage-backfill` and direct CLI use. */

import { createInterface } from 'node:readline/promises';
import { runBackfillCli } from '../src/backfill-cli.mjs';

/**
 * Without a real TTY on stdin (e.g. run via a Claude Code slash command,
 * which executes non-interactively) there's no one to answer a prompt —
 * `rl.question` would just hang forever waiting for input that never
 * arrives. Refuse immediately instead, and say why.
 */
async function confirm({ count, host }) {
  if (!process.stdin.isTTY) {
    process.stderr.write(`Send ${count} record${count === 1 ? '' : 's'} to ${host}? Not running interactively — re-run with --yes to confirm.\n`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Send ${count} record${count === 1 ? '' : 's'} to ${host}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const { text, code } = await runBackfillCli(process.argv.slice(2), { confirm });
process.stdout.write(`${text}\n`);
process.exitCode = code;
