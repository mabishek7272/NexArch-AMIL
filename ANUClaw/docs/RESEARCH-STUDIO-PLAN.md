# ANUClaw Research Studio — plan and current status

Autonomous, agentic research-authoring feature: a researcher states a brief (topic, question,
article type, target journal/university, limits, visuals); Research Studio coordinates research
agents to clarify scope, investigate literature, extract and synthesise evidence, draft a
manuscript/thesis, critique and revise it within bounded iterations, and export a reviewable
package. **It must perform executable work and retain evidence of that work — a dashboard with
mock responses is not completion.**

This document states, honestly, what is implemented now versus planned, so no reader mistakes
foundation work for a finished feature. **M1–M6 are now complete** — see
[RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md) for the full final handoff:
capabilities by milestone, exact fresh test/build results, real-vs-simulated evidence, and the exact
boundary preventing a production-ready or clinically-valid claim.

## Milestones (plan §11)

| Milestone | Scope | Status |
|---|---|---|
| **M1** | Durable, resumable project + task-graph engine; one real, zero-cost, deterministic agent (Research Planner); owner-only API + dashboard page | **Implemented and tested** |
| **M2** | Evidence graph (search strategies → search runs → sources → dedup links → artifacts → excerpts → claims → claim-evidence links → screening → evidence matrix), real Literature Scout / Source Verifier / Evidence Extractor / Evidence Matrix Builder agents, one bounded public connector (Crossref), local RIS/BibTeX/PDF import | **Implemented and tested** (this pass) — Synthesis Agent remains unimplemented (M4 scope) |
| **M3** | Documented bridge contract + local Playwright integration harness (simulated provider); profile/session management; prompt/action budgets | **Local harness implemented and tested** (this pass) — real consumer-provider automation stays disabled; no MCP package exists in this repo (only `playwright-core`); see [RESEARCH-STUDIO-BROWSER-CONNECTOR.md](RESEARCH-STUDIO-BROWSER-CONNECTOR.md) |
| **M4** | Manuscript Writer, Thesis Coordinator, Methods/Statistics Agent, Scientific Critic (bounded revision loop), Citation Auditor, Editorial Agent (author-voice editing), journal/university guidelines + compliance report | **Implemented and tested** (this pass) — no model/browser-generated prose; all content is human-authored or an honest deterministic placeholder |
| **M5** | Visual Agent (conceptual diagrams + data-derived charts/tables, PRISMA flow), Export Service (Markdown/BibTeX/RIS/LaTeX-source/PDF/DOCX), hash-chained provenance manifest | **Implemented and tested** — `export.manuscript` is registered for the first time since M1; DOCX gap closed |
| **M6** | Integrated end-to-end acceptance test, focused security/failure-mode tests, export integrity verification, dashboard completion audit, final release handoff | **Implemented and tested** — see [RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md) |

## What M1 actually built (verifiable now)

- **Durable task-graph engine** (`src/research-studio/task-store.ts`): 8 required states exactly
  (`queued, running, awaiting_user, paused, retryable_failure, failed, cancelled, completed`);
  Postgres-persisted (resumable after a process restart); atomic claim (`claimNextReady`);
  idempotent commit keyed to a one-time claim token (a duplicate commit of the *same* result is a
  no-op, a *different* result is refused — protects against duplicate submissions); exponential
  backoff retry up to `max_attempts`; stale-claim sweep (`sweepStale`) recovers a task whose claim
  survived a crash/restart; pause/resume/cancel/resolve-awaiting-user, each only from a sensible
  state; per-task action/token budgets that fail a task **closed** (never silently exceed);
  bounded revision groups (`revisionGroup` + `maxRevisionsInGroup`) that refuse to grow past the
  cap — the generic mechanism the brief's "bounded critic/revision loop" requirement will reuse;
  downstream invalidation (BFS) that flags every completed dependent task when its supporting
  result is invalidated, without deleting the artifact.
- **Append-only, hash-chained event log** (`research_studio_task_events`): every state transition
  is recorded; `verifyEventChain` re-derives the chain and reports the exact break point if
  tampered; a Postgres trigger (`research_studio_immutable()`) refuses UPDATE/DELETE/TRUNCATE at
  the database level, independent of the application code.
- **One real agent — Research Planner** (`src/research-studio/agents/research-planner.ts`): a
  pure, deterministic function from `(mode, brief)` to a task graph. It never invents a method or
  a result: an `original_research` project without `hasData: true` gets no
  `writing.draft_sections` task at all (recorded as a `missingInputs` entry, not silently
  skipped); review modes require a stated real search method; a `systematic_review` label is
  refused without a traceable search strategy (databases + queries). Unset bounds (word/page
  limits, revision rounds) are surfaced as `unresolvedDecisions`, never silently defaulted.
- **Brief validation** (`src/research-studio/project-service.ts`): enforces the plan §1 rules
  before a project is ever created or its brief revised — same rules the planner also checks, so
  a caller cannot bypass them by going straight to task creation.
