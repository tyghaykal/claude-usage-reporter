---
description: Rebuild usage records from local transcripts and push the ones you choose (preview by default)
argument-hint: "[--since DATE] [--until DATE] [--project NAME]... [--session ID]... [--turn KEY]... [--include-disabled] [--totals] [--list] [--send] [--ignore] [--unignore] [--force]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/backfill.mjs" $ARGUMENTS`

Report the command output above to the user verbatim, then stop. Without
`--send` this only prints a preview and made no network calls — say so if the
user seems to expect something was sent. Do not re-run with different flags
unless the user asks for that.

**`--send` pushes immediately — there is no confirmation step.** Only pass
`--send` once the user has reviewed a preview (run without it) and clearly
asked to actually send. Never add `--send` on your own initiative just
because the user asked to "see" or "check" something.

**Picking sessions interactively**: the default preview (no flags) already
prints one line per session — its id, project, turn count, token count, and
a title (its first prompt, truncated) — enough to recognize the session
without reading full transcripts. When the user wants to choose which
sessions to send or discard rather than naming them outright, present that
list (e.g. with AskUserQuestion, multi-select) and ask which to send and
which to discard. Then re-run: `--session ID... --send` for the ones to push,
and `--session ID... --ignore` for the ones to discard — `--ignore` only
updates local backfill state (never deletes transcripts or Claude Code's own
session history) so an ignored session is skipped by future previews/sends
until `--unignore`'d. Use `--totals` instead of the default when the user
wants project/session totals without titles.

Examples:
- `/claude-usage-reporter:usage-backfill --since 2026-09-01` — preview everything since Sept 1
- `/claude-usage-reporter:usage-backfill --since 2026-09-01 --list` — list individual turns with their keys, to pick from
- `/claude-usage-reporter:usage-backfill --turn s1:p1 --turn s1:p2 --send` — push only these exact turns
- `/claude-usage-reporter:usage-backfill --project my-repo --send` — push one project's turns
- `/claude-usage-reporter:usage-backfill --session abc-123 --send` — push one session
- `/claude-usage-reporter:usage-backfill --since 2026-09-01 --until 2026-09-01 --send --force` — resend one day
