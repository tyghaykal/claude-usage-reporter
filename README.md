# Claude Usage Reporter

A Claude Code plugin that shows you what every prompt actually cost — and, if you
want, forwards that to an HTTP endpoint you run yourself.

---

## What it captures, and where it goes

**Read this before installing.**

After every prompt, the plugin records:

| Field | Example |
|---|---|
| `project` | `my-repo` — your git repository name, or the working directory name |
| `datetime` | `2026-08-28T10:15:00.000Z` |
| `prompt` | **the full text of the prompt you typed** |
| `session_id` | `abc-123` |
| `model` | `claude-sonnet-5` |
| `tokens` | `input`, `cache_read`, `cache_write`, `output`, `total` |
| `error` | present only on a failed or interrupted turn — see below |

**Nothing leaves your machine by default.** With no endpoint configured, the plugin
makes no network calls at all — it just prints the report to your terminal. Data is
transmitted only after *you* set `usageEndpoint`, and then it goes only to that URL.

That endpoint is entirely your responsibility. The plugin's authors have no
visibility into it and no control over what it does with your prompt text. If your
prompts contain anything sensitive, set `usagePromptMode` to `truncate:N` or `none`
before setting an endpoint.

Everything the plugin does is plain, unminified JavaScript in this repository —
`src/` and `hooks/` are short enough to read end to end before you trust it.

---

## Privacy & Data

**The plugin's authors collect nothing.** There is no telemetry, no analytics, no
hardcoded server, and no third party in this project at all — the only network
call in the entire codebase is the POST in `src/sender.mjs`, and it only ever
fires against the `usageEndpoint` URL *you* set. Leave it unset and the plugin
never makes a network request, period. Verify it yourself: `grep -rn fetch src/`
turns up exactly one call site.

Nothing is processed outside that scope, either — there's no relay, no
forwarding, no bundled backend the data passes through on its way anywhere. Your
prompt text and token counts go straight from your machine to the endpoint you
configured, over HTTPS/HTTP you control, with nothing in between.

Everything else stays local, under `~/.claude/`, mode `0600`:
`claude-usage.json` (settings), `claude-usage-state.json` (first-run flag),
`claude-usage-queue.jsonl` (pushes that failed, so they can retry), and
`claude-usage.log` (delivery failures only — payload contents are never logged).

The plugin also never reads your Anthropic account credentials or API key — it
only reads the local transcript Claude Code already writes to compute token
counts (see *How it works* below).

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

Confirm it loaded — this is worth doing, since a plugin that fails to load still
reports as installed:

```
claude plugin list     # look for: Status: ✔ enabled
```

On the first session after install you get a one-time notice describing exactly
what is captured. Nothing is sent anywhere on that first turn, even if an endpoint
is already configured.

### Updating

```
/plugin marketplace update claude-usage-reporter
/plugin install claude-usage-reporter@claude-usage-reporter
```

Versions are tagged in this repository, and [CHANGELOG.md](CHANGELOG.md) marks any
change to what is captured or where it is sent with 🔍 so you can read it before
upgrading.

---

## Out of the box

With no configuration, every prompt ends with:

```
[my-project] 2026-08-28 10:15:00 UTC · claude-sonnet-5
Tokens — input: 1,234 | cache read: 800 | cache write: 200 | output: 450 | total: 2,684
Est. cost (list price, estimate only): $0.0142
Session running total: 14,320 tokens across 6 prompts

No usage endpoint configured — set one to auto-report instead:
  /claude-usage-reporter:usage-config set usageEndpoint <url>
```

Costs are **estimates against public API list price**, not charges. On a Pro / Max /
Team / Enterprise plan you are billed a flat rate and this figure is purely for
visibility. On a metered API key it should track your bill closely, but the plugin
is not the system of record — see Anthropic's own usage and cost reporting for that.

---

## Sending usage somewhere

```
/claude-usage-reporter:usage-config set usageEndpoint https://myteam.example.com/claude-usage
```

Once set, terminal output turns off and each prompt POSTs this JSON instead:

```jsonc
{
  // Always the git repository name (or directory name outside a repo).
  "project": "my-project",
  // Only present when usageProjectLabel is set — your own friendlier name.
  "project_label": "Client Alpha",
  "datetime": "2026-08-28T10:15:00Z",
  "prompt": "fix the login bug",
  "session_id": "abc-123",
  "model": "claude-sonnet-5",
  "tokens": {
    "input": 1234,
    "cache_read": 800,
    "cache_write": 200,
    "output": 450,
    "total": 2684
  }
}
```

A successful turn omits the error fields entirely, so existing backends keep seeing
the original shape. If the turn ended in an API error, or leftover usage is flushed
because the session died mid-turn, the same payload is sent with a mark:

```json
{
  "error": true,
  "error_type": "rate_limit",
  "error_details": "retry in 2s"
}
```

