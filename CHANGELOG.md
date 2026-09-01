# Changelog

All notable changes to this plugin are documented here. Changes to **what is
captured** or **where it is sent** are always listed first and marked 🔍, so you can
see them before upgrading.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **amanai credit attribution.** Set `usageAmanaiKey` to an amanai API key and
  the terminal report shows the **exact credit cost** per request, attributed
  from the live usage log at `https://api.amanai.dev/v1/usage` (matched by model
  + token counts). Opt-in: with no key set, no amanai request is made and no
  credits line is shown. Non-blocking — fetched in the background and cached
  ~1 min; the report never waits on the network. Credits are terminal-display
  only; the `usageEndpoint` payload is unchanged. New setting `usageAmanaiKey`
  with `CC_USAGE_AMANAI_KEY` env var; it is a secret, masked in `maskConfig`.

## [0.3.0] — 2026-08-31

🔍 **Data captured:** subagent (Task-tool) usage is now reported, a turn that
mixes models is split into one payload per model instead of being folded into
whichever model's assistant reply came last, and a cancelled turn is now
usually caught right away instead of only at session end.

### Added
- `SubagentStop` hook: reports token usage from subagents as each one
  finishes, per model. Previously this usage was dropped entirely — it's
  marked `isSidechain` in the transcript and was excluded from every figure.
- `UserPromptSubmit` hook: catches a turn you cancelled (Esc has no hook of
  its own) as soon as you type the next prompt, instead of only at
  `SessionEnd` — which may be a long time away, or never, if the session
  keeps going. Marked `interrupted`, same as the `SessionEnd` case.

### Fixed
- A turn that used more than one model (rare, but possible in the main
  conversation) no longer reports every token under whichever model produced
  the turn's last reply. Each model's usage is now its own payload, so cost
  estimates split correctly by model too.

## [0.2.0] — 2026-08-30

### Added
- Per-project setting overrides via `usageProject:<project>:<key>` (`unset`
  the same way) — a project can now use its own endpoint, its own auth, or
  any other setting, independent of the global config.
- `usageEnabled`: a master switch (default `true`). Set globally or per
  project — `usageProject:<project>:usageEnabled false` stops the reporter
  cold for that project: no terminal report, no push, no exceptions. Unlike
  `usageDisplay: off`, this also stops sending to the endpoint.

### Changed
- The detached sender now resolves each queued record's endpoint and auth by
  its own project, so records for different projects no longer share one
  endpoint when their overrides differ.

## [0.1.7] — 2026-08-30

🔍 **Data captured:** `project_label` is now always present in the pushed
payload — it defaults to the same value as `project` (the real repo/directory
name) when no label is set, instead of being omitted.

### Changed
- **Breaking:** the global `usageProjectLabel` setting is removed. Labels are
  per project only, via `usageProjectLabel:<project>` (`unset` the same way).
  A project with no override now reports its own real name as `project_label`
  rather than nothing.

## [0.1.6] — 2026-08-30

🔍 **Data captured:** when `usageProjectLabel` is set, the payload now also
carries it as `project_label`, alongside the real `project`. A payload with
no label set is unchanged.

### Changed
- `usageProjectLabel` is no longer terminal-display-only — it now rides along
  in the pushed payload too.

## [0.1.5] — 2026-08-30

### Added
- `usageProjectLabel`: a friendlier name shown in the terminal report only.
  The pushed payload still reports the real repo/directory name, so backend
  aggregation is unaffected.

## [0.1.4] — 2026-08-28

🔍 **When data is sent:** also after a turn that ends in an API error
(`StopFailure`), and as a last chance when the session dies with leftover
unreported usage (`SessionEnd`). Successful turns are unchanged.

🔍 **Data captured:** failed and interrupted turns add `error: true`,
`error_type`, and optional `error_details` (truncated to 300 characters). A
successful turn still omits those fields.

### Added
- `StopFailure` hook: the tokens used on an API-error turn are still submitted,
  marked as an error. Auth failures that never produced usage are posted with
  zeros — the error mark itself is the signal.
- `SessionEnd` hook: leftover unreported usage is flushed and marked
  `interrupted`. A clean session end (the last turn already reported) sends
  nothing.

### Known limitations
- Cancelling a turn (Esc) has no Claude Code hook. Those tokens are only sent
  if the session then ends before another prompt overwrites them.

## [0.1.3] — 2026-08-28

### Added
- `test-connection` subcommand: POSTs one real-shaped record with zero tokens to
  the configured endpoint and reports the result, including the response body —
  which is normally what names the header a rejecting endpoint expects. A
  success leaves a zero-token record on the receiving backend.

### Changed
- A failed push now captures up to 300 characters of the response body, so
  `test-connection` can show why. The body is reported on demand only; the
  failure log still records the endpoint host and status, never the body.

No change to what is captured during normal operation, or where it is sent.

## [0.1.2] — 2026-08-28

### Fixed
- **Every command the plugin told you to type was wrong.** Claude Code namespaces
  plugin commands as `/<plugin>:<command>`, so the `/usage-config` printed by the
  first-run notice, the terminal report, and the README returned
  `Unknown command: /usage-config`. All of them now show the working form,
  `/claude-usage-reporter:usage-config`, defined in one place so it cannot drift
  from the real command again.

No change to what is captured or where it is sent.

## [0.1.1] — 2026-08-28

### Fixed
- **0.1.0 reported `✘ failed to load`.** `plugin.json` declared `hooks` and
  `commands` explicitly, but `hooks/hooks.json` and `commands/` are
  auto-discovered by convention, so the manifest registered each a second time:
  `Hook load failed: Duplicate hooks file detected`. Both fields are now omitted
  and the standard directories do the work.

  Capture itself still functioned on 0.1.0 — the auto-discovered hooks loaded
  first and ran normally; only the duplicate registration failed, which marked
  the plugin as failed in `/plugin` and `claude plugin list`. Upgrading clears
  the error status; it does not recover anything, because nothing was lost.

No change to what is captured or where it is sent.

## [0.1.0] — 2026-08-28

Initial release.

🔍 **Data captured:** project name, timestamp, prompt text, session id, model, and
token counts (input / cache read / cache write / output / total), per prompt.

🔍 **When data is sent:** never, unless you set `usageEndpoint`. With no endpoint
configured the plugin makes no network calls at all. With one configured, a single
POST goes to that URL after each prompt, and nowhere else.

### Added
- Per-prompt terminal report with token breakdown, list-price cost estimate, and a
  session running total (`usageDisplay: auto` / `always` / `off`).
- Optional endpoint push, delivered from a detached process so a slow or dead
  endpoint cannot delay a prompt.
- Five auth shapes for your own backend: `None`, `Bearer`, `Basic`, `Header`
  (single custom header), `Key Pair` (split ID + secret headers).
- Retry queue: failed pushes are stored locally (capped at 500) and flushed at the
  start of the next session. Disable with `usageRetry: false`.
- `usagePromptMode`: `full`, `truncate:N`, or `none` — cap or omit prompt text
  before it leaves the machine.
- `usageUser`: optional label added to the payload, for shared accounts.
- One-time first-run notice, shown before any network call is possible.
- `/usage-config` command to inspect and change settings, with secrets masked.
- `examples/receiver.mjs`: a minimal reference receiver.

### Known limitations
- Subagent (`isSidechain`) token usage is excluded from per-turn figures.
- Costs are estimates against public list price, never authoritative billing.
