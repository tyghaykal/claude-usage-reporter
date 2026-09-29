# Backfill

`/usage-backfill` rebuilds usage records from Claude Code's own local
transcripts (`~/.claude/projects/**/*.jsonl`) and pushes the ones you choose
to your configured `usageEndpoint`. It exists for three situations:

- **The plugin was disabled** for a while (or wasn't installed yet), so
  those turns were never reported.
- **The endpoint was down** and `usageRetry` had already dropped the queued
  records (capped at 500 — see [Known limitations](../README.md#known-limitations)).
- **A new endpoint was added** and you want history alongside it, not just
  turns going forward.

It reads only what's already on disk. Turns older than Claude Code's own
transcript retention (`cleanupPeriodDays`, default 30 days) are gone before
backfill can see them — there's nothing to recover past that window.

## Walkthrough

**1. Preview first — this is the default and makes no network calls:**

```
/claude-usage-reporter:usage-backfill --since 2026-09-01
```

```
my-repo:
  abc-123  turns: 14  tokens: 82,410  already reported: 0/14
  def-456  turns: 3   tokens: 9,220   already reported: 0/3

Skipped (no timestamp): 0
Skipped (zero tokens): 2
```

**2. When it looks right, send it:**

```
/claude-usage-reporter:usage-backfill --since 2026-09-01 --send
```

Run from an interactive terminal, you'll be asked to confirm — it shows the
record count and the endpoint's host, never the full URL:

```
Send 17 records to myteam.example.com? [y/N]
```

Run as the `/claude-usage-reporter:usage-backfill` slash command, there's no
terminal for that prompt to wait on — it always reports "Cancelled" instead
of hanging. Decide from the preview, then add `--yes` yourself once you're
ready:

```
/claude-usage-reporter:usage-backfill --since 2026-09-01 --send --yes
```

```
Sent: 17
Skipped (already reported): 0
Skipped (no timestamp): 0
Skipped (zero tokens): 2
Failed / queued for retry: 0
```

A failed push is queued exactly like a live push — see the retry queue in
the main [README](../README.md#how-it-works).

## Flags

| Flag | Repeatable | Meaning |
|---|---|---|
| `--since DATE` | no | Only turns at or after this date/time |
| `--until DATE` | no | Only turns at or before this date/time |
| `--project NAME` | yes | Only these projects (the real repo/directory name) |
| `--session ID` | yes | Only these session ids |
| `--turn KEY` | yes | Only these exact turns — see *Picking individual turns* below |
| `--include-disabled` | no | Also include projects with `usageEnabled: false` |
| `--list` | no | Preview as one line per turn, with its key, instead of the grouped summary |
| `--send` | no | Actually push (default is preview only) |
| `--yes` | no | Skip the confirmation prompt (only meaningful with `--send`) |
| `--force` | no | Resend turns already recorded as backfilled |

## Picking individual turns

The grouped preview (the default) and `--project`/`--session`/`--since`/
`--until` narrow things down to a project, a session, or a date range — not
to a specific turn. To pick exact turns, first list them:

```
/claude-usage-reporter:usage-backfill --since 2026-09-01 --list
```

```
s1:9e4e0b5d-66ae-4ff8-8f2c-3099ad91d006  2026-09-01T10:15:00.000Z  my-repo  claude-sonnet-5  2,684 tokens
s1:a5bd3ed9-3319-4496-b525-424331ff169d  2026-09-01T11:02:00.000Z  my-repo  claude-sonnet-5  980 tokens  (already reported)
s1:subagent                              2026-09-01T11:05:00.000Z  my-repo  claude-haiku-4-5  310 tokens
```

Each line's leading token is the turn's key (`sessionId:promptId`, or
`sessionId:subagent` for that session's aggregated subagent usage). Then
send only the ones you want, `--turn` repeated for each:

```
/claude-usage-reporter:usage-backfill \
  --turn s1:9e4e0b5d-66ae-4ff8-8f2c-3099ad91d006 \
  --turn s1:subagent \
  --send
```

`--turn` combines with every other filter (`--project`, `--session`,
`--since`/`--until`) — a turn must match all of them to be selected.

`--since`/`--until` accept an ISO date or datetime. A bare date
(`2026-09-01`, no time part) is treated as local time; `--until` with a bare
date includes the *whole* day, up to `23:59:59.999` local time.

## Worked examples

```bash
# Yesterday only
/claude-usage-reporter:usage-backfill --since 2026-09-28 --until 2026-09-28

# One project
/claude-usage-reporter:usage-backfill --project my-repo --send

# One session
/claude-usage-reporter:usage-backfill --session abc-123 --send --yes

# Resend a day you already backfilled (e.g. you pointed the endpoint elsewhere)
/claude-usage-reporter:usage-backfill --since 2026-09-01 --until 2026-09-01 --send --force
```

Or run it directly, outside a Claude Code session, from a local checkout of
this repository:

```bash
node bin/backfill.mjs --since 2026-09-01 --send --yes
```

## How duplicates are avoided

Every sendable record is keyed the same way the live hooks key a turn —
`session_id:promptId`. Once `--send` pushes a record, that key is written to
`~/.claude/claude-usage-backfill-state.json` (mode `0600`, next to
`claude-usage-state.json`). A later `/usage-backfill` run — even with
different `--since`/`--until` bounds that happen to overlap — skips any turn
whose key is already there, and reports it as "already reported" in the
preview. `--force` overrides that and resends anyway.

This state file is backfill's own record, separate from the single
"last turn sent" watermark the live hooks keep — it can track every turn
ever backfilled, not just the most recent one.

Subagent (Task-tool) usage has no reliable per-invocation boundary in the
transcript (see the note in `src/transcript.mjs`), so backfill folds all of
one session's subagent usage into a single record per session, the same
limitation the live `SubagentStop` hook works around with a running
watermark instead of a hard boundary.

## Respecting your existing settings

Backfill reuses the same config resolution as the live hooks: per-project
`usageEnabled` (a disabled project is skipped unless you pass
`--include-disabled`), `usagePromptMode`, `usageUser`, project label
aliases, and provider resolution. It refuses to run at all if no
`usageEndpoint` is configured, or if the plugin's first-run notice has never
been shown in a real session — see
[Configuration](configuration.md) for what each of those does.
