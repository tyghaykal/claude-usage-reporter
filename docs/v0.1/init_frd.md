# FRD: Claude Code Token Usage Reporter (Plugin)

**Document Type:** Functional Requirements Document
**Product/Feature:** Token Usage Reporter for Claude Code
**Author(s):** tyghaykal
**Status:** Draft
**Last Updated:** August 28, 2026
**Stakeholders:** Engineering, Project Coordination, Finance/Cost tracking, Public plugin users (any Claude Code user)
**Distribution:** Public — published for general install by any Claude Code user, not limited to any one organization

---

## 1. Overview

A general-purpose Claude Code **plugin** that automatically captures token usage per prompt and per session for **any** Claude Code user — regardless of how they authenticate (Pro, Max, Team, Enterprise subscription, or a direct Anthropic API key) — and either:

- **Pushes** a structured usage report to a user-configured HTTP endpoint after every prompt, or
- **Falls back** to printing a token usage report directly in the terminal after **every prompt/call**, if no endpoint has been configured — not just at session end.

The plugin must work identically for a solo developer on a Pro plan, a team sharing one account, and an organization using metered API billing. Installation and behavior must not assume any single company's project structure, account setup, or backend.

---

## 2. Background

Claude Code does not expose a historical, exportable, per-prompt token usage report. `/usage` and `/context` show live, in-session totals only — nothing is persisted, and nothing is sent anywhere automatically. This is a gap for **any** Claude Code user who wants to:

- See where usage is going across prompts, sessions, or projects
- Feed that data into their own cost dashboard, spreadsheet, or billing/chargeback process
- Do this without hand-writing hooks or scripts themselves

This plugin is intended to be publishable and installable by any Claude Code user or team — not tied to one organization's infrastructure, subscription type, or naming conventions.

---

## 3. Problem Statement

- No visibility into per-prompt or per-session token usage, for any account type.
- No standard, reusable way to route that data into a team's own systems.
- No safe, ready-made distribution — anyone who wants this today has to hand-roll hooks and shell scripts themselves.
- Different users will have different setups (solo API key, shared subscription, enterprise account) — the plugin cannot assume any one of these.
- Setup effort varies by user; the plugin must work with **zero required configuration**, and be *better* with optional configuration, for every install type.

---

## 4. Goals

- G1: Capture, for every prompt: **project name, date/time, prompt text, token usage.**
- G2: Support an **optional** configurable endpoint URL that receives this data automatically after every prompt/session.
- G3: If no endpoint is configured, **display the token usage report inline** in the terminal after **every** call/prompt completes — no data loss, no silent no-op, and no waiting until session end to see it.
- G4: Installable as a Claude Code **plugin** via the standard plugin/marketplace flow — no manual hook-editing required by end users.
- G5: Safe and portable by design — reads only local session data Claude Code already writes; never touches OAuth tokens, routing, or third-party model providers; works the same whether the user authenticates via subscription or API key.
- G6: **Auth-agnostic** — functionally identical behavior whether the underlying Claude Code session is backed by a Pro/Max/Team/Enterprise subscription or a direct API key, since token usage data is exposed by Claude Code the same way in both cases.
- G7: Distributable to a general audience — installable by any Claude Code user without adaptation, not limited to a single company's environment.

---

## 5. Non-Goals

