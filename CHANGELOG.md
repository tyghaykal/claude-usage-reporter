# Changelog

All notable changes to this plugin are documented here. Changes to **what is
captured** or **where it is sent** are always listed first and marked 🔍, so you can
see them before upgrading.

This project follows [Semantic Versioning](https://semver.org/).

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
