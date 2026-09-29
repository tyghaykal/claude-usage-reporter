# Configuration

```
/claude-usage-reporter:usage-config                                  show everything (secrets masked)
/claude-usage-reporter:usage-config set usageEndpoint https://...    set a value
/claude-usage-reporter:usage-config unset usageEndpoint              remove one
/claude-usage-reporter:usage-config test-connection                  check the endpoint accepts a record
```

Settings live in `~/.claude/claude-usage.json` (mode `0600`). Every setting
also has an environment variable, for CI or scripted setups — **the config
file wins** when both are present. Changes take effect on the next prompt, no
reinstall needed.

| Setting | Env | Default | Allowed values | Example |
|---|---|---|---|---|
| `usageEndpoint` | `CC_USAGE_ENDPOINT` | — | any `http(s)` URL | `https://myteam.example.com/claude-usage` |
| `usageAuthType` | `CC_USAGE_AUTH_TYPE` | `None` | `None`, `Bearer`, `Basic`, `Header`, `Key Pair` | `Bearer` |
| `usageAuthToken` | `CC_USAGE_AUTH_TOKEN` | — | secret, for `Bearer` / `Basic` | `sk-xxxx` |
| `usageHeaderName` | `CC_USAGE_HEADER_NAME` | `X-API-Key` | any header name, for `Header` | `X-API-Key` |
| `usageHeaderValue` | `CC_USAGE_HEADER_VALUE` | — | secret, for `Header` | `sk-xxxx` |
| `usageKeyIdHeaderName` | `CC_USAGE_KEY_ID_HEADER_NAME` | `X-API-Key-Id` | for `Key Pair` | `X-API-Key-Id` |
| `usageKeyIdValue` | `CC_USAGE_KEY_ID_VALUE` | — | secret, for `Key Pair` | `id_abc` |
| `usageKeySecretHeaderName` | `CC_USAGE_KEY_SECRET_HEADER_NAME` | `X-API-Key-Secret` | for `Key Pair` | `X-API-Key-Secret` |
| `usageKeySecretValue` | `CC_USAGE_KEY_SECRET_VALUE` | — | secret, for `Key Pair` | `sec_xyz` |
| `usageDisplay` | `CC_USAGE_DISPLAY` | `auto` | `auto`, `always`, `off` | `always` |
| `usageEnabled` | `CC_USAGE_ENABLED` | `true` | `true`, `false` | `false` |
| `usageUser` | `CC_USAGE_USER` | — | any string | `alice` |
| `usagePromptMode` | `CC_USAGE_PROMPT_MODE` | `full` | `full`, `truncate:N`, `none` | `truncate:200` |
| `usageRetry` | `CC_USAGE_RETRY` | `true` | `true`, `false` | `true` |
| `usageTimeoutMs` | `CC_USAGE_TIMEOUT_MS` | `5000` | positive integer | `8000` |
| `usageProjectLabel:<project>` | — (file only) | — | any string | `usageProjectLabel:my-repo "Client Alpha"` |
| `usageProject:<project>:<key>` | — (file only) | — | any key above | `usageProject:my-repo:usageEndpoint https://…` |

## `usageDisplay`

- **`auto`** (default) — prints the terminal report only while no endpoint is
  set. Setting an endpoint silently switches you to pushing instead. One mode
  at a time.
- **`always`** — report *and* push, on every call.
- **`off`** — never print. With no endpoint set this leaves you with no
  visibility at all, so it's meant for scripted use.

## Per-project labels

`project` (the field sent in every payload) is always the real repo or
directory name — there's no way to rename it globally. A label is a
*display* name, set per project, that rides along as `project_label`:

```
/claude-usage-reporter:usage-config set usageProjectLabel:my-repo "Client Alpha"
/claude-usage-reporter:usage-config unset usageProjectLabel:my-repo
```

`<project>` is that real repo/directory name — the same string reported as
`project`. A project with no override reports `project_label` equal to
`project`, so the field is always present.

**Worked example.** Two clients share one machine, both named generically on
disk:

```
/claude-usage-reporter:usage-config set usageProjectLabel:widgets-api "Acme Corp"
/claude-usage-reporter:usage-config set usageProjectLabel:portal-app "Acme Corp — Portal"
```

Reports from either repo now read `project: "widgets-api"`, `project_label:
"Acme Corp"` — the real name is never hidden, only annotated.

## Per-project settings

Beyond labels, a project can override *any* setting in the table above — its
own endpoint, its own auth, or opt out of tracking entirely:

```
/claude-usage-reporter:usage-config set usageProject:client:usageEndpoint https://client-backend.example/usage
/claude-usage-reporter:usage-config set usageProject:client:usageAuthType Bearer
/claude-usage-reporter:usage-config set usageProject:client:usageAuthToken sk-xxxx

# Fully disable reporting for one project — no terminal report, no push, regardless of global settings
/claude-usage-reporter:usage-config set usageProject:internal-tool:usageEnabled false
/claude-usage-reporter:usage-config unset usageProject:internal-tool:usageEnabled
```

A project with no override uses the global settings unchanged. Overrides are
stored under `usageProjects` in the config file, keyed by project, and listed
separately when you run `usage-config` with no arguments.

## Prompt-privacy guidance (`usagePromptMode`)

Controls how much of your prompt text leaves the machine once an endpoint is
set. Pick it *before* setting `usageEndpoint`:

| Mode | When to use it | Sample `prompt` in the payload |
|---|---|---|
| `full` (default) | You trust the endpoint and want full context for debugging/analytics | `"fix the login bug in auth.js"` |
| `truncate:N` | You want visibility without sending long prompts — good middle ground | `truncate:20` → `"fix the login bug in…"` |
| `none` | The endpoint should only ever see token counts, never prompt text | `""` |

## Authentication shapes

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

These credentials belong to *your* backend. They are never printed, never
logged, never included in a payload, and never shown by
`/claude-usage-reporter:usage-config` — only the fact that a value is set.
Even the failure log records the endpoint's host, never the full URL, in case
yours carries credentials in the userinfo part.