- **Owner-only isolation** (`src/research-studio/permissions.ts`): a project/task not owned by the
  caller answers 404, never 403 (no existence disclosure) — the same pattern as
  `src/research/service.ts`.
- **Agent registry honesty** (`src/research-studio/agent-registry.ts`,
  `orchestrator.ts#projectGraphView`): only a task type with a *registered* handler is ever
  claimed. Every other type stays `queued` indefinitely and is reported with
  `agentAvailable: false` in the API and the dashboard — **never fabricated as having run.**
- **API** (`src/dashboard/server/routes/research-studio.ts`, mounted at
  `/api/research-studio`): roles admin/operator/clinician, owner-only. `POST /projects` creates a
  project, immediately seeds and runs the Research Planner task to quiescence (it is free and
  deterministic) so the graph exists on first load. `POST /projects/:id/advance` advances as far
  as currently-registered agents allow, bounded (`maxSteps`, capped at 200). Task-level
  pause/resume/cancel/resolve routes. `GET /projects/:id/events` returns the event log plus its
  verified hash chain.
- **Dashboard page** (`dashboard/src/pages/ResearchStudio.tsx`, nav entry "Research Studio"): create
  a project, see the real task graph with each task's real status, and an explicit "no agent yet"
  label for any task type with no registered handler, counted in a visible "N of M tasks have no
  agent" line. Pause/resume/cancel buttons call the real API. No progress bar, agent-activity log,
  or citation list is invented — those only appear once the agents that would really produce them
  exist (M2+).

## What M2 actually built (verifiable now)

- **Evidence persistence** (`src/db/connection.ts` migration; `src/research-studio/types.ts`):
  `research_studio_{search_strategies,search_runs,sources,source_versions,source_links,artifacts,
  excerpts,claims,claim_evidence_links,screening_decisions,evidence_matrices}`. Four independent
  status columns are never collapsed into one another: `metadata_verification_status`
  (unknown/unverified/verified/mismatch), `fulltext_status` (unknown/unavailable/abstract_only/
  full_text), `correction_status` (unknown/none/corrected/retracted), `claim_support_status`
  (unknown/unresolved/supported/contradicted). **A resolved DOI does not set anything to
  'verified'; an unavailable check stays 'unknown', never 'unavailable' on a guess.**
- **Citation identity** (`citation-service.ts`, pure, unit-tested): DOI/PMID/URL normalisation and
  a strict identifier-preference order (DOI > PMID > URL > title+year) for the exact-duplicate
  index. A *near* match (different identifier, close title) is only ever **proposed** as a
  `source_link` for a human to confirm or reject — never auto-merged, so a preprint, a correction
  and the published version of a paper stay distinct records until a person says otherwise.
- **Four real, registered agents** (`agents/{literature-scout,source-verifier,evidence-extractor,
  evidence-matrix-builder}.ts`), wired into the planner's existing graph as new nodes
  (`literature.verify_sources`, `evidence.build_matrix`) alongside the M1 nodes:
  - *Literature Scout* — `literature.search_strategy` (deterministic, from the brief) and
    `literature.search_execute` (one bounded public connector, Crossref metadata only, or an
    explicit hand-off to local import — **never a silent paid-model fallback**; live retrieval is
    opt-in via `ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR=1`).
  - *Source Verifier* — `literature.verify_sources`: a resolving DOI with matching title/year →
    `verified`; a non-resolving ("fabricated") DOI → `mismatch` (a verification **failure**, never
    silently `unknown`); Crossref's own `update-to` field sets `correction_status` directly.
  - *Evidence Extractor* — `evidence.extract`: ingests **structured, human-supplied** excerpts
    (exact page/section/table locator required); with none supplied it asks the user via the
    existing `awaiting_user` mechanism rather than fabricating a reading of the paper. Semantic
    extraction is explicitly unavailable (no model/browser adapter exists — M3/M4).
  - *Evidence Matrix Builder* — `evidence.build_matrix`: a pure aggregation over already-recorded
    claims/links/excerpts/sources — no new judgement, no model call.
  All four use `recordUsage` (M1's existing, previously-unwired budget primitive — `AgentContext`
  now carries the claim `token` so a handler can actually enforce its task's budget, not just
  declare one).
- **Crossref connector** (`connectors/crossref.ts`): verified against Crossref's current
  documentation before writing it (see the file's own header); reuses
  `src/sciencedata/fetcher.ts`'s `SafeFetcher` (origin allow-list, redirect pinning, size cap,
  timeout, retry) rather than a bespoke HTTP client; injectable fetcher for fixture-based,
  no-network tests.
- **Local import** (`import-service.ts`): hand-written RIS and BibTeX parsers (no such dependency
  existed in this repo) that preserve every original record and report a parse failure by name,
  never silently drop it; permitted local PDF/text artifact storage reusing the existing
  `extractPdfText` (`src/documents/pdf-extract.ts`), under a project/source-scoped, mode-0700
  directory addressed only by server-generated UUIDs (never a caller-supplied path segment).
