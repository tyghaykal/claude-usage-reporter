# Claude Usage Reporter

A Claude Code plugin that shows you what every prompt actually cost. It can also
forward that to an HTTP endpoint you run yourself. **Nothing leaves your
machine unless you configure an endpoint.**

---

## Quick start

**1. Install:**

```
/plugin marketplace add tyghaykal/claude-usage-reporter
/plugin install claude-usage-reporter@claude-usage-reporter
```

**2. Verify it loaded** — a plugin that fails to load still shows as installed:

```
$ claude plugin list
claude-usage-reporter   Status: ✔ enabled
```

**3. See your first report** — it prints after your next prompt, once Claude
Code finishes replying:

```
[my-project] 2026-08-28 10:15:00 UTC · claude-sonnet-5 · claude-session
Tokens — input: 1,234 | cache read: 800 | cache write: 200 | output: 450 | total: 2,684
Est. cost (list price, estimate only): $0.0142
Session running total: 14,320 tokens across 6 prompts

No usage endpoint configured — set one to auto-report instead:
  /claude-usage-reporter:usage-config set usageEndpoint <url>
```

**4. (Optional) Point it at an endpoint** — nothing is sent until you do this:

```
/claude-usage-reporter:usage-config set usageEndpoint https://myteam.example.com/claude-usage
```

From here: [Configuration](docs/configuration.md) for every setting,
[Backfill](docs/backfill.md) if you want history from before this point, and
[Troubleshooting](docs/troubleshooting.md) if something looks wrong.

---

## How it works

```
 you type a prompt
        │
        ▼
 Claude Code writes/updates the session transcript (~/.claude/projects/**/*.jsonl)
        │
        ▼
 a hook fires (Stop, StopFailure, SubagentStop, SessionEnd, UserPromptSubmit)
        │
        ▼
 the hook reads token usage out of the transcript, builds a payload
        │
        ├─────────────► printed to your terminal (if usageDisplay allows it)
        │
        ▼
 usageEndpoint configured? ── no ──► nothing else happens
        │
       yes
        │
        ▼
 handed to a detached background process, which POSTs it
        │
        ├── succeeds ──► done
        │
        └── fails ──► queued in claude-usage-queue.jsonl, retried next session
```

Six hooks, dependency-free JavaScript, read only what Claude Code already
writes to disk:

| Hook | What it does |
|---|---|
| `SessionStart` | Shows the first-run notice once; flushes any queued failed pushes. |
| `UserPromptSubmit` | Catches a turn you cancelled (Esc has no hook of its own): if the transcript shows a completed turn before the one you just typed that never got a `Stop`, it's posted here, marked `interrupted`. Silent otherwise. |
| `Stop` | Reads the turn's usage out of the transcript, then prints or pushes it. A turn that used more than one model is split into one payload per model. |
| `StopFailure` | Same capture when the turn ends in an API error, with `error: true` on the payload. Still sent if the turn used zero tokens. |
| `SubagentStop` | Captures token usage from subagents (Task-tool calls), per model, as each one finishes. |
| `SessionEnd` | Last chance: if the session dies with leftover unreported usage, it's posted and marked `interrupted`. A clean session end sends nothing. |

Because it reads only what Claude Code already stores locally, behaviour is
identical on a Pro subscription, a Max/Team/Enterprise plan, and a direct API
key. It never reads your Anthropic credentials, never touches request
routing, and never branches on your account type.

---

## What is captured and where it goes

After every prompt, the plugin records:

| Field | Example |
|---|---|
| `project` | `my-repo` — your git repository name, or the working directory name |
| `datetime` | `2026-08-28T10:15:00.000Z` |
| `prompt` | **the full text of the prompt you typed** — shaped by `usagePromptMode` |
| `session_id` | `abc-123` |
| `model` | `claude-sonnet-5` |
| `provider` | `claude-session`, or the host of `ANTHROPIC_BASE_URL` if you've set one |
| `tokens` | `input`, `cache_read`, `cache_write`, `output`, `total` |
| `error` | present only on a failed or interrupted turn |

