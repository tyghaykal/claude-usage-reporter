/**
 * `/usage-backfill` command implementation. Preview is the default and makes
 * no network calls; `--send` pushes through the same path `usage-config
 * test-connection` and the live hooks use.
 */

import { readFileSync } from 'node:fs';
import { COMMAND, loadConfig, statePath } from './config.mjs';
import { collectRecords, formatList, formatPreview, formatSessions, markReported, sendRecords, setSessionsIgnored } from './backfill.mjs';
import { postUsage } from './sender.mjs';
import { fsDefaults, readJson } from './store.mjs';

const USAGE = [
  'Usage:',
  '  /usage-backfill [--since DATE] [--until DATE] [--project NAME]... [--session ID]...',
  '                  [--turn KEY]... [--include-disabled] [--list] [--send] [--yes] [--force]',
  '',
  '  Without --send: preview only — one line per session, with a title (its first prompt). No network calls.',
  '  --totals           preview as project/session totals instead (no titles)',
  '  --list             preview as one line per turn, with its key — use this to find --turn values',
  '  --turn KEY         repeatable; only these exact turns, by the key --list prints ("sessionId:promptId")',
  '  --send             push the selected records — sending starts immediately, no confirmation prompt',
  '  --ignore           instead of sending, mark the selected --session(s) as ignored — skipped by default from now on',
  '  --unignore         un-mark the selected --session(s) as ignored',
  '  --yes              accepted for backwards compatibility; has no effect (--send alone is enough)',
  '  --force            resend turns already recorded as backfilled',
  '  --include-ignored  also include sessions previously marked --ignore',
  '  --since / --until  ISO date or datetime; a bare date is local time, --until includes the whole day',
  '  --project NAME     repeatable; only these projects',
  '  --session ID       repeatable; only these session ids',
  '  --include-disabled include projects with usageEnabled: false',
].join('\n');

function parseArgs(argv) {
  const options = { projects: [], sessions: [], turns: [] };
  const flags = { send: false, yes: false, force: false, list: false, totals: false, ignore: false, unignore: false, includeIgnored: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') options.since = argv[++i];
    else if (arg === '--until') options.until = argv[++i];
    else if (arg === '--project') options.projects.push(argv[++i]);
    else if (arg === '--session') options.sessions.push(argv[++i]);
    else if (arg === '--turn') options.turns.push(argv[++i]);
    else if (arg === '--include-disabled') options.includeDisabled = true;
    else if (arg === '--include-ignored') flags.includeIgnored = true;
    else if (arg === '--list') flags.list = true;
    else if (arg === '--totals') flags.totals = true;
    else if (arg === '--send') flags.send = true;
    else if (arg === '--ignore') flags.ignore = true;
    else if (arg === '--unignore') flags.unignore = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else return { error: `Unknown argument "${arg}".` };
  }
  return { options, flags };
}

/**
 * @returns {Promise<{text: string, code: number}>}
 */
export async function runBackfillCli(argv, {
  env = process.env,
  readFile = readFileSync,
  fs = fsDefaults,
  post = postUsage,
  now = () => new Date(),
  exists,
  listFs,
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { text: USAGE, code: 0 };
  if (parsed.error) return { text: `${parsed.error}\n\n${USAGE}`, code: 1 };
  const { options, flags } = parsed;

  let records;
  try {
    records = collectRecords(options, { env, readFile, exists, listFs });
  } catch (error) {
    return { text: `Error: ${error.message}`, code: 1 };
  }
  records = markReported(records, env, fs);

  if (flags.ignore || flags.unignore) {
    if (!options.sessions.length) return { text: 'Error: --ignore/--unignore needs at least one --session.', code: 1 };
    setSessionsIgnored(options.sessions, flags.ignore, env, fs);
    return { text: `${flags.ignore ? 'Ignored' : 'Un-ignored'}: ${options.sessions.join(', ')}`, code: 0 };
  }

  if (!flags.includeIgnored) records = records.filter((r) => r.skip || !r.ignored);

  if (!flags.send) {
    return { text: flags.list ? formatList(records) : flags.totals ? formatPreview(records) : formatSessions(records), code: 0 };
  }

  const { config } = loadConfig({ env, readFile });
  if (!config.usageEndpoint) {
    return { text: `No usageEndpoint configured — set one first:\n  ${COMMAND} set usageEndpoint <url>`, code: 1 };
  }
  const state = readJson(statePath(env), fs);
  if (!state.noticeShown) {
    return { text: 'The first-run notice has not been shown yet — start a normal Claude Code session first, then retry.', code: 1 };
  }

  const sendable = records.filter((r) => !r.skip && (flags.force || !r.alreadyReported));
  if (sendable.length === 0) {
    return { text: 'Nothing to send.\n\n' + formatPreview(records), code: 0 };
  }

  const result = await sendRecords(records, { env, readFile, fs, post, now, force: flags.force });
  const skippedNoTimestamp = records.filter((r) => r.skip === 'no-timestamp').length;
  const skippedZero = records.filter((r) => r.skip === 'zero-tokens').length;

  return {
    text: [
      `Sent: ${result.sent}`,
      `Skipped (already reported): ${result.skippedReported}`,
      `Skipped (no timestamp): ${skippedNoTimestamp}`,
      `Skipped (zero tokens): ${skippedZero}`,
      `Failed / queued for retry: ${result.failed}`,
    ].join('\n'),
    code: 0,
  };
}

export { USAGE };
