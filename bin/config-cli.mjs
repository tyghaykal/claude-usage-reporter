#!/usr/bin/env node
/** Backing script for the `/claude-usage-reporter:usage-config` command. */

import { runCli } from '../src/cli.mjs';

const { text, code } = runCli(process.argv.slice(2));
process.stdout.write(`${text}\n`);
process.exitCode = code;
