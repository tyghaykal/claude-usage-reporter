---
description: View or change Claude Usage Reporter settings (secrets are masked)
argument-hint: "[set <key> <value> | unset <key>]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/config-cli.mjs" $ARGUMENTS`

Report the command output above to the user verbatim. Do not restate, guess at,
or ask for any secret value — masked values are masked deliberately.