Full field-by-field schema, including the backfill-only `turn_id`:
[docs/payload.md](docs/payload.md).

**Nothing leaves your machine by default.** With no endpoint configured, the
plugin makes no network calls at all — it just prints the report to your
terminal. Data is transmitted only after *you* set `usageEndpoint`, and then
it goes only to that URL. That endpoint is entirely your responsibility —
the plugin's authors have no visibility into it. If your prompts contain
anything sensitive, set `usagePromptMode` to `truncate:N` or `none` before
setting an endpoint (see [prompt-privacy guidance](docs/configuration.md#prompt-privacy-guidance-usagepromptmode)).

### Local files

All under `~/.claude/`, all mode `0600` (owner read/write only):

| File | Purpose | Contains prompt text? |
|---|---|---|
| `claude-usage.json` | Your settings | No |
| `claude-usage-state.json` | First-run flag, live-hook de-duplication watermark | No |
| `claude-usage-backfill-state.json` | Which turns `/usage-backfill` has already sent | No — only session/prompt ids |
| `claude-usage-queue.jsonl` | Pushes that failed, waiting to retry (capped at 500) | Yes — holds full unsent payloads |
| `claude-usage.log` | Delivery failures only | No — payload contents are never logged |

---

## Privacy & Data

**The plugin's authors collect nothing.** There is no telemetry, no
analytics, no hardcoded server, and no third party in this project at all —
the only network call in the entire codebase is the POST in
`src/sender.mjs`, and it only ever fires against the `usageEndpoint` URL
*you* set. Leave it unset and the plugin never makes a network request,
period. Verify it yourself:

```
grep -rn fetch src/
```

turns up exactly one call site. Nothing is processed outside that scope
either — there's no relay, no forwarding, no bundled backend the data passes
through on its way anywhere. Your prompt text and token counts go straight
from your machine to the endpoint you configured, over HTTPS/HTTP you
control, with nothing in between.

Everything the plugin does is plain, unminified JavaScript in this
repository — `src/` and `hooks/` are short enough to read end to end before
you trust it.

---

## Configuration

Every setting, per-project overrides, and worked examples:
**[docs/configuration.md](docs/configuration.md)**

Quick reference:

```
/claude-usage-reporter:usage-config                                  show everything (secrets masked)
/claude-usage-reporter:usage-config set usageEndpoint https://...    set a value
/claude-usage-reporter:usage-config unset usageEndpoint              remove one
/claude-usage-reporter:usage-config test-connection                  check the endpoint accepts a record
```

`test-connection` POSTs one real-shaped record with zero tokens, using
whatever auth you have configured, and reports what came back — including
the response body, which is usually what tells you which header the
endpoint wants:

```
Endpoint: http://localhost:8080/api/usage
Auth:     None — sending no auth header

FAILED — HTTP 401.
Response: {"error":"Missing X-API-Key header"}
```

It's the only command that talks to the network on demand. A success leaves
a zero-token record on your backend.

### Try it locally first

```
node examples/receiver.mjs
/claude-usage-reporter:usage-config set usageEndpoint http://127.0.0.1:8787/claude-usage
```

A ~40-line reference receiver that prints what arrives and appends it to
`examples/usage.jsonl`. It's not part of the plugin — it exists so you can
see the exact payload before pointing this at real infrastructure.

---

## Backfill

If the plugin was disabled for a while, the endpoint was down, or you just
added an endpoint and want history alongside it, `/usage-backfill` rebuilds
usage records from Claude Code's own local transcripts and pushes the ones
you choose. Preview is the default — it makes no network calls until you add
`--send`.

```
/claude-usage-reporter:usage-backfill --since 2026-09-01
/claude-usage-reporter:usage-backfill --since 2026-09-01 --send
```

Full walkthrough, every flag, and how duplicates are avoided:
**[docs/backfill.md](docs/backfill.md)**

---

## Receiving the data

Payload schema, field by field, with examples for a normal turn, a failed
turn, and a backfilled turn: **[docs/payload.md](docs/payload.md)**

Minimal receiver walkthrough and dedup advice: see
[docs/payload.md#receiving-it](docs/payload.md#receiving-it) and
`examples/receiver.mjs`.

The POST happens in a detached background process, so a slow or dead
endpoint can never delay your next prompt. Failed pushes are queued locally
and retried at the start of your next session.

---

## Known limitations

- **Esc / interrupt has no hook of its own.** Claude Code fires `StopFailure`
  for API errors, but not when you cancel a turn. `UserPromptSubmit` catches
  it as soon as you type the next prompt in the same session, and
  `SessionEnd` catches it if you don't. Cancelling two turns in a row without
  ever completing one in between still drops the first — only the turn
  immediately before the newest prompt is checked.
- **Failed pushes are dropped after 500 queued records**, oldest first.
- **Costs are estimates** against public list price, never a charge and never
  authoritative billing. Pricing lives in `src/pricing.json` and needs
  updating when Anthropic changes rates or ships a model the table doesn't
  know — an unknown model simply omits the cost line; token counts are still
  exact.
- **Subagent usage in backfill is aggregated per session, not per call.**
  There's no reliable per-invocation boundary in a transcript for subagent
  (sidechain) traffic, so `/usage-backfill` folds all of one session's
  subagent usage into a single record — the live `SubagentStop` hook, by
  contrast, reports each subagent call separately as it happens.
- **Backfill can't recover what Claude Code has already deleted.** Turns
  older than the transcript retention window (`cleanupPeriodDays`, default
  30 days) are gone from disk before backfill can see them.

---

## Glossary

| Term | Meaning |
|---|---|
| **Turn** | One prompt you typed and the reply that followed — the unit this plugin reports on. |
| **Session** | One continuous Claude Code conversation, identified by `session_id`; may contain many turns. |
| **Sidechain / subagent** | Work done by a Task-tool subagent inside a turn, captured separately by `SubagentStop`. |
| **Provider** | Which Anthropic endpoint served the turn: `claude-session` (Claude Code's own auth) or the host of a custom `ANTHROPIC_BASE_URL`. |
| **Queue** | `claude-usage-queue.jsonl` — pushes that failed, held locally for retry, capped at 500 records. |
| **Backfill** | Rebuilding and sending historical usage records from local transcripts via `/usage-backfill`, for turns the live hooks never reported. |

---

## Troubleshooting

Common issues, the retry-queue caveat, backfill quirks, uninstalling, and how
to verify the network behavior yourself: **[docs/troubleshooting.md](docs/troubleshooting.md)**

---

## Install

```
/plugin marketplace add tyghaykal/claude-usage-reporter
/plugin install claude-usage-reporter@claude-usage-reporter
```

Or from a local checkout:

```
/plugin marketplace add /path/to/claude-usage-reporter
/plugin install claude-usage-reporter@claude-usage-reporter
```

Requires Node 18+ (already present if you installed Claude Code via npm). No
dependencies, no build step, no `settings.json` editing.

On the first session after install you get a one-time notice describing
exactly what is captured. Nothing is sent anywhere on that first turn, even
if an endpoint is already configured.

### Updating

```
/plugin marketplace update claude-usage-reporter
/plugin install claude-usage-reporter@claude-usage-reporter
```

Versions are tagged in this repository, and [CHANGELOG.md](CHANGELOG.md)
marks any change to what is captured or where it is sent with 🔍 so you can
read it before upgrading.

---

## Development

```
npm install
npm test          # no network, no disk writes outside a temp dir
npm run coverage  # enforced at 100% lines / branches / functions / statements
```

`src/` holds the logic and is fully covered; `bin/` holds thin entry points
that only read stdin/argv and call into `src/`.

---

## Support

Issues and questions: <https://github.com/tyghaykal/claude-usage-reporter/issues>

Changes to what is captured or where it is sent are always called out in
[CHANGELOG.md](CHANGELOG.md).

MIT licensed.
