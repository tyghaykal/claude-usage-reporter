# Troubleshooting / FAQ

**Nothing is being reported.**
Run `claude plugin list` and confirm `Status: ✔ enabled` — a plugin that
failed to load still shows as installed. If it's enabled, check
`usageEnabled` isn't `false` globally or for this project:
`/claude-usage-reporter:usage-config`. A successful turn with zero tokens
produces no report at all; that's expected, not a bug.

**The plugin shows installed but isn't enabled.**
`claude plugin list` distinguishes "installed" from "enabled" — a plugin can
be present but disabled. Re-run `/plugin install
claude-usage-reporter@claude-usage-reporter` and check the status line again.

**The endpoint is unreachable — what happens to my data?**
Nothing is lost silently. A failed push is written to
`~/.claude/claude-usage-queue.jsonl` (mode `0600`) and retried automatically
at the start of your next session (disable with `usageRetry: false`). The
queue is capped at **500 records — oldest dropped first**, so a long outage
can still lose data if you don't reconnect in time. Failures are also logged
(never payload contents) to `~/.claude/claude-usage.log`.

**I disabled the plugin (or endpoint) for a while — how do I get that usage reported?**
Use [`/usage-backfill`](backfill.md). It rebuilds records straight from the
local transcripts Claude Code already wrote, so nothing is lost as long as
the transcripts themselves haven't been cleaned up (see the retention caveat
below).

**How do I stop/disable it without uninstalling?**
```
/claude-usage-reporter:usage-config set usageEnabled false
```
This stops both the terminal report and any push, globally. To silence just
the terminal report while still pushing, use `usageDisplay off` instead.

**How do I uninstall and delete everything local?**
```
/plugin uninstall claude-usage-reporter
rm ~/.claude/claude-usage.json ~/.claude/claude-usage-state.json \
   ~/.claude/claude-usage-queue.jsonl ~/.claude/claude-usage-backfill-state.json \
   ~/.claude/claude-usage.log
```
Uninstalling the plugin stops it from running; it does not delete its local
files by itself, so remove them explicitly if you want a clean slate.

**How do I verify the network behavior myself?**
```
grep -rn fetch src/
```
turns up exactly one call site (`src/sender.mjs`) — the only place this
codebase ever makes a network request, and only against the
`usageEndpoint` you configured. See [Privacy & Data](../README.md#privacy--data).

**A turn is missing from the report.**
- Work done inside a subagent used to be excluded entirely; it's now
  captured by the `SubagentStop` hook, aggregated per subagent call.
- A successful turn that produced no assistant response is not reported.
- An API-error turn is reported even at zero tokens (the error mark itself
  is the signal).
- A cancelled turn (Esc) has no hook of its own — see *Known limitations*.
- If it's an old turn from before you configured reporting, see
  [Backfill](backfill.md).

**`claude plugin list` says `✘ failed to load`.**
You're on `0.1.0`. Update — see
[CHANGELOG.md](../CHANGELOG.md#011--2026-08-28).

**`Unknown command: /usage-config`.**
Claude Code namespaces plugin commands. The working form is
`/claude-usage-reporter:usage-config` (and
`/claude-usage-reporter:usage-backfill`), not the short form.

**No terminal report appears, even though the plugin is enabled.**
Expected if `usageEndpoint` is set: `usageDisplay` defaults to `auto`, which
prints only while no endpoint is configured. Use `usageDisplay always` to
get both a report and a push.

**Backfill preview shows turns I don't expect, or fewer than I expect.**
- `--since`/`--until` with a bare date are local time — double-check your
  timezone if the boundary looks off by a few hours.
- A disabled project is excluded unless you pass `--include-disabled`.
- Turns older than `cleanupPeriodDays` (Claude Code's transcript retention,
  default 30 days) are already gone from disk — backfill can't recover what
  Claude Code itself has deleted.
- "already reported" turns are still listed in the preview (so you can see
  what would be skipped) but are not sent unless you pass `--force`.