- **Downstream invalidation reuses M1, not a parallel scheme**: `evidence-service.ts#
  reviseSourceMetadata` flags a source's excerpts invalidated on a material change (new DOI/title,
  or a correction/retraction appearing) and calls M1's own `task-store.invalidateDownstream` on
  every task that produced one of those excerpts — exactly the brief's instruction to invalidate
  "through the existing M1 mechanism."
- **API + UI**: ~20 new owner-only routes under `/api/research-studio` (search strategies/runs,
  sources, import, artifacts, screening, source-links, excerpts, claims, claim-evidence links,
  evidence matrix); `dashboard/src/components/research-studio/EvidenceWorkspace.tsx` (import
  workflow, source library with per-status badges, duplicates review, source detail + artifact
  upload, excerpt editor, claim/support views, evidence matrix), mounted into
  `ResearchStudio.tsx` under the task graph.

## What M3 actually built (verifiable now)

- **Documented bridge contract** (`src/research-studio/browser/contract.ts`):
  `BrowserResearchAdapter` (`open`/`submitPrompt`/`pollCompletion`/`cancel`/`close`) and an
  explicit `SubmissionErrorCode` set (`session_expired`/`quota_exceeded`/`ui_drift`/
  `duplicate_uncertain`/`timeout`/`unknown`) — any provider adapter, real or simulated,
  implements exactly this interface.
- **Local Playwright integration harness** (`browser/fixtures/simulated-provider.html` +
  `browser/simulated-provider-adapter.ts`): a fully offline (`file://`), self-contained fixture
  page driven by real headless Chromium, exercising every scenario plan §4 names — prompt
  submission, completion detection, partial replies + continuation, duplicate-submission
  uncertainty, session expiry, quota errors, UI drift, cancellation, and reconnect/resume via
  `localStorage`-backed session state.
- **One real task-type integration** (`agents/browser-session-agent.ts`, task type
  `browser.simulated_demo_session`): the only consumer of a browser adapter anywhere in this
  codebase, and it only ever drives the simulated provider — full lifecycle through the real,
  unmodified M1 orchestrator (lock acquire/release, budget-metered polling via `recordUsage`,
  error classification into `awaiting_user`/`failed`/`retryable_failure`).
- **Profile/session management** (`browser/profile-service.ts`,
  `research_studio_browser_profiles`): metadata-only rows (provider/label/status/lock holder —
  **never a credential, cookie, or token**); the authenticated browser state lives only in an
  isolated, mode-0700, on-disk directory addressed by a server-generated UUID.
  `disconnected → connecting → active` requires an explicit human confirmation at each step;
  `expired`/`revoked` states; a per-profile session lock using the exact same atomic-CAS pattern
  as `task-store.ts#claimNextReady`, with its own independent stale-lock sweep; disconnect
  (reversible) vs. revoke (permanent).
- **Dashboard** (`ConnectorStatus.tsx`): create/connect/confirm/disconnect/revoke a profile,
  showing real status and lock state — honestly labelled that only the offline simulated provider
  works today and no real AI-provider automation is connected.

## What M4 actually built (verifiable now)

- **Synthesis Agent** (`agents/synthesis-agent.ts`, task type `evidence.synthesize`): a pure
  restatement of the already-built evidence matrix (claims grouped by status, explicit gaps) —
  no new judgement, no prose. This unblocks the review-mode chain, which previously stalled here
  forever (M2 left it unregistered).
- **Manuscript Writer** (`agents/manuscript-writer.ts`): `outline.draft` — a deterministic,
  mode-appropriate section skeleton (a template choice, never a fabricated finding).
  `writing.draft_sections` — accepts STRUCTURED, human-supplied section text via the same
  `awaiting_user` pattern as the Evidence Extractor; any section without supplied text gets an
  honest placeholder (`content_source: 'deterministic_digest'`), never fabricated prose. For
  `original_research`'s "results" section specifically, the placeholder embeds the REAL stored
  statistical output verbatim — never invented numbers.
- **Thesis Coordinator** (`agents/thesis-coordinator.ts`, task type `writing.draft_chapters`):
  the dissertation-mode counterpart, driven by `brief.chapterOutline` instead of a generic
  skeleton; reuses the exact same drafting rule.
- **Methods/Statistics Agent** (`agents/methods-statistics-agent.ts`, task type
  `methods.analysis`): fetches the EXISTING, already-verified research-run artifact
  (`src/research/service.ts#getRun`) — never recomputes, re-estimates, or invents a statistic; a
  hash-integrity failure or an incomplete run fails/pauses the task rather than fabricating output.
