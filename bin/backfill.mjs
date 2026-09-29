#!/usr/bin/env node
/** Backing script for `/claude-usage-reporter:usage-backfill` and direct CLI use. */

import { createInterface } from 'node:readline/promises';
import { runBackfillCli } from '../src/backfill-cli.mjs';

async function confirm({ count, host }) {
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
