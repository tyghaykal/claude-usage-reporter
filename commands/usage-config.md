---
description: View or change Claude Usage Reporter settings, or test the endpoint connection
argument-hint: "[set <key> <value> | unset <key> | test-connection]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/config-cli.mjs" $ARGUMENTS`

Report the command output above to the user verbatim, then stop.

Do not restate, guess at, or ask for any secret value — masked values are masked
deliberately. For `set` and `unset`, acknowledge briefly and nothing more: do not
probe the endpoint, inspect the queue, or diagnose problems the user has not
asked about. `test-connection` already reports everything needed to diagnose a
failing endpoint.