- Not a cost-optimization or model-routing tool (no request routing, no fallback providers, no multi-provider switching).
- Not a replacement for Anthropic's own `/usage` or `/context` — this is a persistence/export layer on top of what already exists locally.
- Not responsible for authoritative billing. On subscription plans, figures are **estimates only**; on API-key accounts, figures should align closely with billed usage but the plugin is still not the system of record — see [Anthropic's Usage & Cost API] for authoritative billing.
- Does not attempt per-user attribution on a shared account in v1 (see Open Questions) — the plugin has no concept of "team," only of a single local install.
- Does not capture subagent-internal token usage in v1 (see Known Limitations).
- Does not provide a hosted backend/dashboard — the plugin is a capture-and-forward layer; the receiving endpoint is BYO (bring your own).

---

## 6. Scope

### In Scope
- Claude Code plugin packaging and install flow, suitable for public distribution (e.g. a plugin marketplace entry or public repo).
- Endpoint URL configuration (optional, via plugin settings or environment variable), with no assumptions about what backend receives it.
- Per-prompt capture: project name, datetime, prompt text, token usage breakdown.
- Push-to-endpoint behavior when configured.
- Fallback terminal display behavior when not configured.
- Basic retry/failure handling for endpoint delivery (best-effort, non-blocking).
- Support for both subscription-based and API-key-based Claude Code sessions with no behavior difference.

### Out of Scope (v1)
- A hosted dashboard or backend service to receive the data (assumed to be built/owned by whoever installs the plugin).
- Per-user attribution on shared accounts.
- Cross-session historical reporting inside Claude Code itself.
- Cost alerts, budget caps, or usage-limit enforcement.
- Organization-specific project taxonomy (business units, client tagging, etc.) — kept generic; specific taxonomies can be layered on by the receiving endpoint, not the plugin.

---

## 7. Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | The plugin must be installable via the standard Claude Code plugin install flow (marketplace/catalog or manual add), without requiring users to hand-edit `settings.json` hooks. | Must |
| FR-2 | On install, the plugin must register the lifecycle hooks needed to capture prompt text and post-response token usage automatically, with no further action from the user. | Must |
| FR-3 | The plugin must expose an **API endpoint URL** setting (e.g. `usageEndpoint` in plugin config, or a `CC_USAGE_ENDPOINT` environment variable). | Must |
| FR-4 | The plugin must expose an **auth token type** setting, letting the user choose how credentials are sent, since different backends expect different shapes. At minimum: `None`, `Bearer` (`Authorization: Bearer <token>`), `Basic`, `Header` (single custom header + value, e.g. `X-API-Key: <value>`), and `Key Pair` (two custom headers — a key ID header + a key secret header — for backends that split credentials into two values). | Must |
| FR-4a | For `Bearer`/`Basic`, the plugin must expose a single **token value** setting. For `Header`, it must expose a **header name** (default `X-API-Key`) and a **value**. For `Key Pair`, it must expose two header-name/value pairs (e.g. **key ID header name + value**, **key secret header name + value**), since some endpoints authenticate with an ID/secret pair rather than a single token. | Must |
| FR-5 | If an endpoint URL **is** configured, the plugin must automatically POST a usage report after each prompt/turn completes. | Must |
| FR-6 | If an endpoint URL is **not** configured, the plugin must not fail silently — it must print a formatted token usage report to the terminal immediately after **every** prompt/call completes (not deferred to session end). | Must |
| FR-7 | Each captured record must contain, at minimum: **project name**, **date/time**, **prompt text**, and **token usage** (input, cache read, cache write, output, and total). | Must |
| FR-8 | Project name must be derived automatically (e.g. from the git repository name or working directory) — no manual entry required, and no assumption of any particular naming scheme. | Must |
| FR-9 | Endpoint delivery must be **non-blocking**: a slow or failing endpoint must never delay or interrupt the user's next prompt. | Must |
| FR-10 | If an endpoint push fails (timeout, non-2xx response, network error), the plugin must not crash the session, and should surface the failure only as a non-intrusive terminal notice — not as an error that halts the workflow. | Should |
| FR-11 | The fallback terminal display (FR-6) must be human-readable: a per-call breakdown (that call's input/output/cache/total tokens), not a raw JSON dump. A running session subtotal may be shown alongside it, but the per-call figure must always be present. | Must |
| FR-12 | Configuration changes (setting or clearing the endpoint) must take effect on the next session without requiring reinstall. | Should |
| FR-13 | The plugin must behave identically regardless of the account type backing the session — Pro, Max, Team, Enterprise subscription, or a direct Anthropic API key — since it only reads usage data Claude Code exposes locally, not billing-account metadata. | Must |
| FR-14 | The plugin must not require any author-specific, project-specific, or organization-specific configuration to function — it must work out of the box for any Claude Code project. | Must |
| FR-15 | Documentation (README/install instructions) must be written for a general external audience, not assuming a specific company's tooling or workflows. | Should |
| FR-16 | On first run after install, before any data is ever sent anywhere, the plugin must show a one-time notice stating what is captured (including that prompt text is included) and that nothing leaves the machine unless the user sets an endpoint. | Must |
| FR-17 | Both output modes (endpoint push and terminal display) may be enabled simultaneously if the user explicitly turns both on. **By default, only one mode is active at a time**: if no endpoint URL is set, terminal display is on; the moment a valid endpoint URL is set, terminal display turns off automatically unless the user explicitly re-enables it (e.g. via a `usageDisplay: always` setting). | Must |

---

## 8. User Flows

### 8.1 Install (first-time setup, any user)
1. User installs the plugin via Claude Code's plugin install command/catalog — same flow whether they're on a Pro subscription, a Max/Team/Enterprise plan, or an API key.
2. Plugin registers hooks silently — no further steps required.
3. Plugin shows a one-time notice (FR-16) explaining what it captures and that nothing is sent anywhere until an endpoint is set.
4. *(Optional)* User sets an endpoint URL and, optionally, an auth token — pointing at whatever backend they run or use (their own server, a SaaS dashboard, a simple webhook, etc.).
5. User continues working normally.

### 8.2 Per call, with endpoint configured
1. User submits a prompt.
2. Claude responds; token usage is recorded.
3. Plugin composes a report (project, datetime, prompt, tokens) and pushes it to the configured endpoint in the background.
4. User is not blocked or interrupted; no visible change to their workflow beyond the response itself.

### 8.3 Per call, without endpoint configured (fallback — the default, out-of-box experience)
1. User submits a prompt; Claude responds.
2. Immediately after that response, the plugin prints that call's token usage to the terminal: input/output/cache/total tokens, and an estimated cost if pricing data is available.
3. This repeats after every call — the user does not have to wait until the session ends to see any usage data.
4. This is the experience for every user immediately after install, before they've made any decision about where (or whether) to send data elsewhere.

### 8.4 Endpoint temporarily unreachable
1. Push attempt fails (timeout/error).
2. Plugin logs the failure locally (not shown as a hard error) and continues.
3. Session is unaffected; no retry queue is required for v1 (see Open Questions if this needs upgrading later).

---

## 9. Data Requirements

### 9.1 Captured Fields (per prompt)

| Field | Description | Source |
|-------|-------------|--------|
| `project` | Project/repo name | Derived from git root or working directory |
| `datetime` | Timestamp of capture (UTC) | System clock at response completion |
| `prompt` | Exact text of the user's submitted prompt | Captured at prompt-submit time |
| `tokens.input` | Input tokens for the turn | Claude Code's local session data |
| `tokens.output` | Output tokens for the turn | Claude Code's local session data |
| `tokens.cache_read` | Cache-read tokens | Claude Code's local session data |
| `tokens.cache_write` | Cache-creation tokens | Claude Code's local session data |
| `tokens.total` | Sum of the above | Computed |
| `session_id` | Claude Code session identifier | Claude Code's local session data |
| `error` | `true` on a failed or interrupted turn; omitted on success | `StopFailure` / leftover `SessionEnd` |
| `error_type` | Short slug (`rate_limit`, `interrupted`, …); omitted on success | Hook input, sanitised |
| `error_details` | Optional, truncated to 300 characters; omitted on success | Hook `error_details` / session-end reason |

Note: no account-type or billing-plan field is included by design — the plugin's data model is intentionally the same regardless of whether the session is subscription- or API-key-backed, satisfying G6. A successful turn omits the error fields so existing backends keep the original payload shape.

### 9.2 Example Payload (endpoint push)

```json
{
  "project": "my-project",
  "datetime": "2026-08-28T10:15:00Z",
  "prompt": "fix the login bug",
  "session_id": "abc-123",
  "tokens": {
    "input": 1234,
    "cache_read": 800,
    "cache_write": 200,
    "output": 450,
    "total": 2684
  }
}
```

Failed / interrupted turn (same payload, plus):

```json
{
  "error": true,
  "error_type": "rate_limit",
  "error_details": "retry in 2s"
}
```

### 9.3 Fallback Display (example — shown after every call)

```
[my-project] 2026-08-28 10:15:00 UTC
Tokens — input: 1,234 | cache read: 800 | cache write: 200 | output: 450 | total: 2,684
Est. cost (list price): $0.0142
Session running total: 14,320 tokens across 6 prompts

No usage endpoint configured — set one to auto-report instead:
  claude config set usageEndpoint <url>
```

---

## 10. Configuration

| Setting | Type | Required | Default |
|---------|------|----------|---------|
| API endpoint URL | string (URL) | No | Unset |
| Auth token type | enum: `None`, `Bearer`, `Basic`, `Header`, `Key Pair` | No | `None` |
| Auth token value | string (secret) | Only when type = `Bearer` or `Basic` | Unset |
| Header name | string | Only when type = `Header` | `X-API-Key` |
| Header value | string (secret) | Only when type = `Header` | Unset |
| Key ID header name | string | Only when type = `Key Pair` | `X-API-Key-Id` |
| Key ID value | string (secret) | Only when type = `Key Pair` | Unset |
| Key secret header name | string | Only when type = `Key Pair` | `X-API-Key-Secret` |
| Key secret value | string (secret) | Only when type = `Key Pair` | Unset |
| Terminal display mode | enum: `auto`, `always`, `off` | No | `auto` |

**Why five auth types:** endpoints in the wild authenticate differently — a single bearer token, HTTP Basic, a single custom header like `X-API-Key`, or a split ID+secret pair sent as two separate headers. Rather than guessing, the plugin lets the user pick the shape their own backend expects.

**Default mode logic (FR-17):**
- `auto` (default): terminal display is shown **only if no endpoint URL is set**. As soon as a valid endpoint URL is configured, terminal display turns off automatically — the user sees pushes go out silently, matching "by default only one is active."
- `always`: terminal display is shown on every call regardless of whether an endpoint is also configured — lets a user opt into both simultaneously.
- `off`: terminal display never shows, even with no endpoint configured — not recommended as a resting state, since it would leave the user with no visibility at all if they haven't set an endpoint (see PD-1/FR-16 intent), but available for advanced/scripted use.

All settings should be settable both via plugin settings (preferred, discoverable) and via environment variables (for scripted/CI use), with plugin settings taking precedence if both are present. None of these settings should require knowledge of the user's account/billing type — the plugin never needs to know whether it's running under a subscription or an API key.

### 10.1 Example Configurations

```jsonc
// Bearer token
{
  "usageEndpoint": "https://myteam.example.com/claude-usage",
  "usageAuthType": "Bearer",
  "usageAuthToken": "sk-xxxxxxx",
  "usageDisplay": "auto"
}
```

```jsonc
// Single custom header (e.g. X-API-Key)
{
  "usageEndpoint": "https://myteam.example.com/claude-usage",
  "usageAuthType": "Header",
  "usageHeaderName": "X-API-Key",
  "usageHeaderValue": "sk-xxxxxxx",
  "usageDisplay": "auto"
}
```

```jsonc
// Key ID + Key Secret pair
{
  "usageEndpoint": "https://myteam.example.com/claude-usage",
  "usageAuthType": "Key Pair",
  "usageKeyIdHeaderName": "X-API-Key-Id",
  "usageKeyIdValue": "id_abc123",
  "usageKeySecretHeaderName": "X-API-Key-Secret",
  "usageKeySecretValue": "sec_xyz789",
  "usageDisplay": "always"
}
```

---

## 11. Non-Functional Requirements

- **Safety:** Must not read, store, or transmit OAuth tokens, API keys, session credentials, or anything used for authentication *to Claude/Anthropic*. Must not alter request routing. Must not attempt to detect or branch on account type. Any user-supplied endpoint credential (bearer token, basic auth, header value, key ID, key secret — §10) is a separate, user-owned secret for their own backend — each must be stored using the same mechanism Claude Code uses for other local secrets/config (not logged, not included in the fallback terminal output, not sent anywhere except the configured endpoint).
- **Performance:** Capture and push logic must add negligible latency to the user's prompt/response cycle (target: no perceptible delay).
- **Reliability:** A failing or slow endpoint must never block or crash a Claude Code session.
- **Portability:** Must work the same way across any machine, account type, and OS Claude Code supports — no per-environment setup beyond the optional endpoint config.
- **Privacy:** Prompt text will be transmitted to the configured endpoint — this must be clearly stated in the plugin's install/README so any adopter (not just an internal team) understands raw prompts leave the local machine once an endpoint is set.
- **Auditability:** Since this plugin may be installed by third parties outside the original team, its source and hook registration should be easy to inspect (plain scripts/config, not obfuscated logic) so adopters can verify what it does before trusting it with prompt content.

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Endpoint receives sensitive prompt content (credentials, client data, etc.) | Document clearly in install instructions; consider a future redaction/opt-out-per-field setting |
| Endpoint downtime causes silent data loss | Acceptable for v1 (best-effort); flag as a candidate for a local retry queue in v2 |
| Token figures are estimates on subscription plans, not authoritative billing | Clearly label all reports/output as "estimated" on subscription accounts; on API-key accounts, note figures should closely track billed usage but are still not the system of record |
| A general audience installs the plugin without understanding what data leaves their machine | README must state plainly, near the top, what is captured and where it goes when an endpoint is configured |
| User's endpoint auth credentials are exposed (logged, printed, or leaked to the wrong destination) | No credential field (token, header value, key ID, key secret) may ever appear in terminal output, error messages, or the first-run notice; store using Claude Code's standard local secret/config mechanism only |
| Assumptions creep in that only fit one company's setup (naming, project structure, single-account use) | Explicitly test install/usage against at least one external, unrelated repo/workflow before calling v1 "general" |

---

## 13. Acceptance Criteria

- [ ] Plugin installs cleanly via the standard Claude Code plugin flow.
- [ ] With no endpoint configured, every single call/prompt produces a visible token usage report in the terminal immediately after the response — not deferred to session end.
- [ ] With an endpoint configured, every prompt results in a POST containing project, datetime, prompt, and token fields.
- [ ] A broken/unreachable endpoint does not interrupt or slow down the user's session.
- [ ] Project name is captured correctly across multiple, unrelated repos without manual configuration.
- [ ] No credentials, tokens, or auth material appear in any captured payload.
- [ ] Verified working identically on at least one subscription-backed session and one API-key-backed session.
- [ ] Verified installable and usable by someone outside the originating team, using only the published README.
- [ ] First-run notice (FR-16) appears before any possible network call, on a clean install.
- [ ] Plugin source is publicly inspectable (PD-2) with no obfuscated or minified logic.
- [ ] With only an endpoint configured (default `auto` display), terminal output is suppressed and pushes go out per call.
- [ ] With no endpoint configured (default `auto` display), terminal output shows per call and no network call is ever made.
- [ ] With `usageDisplay: always` and an endpoint both set, both the push and the terminal output occur on every call.
- [ ] Each of the five auth token types (`None`, `Bearer`, `Basic`, `Header`, `Key Pair`) produces the correct request header(s) against a test endpoint, including `Key Pair` sending both configured headers on every push.
- [ ] All auth-related secret values (token, header value, key ID, key secret) never appear in terminal output, logs, or the first-run notice under any configuration.

---

## 14. Open Questions

1. Should the plugin ship with a reference/example backend (a minimal receiver implementation) to make the "endpoint" side less abstract for new adopters, even though the backend itself is out of scope?
2. Should per-user attribution be supported at all in v1 (e.g. an optional, user-set `usageUser` value), given that shared-account setups are one of several expected use cases, not the only one?
3. Should failed endpoint pushes be queued and retried on the next session, or is best-effort (drop on failure) acceptable long-term?
4. Should prompt text be redacted/truncated by default, given the plugin is now meant for a general audience with varying sensitivity needs, rather than one team's known risk profile?
5. ~~Should the plugin be published to a public Claude Code plugin marketplace, or distributed privately for now?~~ **Resolved:** public distribution — confirmed. See §16 for the additional requirements this triggers.
6. ~~Given per-call terminal output is the default experience, should there be a way to mute it without setting an endpoint?~~ **Resolved:** `usageDisplay` setting (`auto`/`always`/`off`) added — see §10.
7. ~~Should the `API Key` auth type support more than one custom header?~~ **Resolved:** yes — added as a distinct `Key Pair` type (two headers: key ID + key secret), alongside `Header` for the single-header case (e.g. `X-API-Key`). See §10.

---

## 15. Public Distribution Requirements

Since this plugin is confirmed for public release — installable by any Claude Code user, not just the author — the following apply on top of the general requirements above:

| ID | Requirement | Priority |
|----|-------------|----------|
| PD-1 | The plugin must never transmit prompt text or usage data anywhere by default. Data only leaves the machine after the user explicitly sets an endpoint (already covered by FR-3/FR-16, restated here as a hard public-release gate). | Must |
| PD-2 | Source (hooks, scripts, config) must be publicly readable in the plugin's repository — no bundling/minifying logic that a security-conscious adopter can't audit before install. | Must |
| PD-3 | The plugin listing/README must state plainly, before install: what data is captured, what triggers a network call, and that the receiving endpoint (if set) is entirely the user's own responsibility — the plugin author has no visibility into or control over what that endpoint does with the data. | Must |
| PD-4 | Versioning and changelog must be public, so adopters can see what changed between updates before upgrading (especially any change to what's captured or where it's sent). | Should |
| PD-5 | A support/feedback channel (issues page, contact) must be listed, since public users won't have a direct line to whoever installed it internally. | Should |

---

## 16. Appendix: Reference Pricing (for cost estimation only, not billing)

For subscription accounts (flat-rate), any "cost" shown is an **estimate** against public API list price, for visibility only — not an actual charge. For API-key accounts, the same estimate should closely approximate real billed cost, though the plugin still isn't authoritative — for real billing, users should be pointed to Anthropic's own usage/cost reporting. Pricing should be kept as a small, updatable lookup table inside the plugin rather than hardcoded, since Anthropic updates rates periodically.