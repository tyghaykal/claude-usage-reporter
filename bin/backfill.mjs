#!/usr/bin/env node
/**
 * Backing script for `/claude-usage-reporter:usage-backfill` and direct CLI
 * use. `--send` pushes immediately — see the preview it prints without
 * `--send` for the safety net (nothing is sent until you pass that flag).
 */

import { runBackfillCli } from '../src/backfill-cli.mjs';

const { text, code } = await runBackfillCli(process.argv.slice(2));
process.stdout.write(`${text}\n`);
process.exitCode = code;