- **Citation Auditor** (`agents/citation-auditor.ts`, task type `citation.audit`): validates,
  SEPARATELY for every claim a section cites — identifier resolution (reusing the Source
  Verifier's own status), locator presence, and claim-support status. A section citing no claims
  is `unknown`, never `clean` by default.
- **Scientific Critic** (`agents/scientific-critic.ts`, task type `critique.review`): structural
  only (no model, no opinion on prose quality) — if the Citation Auditor found issues, it requests
  exactly one more writing round in the SAME bounded revision group the planner established
  (`writing-${mode}`, sized `maxRevisionRounds + 1`), replacing the downstream
  citation.audit→critique.review→export.manuscript tail so export never races ahead of the new
  round. At the cap, it proceeds with an explicit "bounded; proceeding despite unresolved issues"
  note — it never loops forever and never hides the remaining problem.
- **Editorial Agent** (`agents/editorial-agent.ts`, task type `editorial.author_voice_edit`, NOT
  part of the mandatory graph — created on demand per section): the AUTHOR supplies their own
  rewritten text (this agent never generates one); records it as a `proposed` new section version
  with deterministic preservation checks (dropped/added numeric tokens, large word-count deltas)
  that flag an "interpretation-altering change" for the author's own review; citation links carry
  forward unchanged to the proposal; accepting a proposal (`decideSection` via the API) queues a
  REAL new `citation.audit` task automatically — the same Citation Auditor re-runs, not a bespoke
  check. **Hard, enforced constraint**: any param resembling "detector", "humanize",
  "undetectable" or "0% AI" is refused outright, not just omitted by convention.
- **Journal/university guidelines + compliance report** (`guideline-service.ts`, task type
  `compliance.report`): append-only, versioned guideline records; a checklist item counts as
  satisfied ONLY when a human explicitly confirmed it (confirming creates a new version, never
  mutates history); the report compares real word counts against recorded limits and states,
  verbatim, that it is **NOT a journal acceptance and NOT a certification that any checklist item
  was actually verified correct**.
- **Append-only manuscript persistence** (`manuscript-service.ts`,
  `research_studio_{sections,section_comments,author_decisions,section_claims,citation_audits,
  guidelines,compliance_reports}`): every draft/revision/proposal is a new row under a stable
  `section_key`; "current" content is the latest accepted-or-accepted-proposal row — a rejected
  proposal never becomes current, and the full history is always reconstructable. Comments and
  section-claim links round out "persist outlines, sections, chapters, revisions, comments, claim
  links, author decisions" (plan §4). `model_provenance_json` exists on every row and is honestly
  `{model: null, ...}` everywhere, since no model produced any of this content.
- **`AgentContext.token` reused, not reinvented**, for budget enforcement in every new agent that
  does bounded work (the Citation Auditor, Methods agent, etc. all call `recordUsage` the same way
  M2's agents do).
- **Dashboard** (`ManuscriptWorkspace.tsx`): the current sections/chapters table with their
  content-source badge, an editorial-edit flow with the preservation report and accept/reject,
  and the guideline/compliance panel. `ResearchStudio.tsx` now remounts the Evidence/Manuscript
  workspaces after "Advance now" (a real staleness bug the browser verification caught — see
  Evaluation doc) so they never show pre-advance state.

## What M5 actually built (verifiable now)

- **Visual specifications** (`visual-service.ts`, `research_studio_visuals`): append-only,
  versioned per `visual_key`, exactly like manuscript sections. A FIXED, small renderer registry
  (`renderBarChart`, `renderTable`, `renderFlow`) is the only code that ever produces SVG — never
  `eval`'d or templated from arbitrary input.
  - `kind: 'data_derived'` visuals MUST name a real `research_runs` id and exact output field(s);
    `createVisual` fetches that run through the same hash-verified artifact service M4's
    Methods/Statistics Agent uses (`src/research/service.ts#getRun`), refuses a run that hasn't
    completed or whose output hash doesn't verify, and refuses a named field that isn't actually
    present/numeric in that real output. No number in a data-derived visual is ever hand-typed.
  - `kind: 'conceptual'` visuals (flowchart/evidence_map/conceptual_diagram/graphical_abstract)
    carry layout/labels only — `createVisual` scans the spec and REFUSES any field whose name
    looks like a measured quantity (`count`/`value`/`n`/`total`/`percent`/…), whether or not the
    caller intended it as real data.
  - `type: 'prisma_flow'` is a third case, neither free-typed data nor free-typed concept:
    `buildPrismaFlow` computes its counts ITSELF from real `research_studio_search_runs.result_count`
    and the latest `research_studio_screening_decisions` per source — `createVisual` refuses a
    `prisma_flow` spec entirely (`'use_builder'`), so there is no path to a hand-typed PRISMA count.
  - Visuals are invalidated by producing task, same convention as sections/excerpts
    (`invalidateVisualsForTasks`).
- **Export service** (`export-service.ts`, `research_studio_exports`): Markdown, BibTeX and RIS
  are serialised directly from already-persisted rows (no dependency needed). LaTeX is emitted as
  valid, inspectable `.tex` SOURCE — explicitly stated as NOT compiled (no LaTeX engine is
  installed). PDF is a real, rendered multi-page document via the already-used `pdf-lib`
  dependency, with a genuine page count that grows with real content length (not a fixed number).
  **DOCX is real and rendered** via `docx` (dolanmiu/docx 9.15.4, MIT, pure JS, added as a new
  direct dependency specifically for this — see "DOCX export" below) — never a renamed
  HTML/Markdown file. A hash-chained provenance manifest (`buildProvenanceManifest`, reusing the
  same `canonical()`/`sha256Hex()` pattern as every other evidence table in this feature) lists
  every section's content hash, every source's verification status, and every visual's data
  provenance; its own `manifestSha256` changes if any input changes.
- **Export Agent** (`agents/export-agent.ts`, task type `export.manuscript` — registered for the
  first time since M1 left it permanently queued): assembles all seven real artifacts from
  already-current content, runs `inspectExport` on the REAL generated bytes (actual PDF page
  count, actual DOCX ZIP/OOXML structure check, actual citation-text presence, actual SVG
  well-formedness) and refuses to publish a DOCX that failed its own structural check. Every
  export explicitly states: "This export reflects the CURRENT review state of this project. It is
  NOT a journal acceptance, NOT a completed peer review, and NOT a clinical or academic approval
  of any kind."
- **Visual Agent** (`agents/visual-agent.ts`, task type `visuals.build`, NOT part of the mandatory
  graph — created on demand): builds the PRISMA flow and/or any explicitly-requested
  data-derived/conceptual visuals; asks the user rather than fabricating one if nothing was
  requested.
- **Dashboard** (`VisualsAndExport.tsx`): a visuals gallery rendering the REAL SVGs inline, a
  "Build PRISMA-style flow" action, and an export panel listing every real file with its actual
  size/hash and a working download link to the exact bytes.

### DOCX export (M5 gap closed)

M5 originally shipped without DOCX ("no docx-generation dependency exists in this repository").
On this pass, `docx` (dolanmiu/docx) was evaluated — MIT licence, pure JavaScript (no native
bindings, no network calls, nothing that needs compiling), actively maintained, and `npm ls docx`
after installing confirms it introduces no transitive vulnerabilities of its own — and added as an
exact-pinned dependency (`package.json`: `"docx": "9.15.4"`). `buildDocx` constructs a real Open
XML package through the library's `Document`/`Paragraph`/`TextRun` model (never string-templated,
never a renamed Markdown/HTML file); `inspectDocxStructure` verifies the result is a genuine
ZIP/OOXML container (the `PK` local-file signature AND a literal `word/document.xml` entry name)
before the export agent will publish it. The UI and API never advertised DOCX as available while
it was missing, and now correctly list it as one of the seven real formats.

## What is explicitly NOT implemented yet (do not infer completion)

- **No real provider adapter and no MCP transport** — the simulated provider is the only one that
  exists; real consumer-provider automation is disabled by construction, not just by a flag (no
  code path reaches a real website, and none falls back to a paid model API). See
  [RESEARCH-STUDIO-BROWSER-CONNECTOR.md](RESEARCH-STUDIO-BROWSER-CONNECTOR.md).
- No manual-login window launcher for a real provider (the state machine exists; the actual headed
  browser a human would use does not).
- No full-text retrieval from a connector (only local PDF/text import); `fulltext_status` is set
  only by an explicit, recorded action (an artifact stored, or a human declaration), never
  inferred from a Crossref license-link signal.
- **No compiled LaTeX/PDF-from-LaTeX** — the `.tex` export is valid, inspectable LaTeX *source*;
  no LaTeX engine is installed, so it is never compiled here. The separate PDF export is real and
  rendered (via `pdf-lib`), but from the manuscript's plain text, not from the LaTeX source.
- **No chart types beyond bar charts, simple tables, and box-and-arrow flow diagrams** — the
  renderer registry (`visual-service.ts`) is deliberately small and fixed; a line/scatter/pie
  chart renderer could be added to the same registry later without changing any caller.
- ~~M6 acceptance/hardening has not been run as one consolidated pass~~ **Done.** One consolidated
  end-to-end acceptance test (`acceptance-m6-pg.test.ts`) and 12 dedicated security/failure-mode
  tests (`security-m6-pg.test.ts`) now exist — see
  [RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md).

A queued task whose type has no registered agent will sit in `queued` forever; this is the
intended, honest behaviour, not a bug. As of M5, every task type the planner's own graph can
produce (for every project mode) has a real registered agent — see the M5 testing evidence below
for what that means in practice (a fresh project graph now reports "0 of N tasks have no agent").

## Testing evidence (this pass)

- `src/research-studio/research-planner.test.ts` — 12 pure unit tests (brief validation rules per
  mode; planner graph correctness; DAG dependency ordering; withheld results-drafting without
  data; unresolved-decision surfacing).
- `src/research-studio/task-store-pg.test.ts` — 10 tests against real PostgreSQL: hash-chain
  tamper detection and immutability triggers, atomic claim + dependency gating, idempotent vs.
  conflicting commit, stale-claim sweep → retry → terminal failure, pause/resume/cancel state
  guards, awaiting-user round-trip, budget enforcement (fails closed), revision-group cap,
  transitive downstream invalidation, child-task dependency resolution by type.
- `src/dashboard/server/routes/research-studio-pg.test.ts` — 7 tests against a real HTTP server
  and real PostgreSQL sessions: auth/role enforcement, end-to-end project creation through the
  real planner agent, owner-only 404 isolation, bounded `advance`, brief revision history, event
  chain verification via the API, task pause/resume/cancel via the API.
- `scripts/verify-research-studio-ui.ts` — real headless-Chromium run against a real local
  dashboard+API+PostgreSQL profile: **8/8 passed**, including project creation through the real
  Research Planner, the "N of M tasks have no agent" honesty line, pause/resume/cancel via actual
  UI clicks, event-chain verification, and cross-operator project-list isolation. This run caught
  a real latent bug (tasks created in the same batch could reorder between page loads because
  `ORDER BY created_at` had no tiebreaker for same-millisecond rows) — fixed with a `BIGSERIAL
  ordinal` column; see [RESEARCH-STUDIO-EVALUATION.md](RESEARCH-STUDIO-EVALUATION.md) for detail.
- Full project regression after the M1 schema change: **1284 passed, 52 skipped, 0 failed**,
  including all 29 Research Studio tests above.

### M2 testing evidence (this pass)

- `citation-service.test.ts` (12), `import-service.test.ts` (11), `connectors/crossref.test.ts`
  (7) — pure/no-network unit tests: identifier normalisation, exact-vs-proposed duplicate rules,
  RIS/BibTeX parsing (including malformed/unbalanced input), Crossref response parsing with a
  fake injected fetcher (retraction notices, a fabricated/unresolvable DOI, partial-vs-completed
  search pagination).
- `evidence-service-pg.test.ts` (8, real PostgreSQL) — strategy versioning, exact/proposed dedup
  end to end, source-link human decisions, locator-required excerpts, screening history vs.
  "current" view, claim-link support status, and the critical case: **revising a source
  (retraction) invalidates its excerpts and cascades to the real downstream TASK via M1's
  `invalidateDownstream`** (the downstream task stays `completed` but is flagged `invalidated_at`
  — never deleted; a non-material revision invalidates nothing).
- `agents-m2-pg.test.ts` (9, real PostgreSQL, fake Crossref fetcher) — all four agents running
  through the real orchestrator: strategy derivation, the live-connector opt-in gate (asks the
  user rather than silently falling back), real source creation bounded by the task's own action
  budget (including a budget-of-0 failing the task closed), a fabricated DOI → `mismatch`, a
  genuine mismatch → `mismatch`, a true match → `verified`, a retraction → recorded
  `correction_status`, the no-DOI/no-live-connector honesty path, the `awaiting_user` →
  human-supplied-excerpts → `completed` round trip, and deterministic matrix building.
- `research-studio-m2-pg.test.ts` (5, real HTTP + PostgreSQL) — RIS import with a reported parse
  failure and an untrusted title stored as inert data (never interpreted as an instruction),
  manual-source exact-duplicate detection via the API, artifact upload, the full
  screening→excerpt→claim→link→matrix round trip through a real task run, and owner-only 404 on
  every new route.
- `scripts/verify-research-studio-ui.ts` extended with M2 checks: **12/12 passed** (real headless
  Chromium) — RIS import with a reported parse failure, exact-duplicate flagging, a human-supplied
  excerpt, and a claim linked to it rendering its own support badge. (This run also caught an
  ambiguous test selector, fixed in the script itself — not a product bug.)
- Full project regression after the M2 schema change: **1336 passed, 52 skipped, 0 failed**
  (101→107 passing test files). `npx tsc --noEmit` clean; `npx eslint src` **0 errors**; `npm
  --prefix dashboard run build` succeeds (new `ResearchStudio` chunk grew from ~9kB to ~20kB with
  the Evidence Workspace).

### M3 testing evidence (this pass)

- `simulated-provider-adapter.test.ts` (8, real headless Chromium, fully offline) — prompt
  submission + completion, partial reply + continuation, duplicate-submission-while-in-flight
  uncertainty, quota-exceeded, session-expired, UI-drift (provider removing its known controls),
  cancellation, and reconnect/resume via the fixture's own `localStorage`-backed state.
- `profile-service-pg.test.ts` (7, real PostgreSQL) — mode-0700 directory creation with no
  credential anywhere in the row, the connect lifecycle requiring explicit human confirmation at
  each step, exclusive session-lock acquisition, stale-lock sweep, reversible disconnect vs.
  permanent revoke, owner isolation.
- `browser-session-agent-pg.test.ts` (5, real PostgreSQL + real headless Chromium) — a full
  prompt→reply cycle through the REAL orchestrator with the lock correctly released afterward; a
  quota-exceeded condition becoming `awaiting_user` (never a silent paid-model fallback); a
  too-small budget failing the task closed; two tasks correctly refused concurrent access to one
  profile; and **restart recovery** — a task whose claim goes stale (simulating a process crash)
  is recovered by M1's own, unmodified `sweepStale`.
- `research-studio-m3-pg.test.ts` (3, real HTTP + PostgreSQL) — the full connect→confirm→
  disconnect lifecycle through the API with no credential-shaped text in any response, permanent
  revoke, and owner-only 404 isolation.
- `scripts/verify-research-studio-ui.ts` extended with M3 checks: **14/14 passed** — the connector
  panel's own honesty notice, and a full create→connect→confirm→disconnect round trip through
  real UI clicks.
- Full project regression after the M3 schema change: **1359 passed, 52 skipped, 0 failed**
  (107→111 passing test files; a handful of unrelated, pre-existing Postgres connection-teardown
  warnings appear under full parallel load — confirmed to run clean in isolation, not caused by
  this work). `npx tsc --noEmit` clean; `npx eslint src` 0 errors; `npm --prefix dashboard run
  build` succeeds (`ResearchStudio` chunk now ~24kB with the Connector Status panel).

### M4 testing evidence (this pass)

- `guideline-service.test.ts` (6, pure) — the compliance report's explicit non-acceptance notice,
  real word counts against recorded limits (including "no limit recorded → null, never assumed
  true"), and "a checklist item is satisfied only when explicitly confirmed."
- `manuscript-service-pg.test.ts` (5, real PostgreSQL) — append-only versioning, the exact
  "current content" rule (a proposal isn't current until accepted; a rejected one never becomes
  current even later), comments, section-claim links, and `invalidateSectionsForTasks` flagging
  only the sections it should.
- `agents-m4-pg.test.ts` (6, real PostgreSQL) — all six M4 agents through the REAL orchestrator:
  outline → human-vs-placeholder sections, Methods/Statistics reusing a REAL research-run artifact
  byte-for-byte (`outputSha256` matches), dissertation chapters via the Thesis Coordinator, the
  Citation Auditor's three separate checks (and "unknown, never clean by default" for an unaudited
  section), and — the significant one — **the full bounded revision loop**: a citation issue
  triggers exactly one more writing round in the correct revision group, through a real
  `critique.review` → new `writing.draft_sections` → new `citation.audit` → new `critique.review`
  cycle, terminating at the cap with an explicit "bounded; proceeding despite unresolved issues"
  result — never looping forever, never silently proceeding without saying so. Also: the Editorial
  Agent flagging a dropped number as interpretation-altering, never applying its own edit, and
  refusing a detector-evasion-shaped request.
- `research-studio-m4-pg.test.ts` (4, real HTTP + PostgreSQL) — sections/comments/claims round
  trip, the editorial propose→accept flow triggering a REAL re-audit task via the API (not just
  internally), guideline checklist versioning, and owner-only 404 isolation.
- `scripts/verify-research-studio-ui.ts` extended with M4 checks: **16/16 passed** — including a
  real UI staleness bug this run caught: `EvidenceWorkspace`/`ManuscriptWorkspace` did not refresh
  after "Advance now" ran tasks elsewhere on the page. Fixed by remounting both on a
  `refreshKey` bumped after every advance (`ResearchStudio.tsx`) — not worked around in the test.
- Full project regression after the M4 schema change: **1382 passed, 52 skipped, 0 failed**
  (111→115 passing test files). `npx tsc --noEmit` clean; `npx eslint src` 0 errors (322
  pre-existing-pattern warnings, none newly introduced as errors); `npm --prefix dashboard run
  build` succeeds (`ResearchStudio` chunk ~24kB → ~31kB with the Manuscript Workspace).

### M5 testing evidence (this pass, including the DOCX gap closure)

- `export-service.test.ts` (11, pure) — real BibTeX/RIS serialisation, Markdown assembly with a
  stale-section warning and correctly-labelled conceptual-vs-data-derived visuals, LaTeX
  escaping, a REAL rendered multi-page PDF whose page count grows with real content length (not a
  fixed number), a REAL rendered DOCX verified as a genuine ZIP/OOXML container (not a renamed
  text file, and a plain-text/incomplete-ZIP buffer correctly refused), a hash-chained
  provenance manifest whose hash changes with its inputs, and `inspectExport` catching a cited
  claim that doesn't actually appear in the export text.
- `visual-service-pg.test.ts` (6, real PostgreSQL) — a data-derived visual refusing to chart with
  no requested field, refusing a run that doesn't exist, a conceptual visual refusing a
  measured-looking numeric field then succeeding once removed, `prisma_flow` refusing to go
  through the generic path, `buildPrismaFlow` computing REAL counts (17 identified, 1 included, 1
  excluded) from real search-run/screening rows, and versioning + task-triggered invalidation.
- `agents-m5-pg.test.ts` (4, real PostgreSQL) — `visuals.build` producing a real PRISMA flow
  through the orchestrator (and asking the user rather than fabricating one with no request);
  `export.manuscript` producing all SEVEN real formats with a real inspection catching a missing
  citation, the stored PDF/DOCX files on disk verified as real `%PDF-`/`PK` binaries (not stubs),
  and the stored provenance manifest's hash matching the task result's hash; export failing
  cleanly with nothing to export.
- `research-studio-m5-pg.test.ts` (4, real HTTP + PostgreSQL) — visuals created via the API with
  the invented-numbers refusal surfacing as a real 400, a real PRISMA build from an actual search
  run, export triggered via the API with its download byte-identical to its own stored hash, and
  owner-only 404 isolation.
- `scripts/verify-research-studio-ui.ts` extended with M5 checks: **18/18 passed**, with
  screenshots visually inspected (not just the exit code) — `export-files.png` shows a real
  `docx` row with a genuine byte size and a distinct SHA-256 per export run, and
  `visuals-gallery.png` shows the real rendered PRISMA SVG with its real (zero) counts. This run
  also surfaced that by M5, every task type in a standard project graph has a real agent — the
  M1-era "at least one task has no agent" assumption no longer holds for a fresh project, so the
  check was rewritten to assert the stronger, now-true claim ("0 of N") and to target
  `export.manuscript` (genuinely still queued, since its dependency hasn't run yet) instead of a
  no-longer-existing gap, rather than weakening the assertion.
- Full project regression after the M5 schema change and the DOCX dependency addition: **1408
  passed, 52 skipped, 0 failed** (115→119 passing test files). `npx tsc --noEmit` clean; `npx
  eslint src` 0 errors; `npm --prefix dashboard run build` succeeds. `npm ls docx` confirms the
  new dependency introduces no transitive vulnerabilities of its own.

## What M6 actually built (verifiable now)

M6 is the integrated acceptance, hardening, and release-handoff pass — it builds nothing new
end-user-facing, but closes the gap between "every milestone tested in isolation" and "the whole
pipeline proven end to end in one run," and fixes two real defects that only surfaced once it was.

- `acceptance-m6-pg.test.ts` — ONE continuous rehearsal of the entire pipeline through the real
  HTTP API: brief → planner → search strategy → local RIS import (malformed record reported) →
  exact-duplicate detection → DOI verification (offline Crossref fixture) → screening → excerpt →
  claim/support link → evidence matrix → human-authored + deterministic-digest sections →
  citation audit → critique → editorial edit → real PRISMA flow → conceptual visual →
  data-derived visual from a verified run → export in all 7 formats with hash verification →
  cross-tenant isolation.
- `security-m6-pg.test.ts` — 12 focused tests: tampered-export detection (new `readVerifiedExport`,
  409 `integrity_failure`), export-format allow-list, malformed export-id handling, visual
  invalidation on a material source revision, SVG/script-injection escaping, prompt-injection-
  shaped import text staying inert, claim-with-no-evidence → `unknown`, concurrent claim
  atomicity, revision-cap enforcement, idempotent commit, cross-tenant 404s.
- **Real defect found and fixed:** `visual-service.ts`'s `data_derived` field lookup only ever
  checked `output`'s own top-level keys, but every real analysis (`src/research/analyses.ts`)
  nests its numbers inside `results` — so the M5-advertised "data-derived visual from a verified
  run" had never actually succeeded against any real analysis, only its refusal paths. Fixed with
  `resolveRunField`, which also accepts `"<column>.<metric>"` against the real `results` rows.
- **Real dashboard gap found and fixed:** reviewer comments (`addComment`/`listComments`) had a
  fully working backend since M4 and no UI. Added a real comments list + add-comment form to
  `ManuscriptWorkspace.tsx`. Also found `invalidateVisualsForTasks` (written and tested since M5)
  was never wired into any route — fixed at `PATCH /sources/:sourceId`, alongside the existing
  section-invalidation call.
- `scripts/verify-research-studio-ui.ts` extended with an M6 check (the new reviewer-comment
  round trip): **19/19 passed**.
- Full project regression after the M6 pass: **1421 passed, 52 skipped, 0 failed** (119→121
  passing test files). `npx tsc --noEmit` clean (backend and dashboard); `npx eslint src` 0
  errors; `npm --prefix dashboard run build` succeeds; doc-link check 0 broken.

Full detail, exact commands, and the exact boundary preventing a production-ready claim:
[RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md).

See [RESEARCH-STUDIO-ARCHITECTURE.md](RESEARCH-STUDIO-ARCHITECTURE.md) for the mechanism design and
[RESEARCH-STUDIO-LICENSE-INVENTORY.md](RESEARCH-STUDIO-LICENSE-INVENTORY.md) for the licence triage
of the external reference repositories consulted for ideas.
