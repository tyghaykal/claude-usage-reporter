---
description: Rebuild usage records from local transcripts and push the ones you choose (preview by default)
argument-hint: "[--since DATE] [--until DATE] [--project NAME]... [--session ID]... [--include-disabled] [--send] [--yes] [--force]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/backfill.mjs" $ARGUMENTS`

Report the command output above to the user verbatim, then stop. Without
`--send` this only prints a preview and made no network calls — say so if the
user seems to expect something was sent. Do not re-run with different flags
unless the user asks for that.

Examples:
- `/claude-usage-reporter:usage-backfill --since 2026-09-01` — preview everything since Sept 1
- `/claude-usage-reporter:usage-backfill --project my-repo --send` — push one project's turns
- `/claude-usage-reporter:usage-backfill --session abc-123 --send --yes` — push one session, no prompt
- `/claude-usage-reporter:usage-backfill --since 2026-09-01 --until 2026-09-01 --send --force` — resend one day
