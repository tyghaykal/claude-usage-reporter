# Payload schema

What arrives at your `usageEndpoint`, as a single `POST` with a JSON body,
once per model per turn. This is the one source of truth for the shape —
the README and `examples/receiver.mjs` both point here instead of repeating it.

| Field | Type | Present | Example |
|---|---|---|---|
| `project` | string | always | `"my-repo"` — git repo name, or the working directory name outside a repo |
| `project_label` | string | always | `"Client Alpha"` — your configured label, or the same value as `project` if none is set |
| `datetime` | string (ISO 8601) | always | `"2026-08-28T10:15:00.000Z"` |
| `prompt` | string | always | the prompt text, shaped by `usagePromptMode` — `""` when the mode is `none` |
| `session_id` | string | always | `"abc-123"` |
| `model` | string | when known | `"claude-sonnet-5"` |
| `provider` | string | when known | `"claude-session"`, or the scheme+host of `ANTHROPIC_BASE_URL` |
| `user` | string | when `usageUser` is set | `"alice"` |
| `tokens` | object | always | `{ "input": 1234, "cache_read": 800, "cache_write": 200, "output": 450, "total": 2684 }` |
| `error` | boolean | only on a failed/interrupted turn | `true` |
| `error_type` | string | only with `error` | `"rate_limit"`, `"authentication_failed"`, `"interrupted"`, … |
| `error_details` | string | only when the error carries detail | truncated to 300 characters |
| `turn_id` | string | only on a record sent by `/usage-backfill` | `"abc-123:9e4e0b5d-66ae-4ff8-8f2c-3099ad91d006"` — `session_id:promptId`, stable across re-runs |

A successful turn omits every `error*` field entirely and every live-hook
record omits `turn_id`, so an existing consumer keeps seeing the shape it
already handles — both fields are strictly additive.

## Example: a normal turn

```json
{
  "project": "my-project",
  "project_label": "Client Alpha",
  "datetime": "2026-08-28T10:15:00.000Z",
  "prompt": "fix the login bug",
  "session_id": "abc-123",
  "model": "claude-sonnet-5",
  "provider": "claude-session",
  "tokens": { "input": 1234, "cache_read": 800, "cache_write": 200, "output": 450, "total": 2684 }
}
```

## Example: a failed or interrupted turn

```json
{
  "project": "my-project",
  "project_label": "my-project",
  "datetime": "2026-08-28T10:16:12.000Z",
  "prompt": "…",
  "session_id": "abc-123",
  "tokens": { "input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "total": 0 },
  "error": true,
  "error_type": "rate_limit",
  "error_details": "retry in 2s"
}
```

## Example: a backfilled turn

Identical shape, plus `turn_id`, and `datetime` is the turn's own original
timestamp — never the time the backfill ran:

```json
{
  "project": "my-project",
  "project_label": "my-project",
  "datetime": "2026-07-14T09:03:21.000Z",
  "prompt": "add the rate limiter",
  "session_id": "abc-123",
  "model": "claude-sonnet-5",
  "provider": "claude-session",
  "tokens": { "input": 900, "cache_read": 0, "cache_write": 0, "output": 300, "total": 1200 },
  "turn_id": "abc-123:9e4e0b5d-66ae-4ff8-8f2c-3099ad91d006"
}
```

## Receiving it

`examples/receiver.mjs` is a ~40-line reference implementation: it appends
every record to `examples/usage.jsonl` and prints a one-line summary. Run it,
point `usageEndpoint` at it, and read the file to see exactly what arrives
before pointing this at real infrastructure — see the main
[README](../README.md#try-it-locally-first).

**Deduplicating on your side.** A live-hook record for a given turn is sent
at most once (the plugin's own `claude-usage-state.json` prevents a resend).
A backfilled record can, in principle, still collide with one already sent
live if you run `/usage-backfill --force`, or if you point a *different*
endpoint at the same transcripts twice. If that matters for your backend,
key your own dedup on `session_id` + the turn's `datetime`, or on `turn_id`
when it's present.
