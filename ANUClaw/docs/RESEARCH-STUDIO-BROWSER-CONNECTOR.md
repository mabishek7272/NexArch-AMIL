# Research Studio — browser/MCP connector (M3)

**Status: local bridge contract + integration harness implemented and tested. Real
consumer-provider automation remains disabled** — no provider or its automation terms has been
chosen by the user, and this document does not choose one on anyone's behalf.

**Explicit, for the record**: no real Gemini, GLM, ChatGPT, Claude.ai, or any other AI-provider
account has been automated anywhere in this repository's test suite or application code. The only
"provider" any automated test ever drives is `SimulatedProviderAdapter` against the fully offline,
local fixture at `browser/fixtures/simulated-provider.html` (loaded via `file://`, never a real
network request). No paid model API call has been made by any Research Studio code path — M2's
Crossref connector is a free, public metadata API, not a model provider, and even it stays behind
an explicit live-opt-in flag for anything beyond deterministic fixture-backed tests.

## What was (re-)verified before building this pass

- `grep -iE '"(playwright|mcp|@modelcontextprotocol)'` package.json still shows only
  `playwright-core`. No MCP client or server package is installed, and none is discoverable as
  configured in this environment (unchanged since M1).
- Per the brief: *"Discover the actual installed MCP server and tool contract. If none is
  available, implement a documented bridge contract and local integration harness; label external
  connectivity unavailable."* **External connectivity to any real provider remains unavailable.**
  What follows is exactly the documented bridge contract and local harness the brief asks for in
  that situation — not a live integration.

## The documented bridge contract (implemented)

`src/research-studio/browser/contract.ts` — `BrowserResearchAdapter`: `open`, `submitPrompt`,
`pollCompletion`, `cancel`, `close`. Every provider — real or simulated — implements exactly this
interface, so a future MCP-backed adapter drops in without changing any caller. A "submission" is
one prompt sent through a connected browser session; the adapter classifies completion state
(`pending`/`partial`/`completed`/`error`/`cancelled`) and extracts text, but **never interprets
that text as an instruction** — it is handed back as plain, untrusted data.

Explicit error classification (`SubmissionErrorCode`): `session_expired`, `quota_exceeded`,
`ui_drift`, `duplicate_uncertain`, `timeout`, `unknown`. A page state that doesn't cleanly map to
one of these is `unknown`, never silently treated as `completed`.

## The local integration harness (implemented, fully offline)

- `src/research-studio/browser/fixtures/simulated-provider.html` — a single, offline, self
  contained test fixture page (loaded via `file://`, never a real network request) that behaves
  like a minimal chat-drafting UI: prompt input, submit, a `data-status` attribute (not free text)
  the adapter reads deterministically, a partial-reply + Continue flow, and a test-control panel
  (driven only by tests, never by the adapter) to inject quota-exceeded, session-expired, UI-drift,
  and duplicate-submission-while-in-flight conditions on demand. Session state persists to
  `localStorage` so a reconnect (close + reopen the same profile directory) can resume rather than
  lose track of an in-flight or already-completed submission.
- `src/research-studio/browser/simulated-provider-adapter.ts` — `SimulatedProviderAdapter`, a real
  `BrowserResearchAdapter` implementation driving that fixture with real headless Chromium
  (`playwright-core`). Every read goes through `data-testid`/`data-status` attributes, never
  free-text sniffing — a UI-drift test that removes those attributes is reported as
  `errorCode: 'ui_drift'`, not silently misread as something else.
- `src/research-studio/agents/browser-session-agent.ts` — task type
  `browser.simulated_demo_session`, registered in `register-all-agents.ts`. It is the ONLY
  consumer of a browser adapter in this codebase and it **only ever drives the simulated
  provider** — proving the whole stack (lock acquisition, budget-metered polling via the task's
  own `recordUsage`, error classification → `awaiting_user`/`failed`/`retryable_failure`, lock
  release in every code path including `finally`) through the real, unmodified M1 orchestrator.

## Session/profile management (implemented)

`src/research-studio/browser/profile-service.ts` + `research_studio_browser_profiles` (migration
in `src/db/connection.ts`):

- **Never a credential.** The database row holds only `provider`, `label`, `status`, the
  profile's own on-disk directory path, and the current lock holder's task id. The authenticated
  browser state (cookies, local storage, session tokens) lives entirely in an isolated,
  owner-only, mode-0700 Playwright user-data directory on disk — never committed, never logged
  verbatim, addressed only by a server-generated UUID.
- **Manual login / takeover state machine**: `disconnected → connecting → active`, plus
  `expired`/`revoked`. `beginConnect` moves to `connecting`; nothing here infers a successful
  login — `confirmConnected` requires an explicit human confirmation to reach `active`. (For the
  simulated provider, "login" is a no-op since there is nothing to authenticate; a real provider
  adapter would require an actual headed browser window for the human to use between these two
  calls — that flow is specified here but not built, since no real provider is enabled.)
- **Session lock**: a per-profile mutex (`locked_by_task_id`/`locked_at`) using the exact same
  atomic-CAS pattern as `task-store.ts#claimNextReady`. A second task cannot drive an already-locked
  profile. A lock whose holder task crashed is swept on the next acquisition attempt
  (`STALE_LOCK_MS`), independently of — and consistently with — M1's own task-level stale-claim
  recovery.
- **Prompt/action budgets**: reused directly from M1/M2 — `browser-session-agent.ts` calls the
  task's own `recordUsage` once per poll, so a task's declared `budget.maxActions` is a real,
  enforced ceiling, not a suggestion.
- **Disconnect/revoke**: `disconnectProfile` clears the on-disk directory and resets to
  `disconnected` (reversible — a new connect gets a fresh directory); `revokeProfile` is
  permanent (the directory is deleted and the profile can never reconnect).
- **Redacted traces**: nothing in this module writes a Playwright trace, screenshot, or raw page
  dump into the application database or logs. The only persisted artifacts are the metadata
  columns above; anything else lives only in the local, access-restricted profile directory for
  the lifetime of that directory.

## What is still disabled, and why

- **No real provider adapter exists.** The brief: *"Keep real consumer-provider automation
  disabled until a provider and its terms are selected by the user. Do not silently use a paid
  API."* `SimulatedProviderAdapter` is the only adapter; there is no code path anywhere that
  reaches a real website or falls back to a paid model API when the browser path is unavailable.
- **No MCP transport exists** — still no installed MCP package. If one is added later, it
  implements `BrowserResearchAdapter` exactly as `SimulatedProviderAdapter` does, and
  `browser-session-agent.ts` (or a successor) would select it behind an explicit, separate
  live-connector flag — the same pattern M2 used for the Crossref connector
  (`ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR`).
- **Manual-login UX for a real provider is specified, not built** — it needs an actual visible
  browser window a human can interact with, which this server-side test harness does not launch.

## Remaining external/account inputs needed before any live integration

- A decision on which AI-provider account(s) the user will manually log into for drafting
  sessions (subscription terms must actually permit this kind of automation — "do not assume a
  consumer subscription authorises automation").
- Installation of an MCP server package compatible with this repository's Node/TypeScript runtime,
  or an explicit decision to keep using the bridge-contract/adapter pattern without one.
- A feature-flag decision for where a real provider ships first (admin-only, or gated by role),
  and the manual-login window implementation itself (desktop/CLI launcher or an equivalent).

Until a real adapter exists and that flag is enabled, `browser.simulated_demo_session` is the only
registered `browser.*` task type, and it never reaches a real website.
