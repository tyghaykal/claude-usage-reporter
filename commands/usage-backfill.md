---
description: Rebuild usage records from local transcripts and push the ones you choose (preview by default)
argument-hint: "[--since DATE] [--until DATE] [--project NAME]... [--session ID]... [--turn KEY]... [--include-disabled] [--list] [--send] [--force]"
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

Examples:
- `/claude-usage-reporter:usage-backfill --since 2026-09-01` — preview everything since Sept 1
- `/claude-usage-reporter:usage-backfill --since 2026-09-01 --list` — list individual turns with their keys, to pick from
- `/claude-usage-reporter:usage-backfill --turn s1:p1 --turn s1:p2 --send` — push only these exact turns
- `/claude-usage-reporter:usage-backfill --project my-repo --send` — push one project's turns
- `/claude-usage-reporter:usage-backfill --session abc-123 --send` — push one session
- `/claude-usage-reporter:usage-backfill --since 2026-09-01 --until 2026-09-01 --send --force` — resend one day