`error_type` is a short slug (`rate_limit`, `authentication_failed`, `interrupted`,
…). `error_details` is optional and truncated to 300 characters. An API error that
never produced usage is still posted, with zeros in `tokens`.

The POST happens in a detached background process, so a slow or dead endpoint can
never delay your next prompt. Failed pushes are queued locally and retried at the
start of your next session.

### Check it before you rely on it

Pushes happen in the background, so a misconfigured endpoint is silent — you find
out by noticing no data ever arrived. `test-connection` makes it explicit:

```
/claude-usage-reporter:usage-config test-connection
```

```
Endpoint: https://myteam.example.com/claude-usage
Auth:     Header — sending X-API-Key

OK — 204. The endpoint accepted a test record.
It stored a zero-token entry; remove it if your backend keeps it.
```

On failure it prints the response body, which is normally what names the problem:

```
FAILED — HTTP 401.
Response: {"error":"Missing X-API-Key header"}

The endpoint rejected the credentials. Current usageAuthType is "None".
```

### Try it locally first

```
node examples/receiver.mjs
/claude-usage-reporter:usage-config set usageEndpoint http://127.0.0.1:8787/claude-usage
```

A ~40-line reference receiver that prints what arrives and appends it to
`examples/usage.jsonl`. It is not part of the plugin — it exists so you can see the
exact payload before pointing this at real infrastructure.

---

## Configuration

```
/claude-usage-reporter:usage-config                                  show everything (secrets masked)
/claude-usage-reporter:usage-config set usageEndpoint https://...    set a value
/claude-usage-reporter:usage-config unset usageEndpoint              remove one
/claude-usage-reporter:usage-config test-connection                  check the endpoint accepts a record
```

`test-connection` POSTs one real-shaped record with zero tokens, using whatever
auth you have configured, and reports what came back — including the response
body, which is usually what tells you which header the endpoint wants:

```
Endpoint: http://localhost:8080/api/usage
Auth:     None — sending no auth header

FAILED — HTTP 401.
Response: {"error":"Missing X-API-Key header"}
```

It is the only command that talks to the network on demand. Note that a success
leaves a zero-token record on your backend.

Settings live in `~/.claude/claude-usage.json` (mode `0600`). Every setting also has
an environment variable, for CI or scripted setups; **the config file wins** when
both are present. Changes take effect on the next prompt — no reinstall.

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `usageEndpoint` | `CC_USAGE_ENDPOINT` | — | Where to POST. Unset = nothing is ever sent. |
| `usageAuthType` | `CC_USAGE_AUTH_TYPE` | `None` | `None`, `Bearer`, `Basic`, `Header`, `Key Pair` |
| `usageAuthToken` | `CC_USAGE_AUTH_TOKEN` | — | Secret for `Bearer` / `Basic` |
| `usageHeaderName` | `CC_USAGE_HEADER_NAME` | `X-API-Key` | Header name for `Header` |
| `usageHeaderValue` | `CC_USAGE_HEADER_VALUE` | — | Secret for `Header` |
| `usageKeyIdHeaderName` | `CC_USAGE_KEY_ID_HEADER_NAME` | `X-API-Key-Id` | For `Key Pair` |
| `usageKeyIdValue` | `CC_USAGE_KEY_ID_VALUE` | — | Secret for `Key Pair` |
| `usageKeySecretHeaderName` | `CC_USAGE_KEY_SECRET_HEADER_NAME` | `X-API-Key-Secret` | For `Key Pair` |
| `usageKeySecretValue` | `CC_USAGE_KEY_SECRET_VALUE` | — | Secret for `Key Pair` |
| `usageDisplay` | `CC_USAGE_DISPLAY` | `auto` | `auto`, `always`, `off` |
| `usageProjectLabel` | `CC_USAGE_PROJECT_LABEL` | — | Friendlier name shown in the terminal report and sent as `project_label`; `project` still reports the real repo/directory name |
| `usageUser` | `CC_USAGE_USER` | — | Optional label added to the payload, for shared accounts |
| `usagePromptMode` | `CC_USAGE_PROMPT_MODE` | `full` | `full`, `truncate:N`, `none` |
| `usageRetry` | `CC_USAGE_RETRY` | `true` | Queue failed pushes and retry next session |
| `usageTimeoutMs` | `CC_USAGE_TIMEOUT_MS` | `5000` | Per-request timeout |

### `usageDisplay`

- **`auto`** — terminal report only while no endpoint is set. Setting an endpoint
  silently switches you to pushing. One mode at a time.
- **`always`** — report *and* push, on every call.
- **`off`** — never print. With no endpoint set this leaves you with no visibility
  at all, so it is meant for scripted use.

### Authentication shapes

Endpoints in the wild authenticate differently, so pick the one yours expects:

