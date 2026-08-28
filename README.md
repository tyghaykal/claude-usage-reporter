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

## Install

```
/plugin marketplace add tyghaykal/claude-usage-reporter
/plugin install claude-usage-reporter
```

Or from a local checkout:

```
/plugin marketplace add /path/to/claude-usage
/plugin install claude-usage-reporter
```

Requires Node 18+ (already present if you installed Claude Code via npm). No
dependencies, no build step, no `settings.json` editing.

On the first session after install you get a one-time notice describing exactly
what is captured. Nothing is sent anywhere on that first turn, even if an endpoint
is already configured.

---

## Out of the box

With no configuration, every prompt ends with:

```
[my-project] 2026-08-28 10:15:00 UTC · claude-sonnet-5
Tokens — input: 1,234 | cache read: 800 | cache write: 200 | output: 450 | total: 2,684
Est. cost (list price, estimate only): $0.0142
Session running total: 14,320 tokens across 6 prompts

No usage endpoint configured — set one to auto-report instead:
  /usage-config set usageEndpoint <url>
```

Costs are **estimates against public API list price**, not charges. On a Pro / Max /
Team / Enterprise plan you are billed a flat rate and this figure is purely for
visibility. On a metered API key it should track your bill closely, but the plugin
is not the system of record — see Anthropic's own usage and cost reporting for that.

---

## Sending usage somewhere

```
/usage-config set usageEndpoint https://myteam.example.com/claude-usage
```

Once set, terminal output turns off and each prompt POSTs this JSON instead:

```json
{
  "project": "my-project",
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

The POST happens in a detached background process, so a slow or dead endpoint can
never delay your next prompt. Failed pushes are queued locally and retried at the
start of your next session.

### Try it locally first

```
node examples/receiver.mjs
/usage-config set usageEndpoint http://127.0.0.1:8787/claude-usage
```

A ~40-line reference receiver that prints what arrives and appends it to
`examples/usage.jsonl`. It is not part of the plugin — it exists so you can see the
exact payload before pointing this at real infrastructure.

---

## Configuration

```
/usage-config                                  show everything (secrets masked)
/usage-config set usageEndpoint https://...    set a value
/usage-config unset usageEndpoint              remove one
```

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
never included in a payload, and never shown by `/usage-config` — only the fact
that a value is set. Even the failure log records the endpoint's host, never the
full URL, in case yours carries credentials in the userinfo part.

---

## How it works

Two hooks, ~600 lines of dependency-free JavaScript:

| Hook | What it does |
|---|---|
| `SessionStart` | Shows the first-run notice once; flushes any queued failed pushes. |
| `Stop` | Reads the turn's usage out of the transcript Claude Code already wrote, then prints or pushes it. |

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
- **Failed pushes are dropped after 500 queued records**, oldest first.
- **Costs are estimates.** See the pricing note above.
- Pricing lives in `src/pricing.json` and needs updating when Anthropic changes
  rates or ships a model the table doesn't know. An unknown model simply omits the
  cost line; token counts are still exact.

---

## Development

```
npm install
npm test        # 104 tests, no network, no disk writes outside a temp dir
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