```jsonc
// Bearer
{ "usageAuthType": "Bearer", "usageAuthToken": "sk-xxxx" }
// → Authorization: Bearer sk-xxxx

// Basic — a "user:pass" value is base64-encoded for you;
// anything else is passed through as an already-encoded credential
{ "usageAuthType": "Basic", "usageAuthToken": "user:pass" }
// → Authorization: Basic dXNlcjpwYXNz

// Single custom header
{ "usageAuthType": "Header", "usageHeaderName": "X-API-Key", "usageHeaderValue": "sk-xxxx" }
// → X-API-Key: sk-xxxx

// Split ID + secret
{ "usageAuthType": "Key Pair",
  "usageKeyIdHeaderName": "X-API-Key-Id",     "usageKeyIdValue": "id_abc",
  "usageKeySecretHeaderName": "X-API-Key-Secret", "usageKeySecretValue": "sec_xyz" }
// → X-API-Key-Id: id_abc
// → X-API-Key-Secret: sec_xyz
```

These credentials belong to *your* backend. They are never printed, never logged,
never included in a payload, and never shown by `/claude-usage-reporter:usage-config` — only the fact
that a value is set. Even the failure log records the endpoint's host, never the
full URL, in case yours carries credentials in the userinfo part.

---

## How it works

Four hooks, ~600 lines of dependency-free JavaScript:

| Hook | What it does |
|---|---|
| `SessionStart` | Shows the first-run notice once; flushes any queued failed pushes. |
| `Stop` | Reads the turn's usage out of the transcript Claude Code already wrote, then prints or pushes it. |
| `StopFailure` | Same capture when the turn ends in an API error, with `error: true` on the payload. Still sent if the turn used zero tokens. |
| `SessionEnd` | Last chance: if the session dies with leftover unreported usage (a cancelled turn never fires `Stop`), that usage is posted and marked `interrupted`. A clean session end sends nothing. |

Token counts come from `~/.claude/projects/<project>/<session>.jsonl` — the local
transcript Claude Code writes for every session. The plugin reads the `usage` block
Anthropic's API returns on each assistant message, de-duplicates repeated request
IDs, and sums them per turn.

Because it reads only what Claude Code already stores locally, behaviour is
identical on a Pro subscription, a Max/Team/Enterprise plan, and a direct API key.
It never reads your Anthropic credentials, never touches request routing, and never
branches on your account type.

Files it owns, all mode `0600`, all under `~/.claude/`:
`claude-usage.json` (settings), `claude-usage-state.json` (first-run flag,
de-duplication), `claude-usage-queue.jsonl` (failed pushes, capped at 500),
`claude-usage.log` (delivery failures, capped at 256 KB).

---

## Known limitations

- **Subagent usage is not counted.** Work done inside a subagent is marked
  `isSidechain` in the transcript and is excluded from the per-turn figure.
- **Esc / interrupt has no hook.** Claude Code fires `StopFailure` for API errors,
  but not when you cancel a turn. Leftover usage is only submitted if the session
  then ends (`SessionEnd`) before another prompt overwrites it. Cancelling a turn
  and continuing in the same session can drop that turn's tokens.
- **Failed pushes are dropped after 500 queued records**, oldest first.
- **Costs are estimates.** See the pricing note above.
- Pricing lives in `src/pricing.json` and needs updating when Anthropic changes
  rates or ships a model the table doesn't know. An unknown model simply omits the
  cost line; token counts are still exact.

---

## Troubleshooting

**`claude plugin list` says `✘ failed to load`** — you are on 0.1.0. Update; see
[CHANGELOG.md](CHANGELOG.md#011--2026-08-28).

**`Unknown command: /usage-config`** — Claude Code namespaces plugin commands. The
full name is `/claude-usage-reporter:usage-config`. Versions before 0.1.2 printed
the short form, which never worked.

**Nothing arrives at my endpoint** — run `test-connection`; it reports the status
and the response body. Failures are also logged to `~/.claude/claude-usage.log`,
and unsent records wait in `~/.claude/claude-usage-queue.jsonl`.

**No terminal report appears** — with an endpoint configured that is expected:
`usageDisplay` defaults to `auto`, which prints only while no endpoint is set. Use
`always` to get both.

**A turn is missing** — work done inside a subagent is excluded (see Known
limitations). A successful turn that produced no assistant response is not
reported; an API-error turn is reported even at zero tokens. A cancelled turn
is only reported if leftover usage is still in the transcript when the session
ends.

---

## Development

```
npm install
npm test          # 127 tests, no network, no disk writes outside a temp dir
npm run coverage  # enforced at 100% lines / branches / functions / statements
```

`src/` holds the logic and is fully covered; `bin/` holds three thin entry points
that only read stdin and call into `src/`.

---

## Support

Issues and questions: <https://github.com/tyghaykal/claude-usage-reporter/issues>

Changes to what is captured or where it is sent are always called out in
[CHANGELOG.md](CHANGELOG.md).

MIT licensed.
