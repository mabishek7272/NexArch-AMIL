# ANUClaw dashboard navigation redesign — route map (NexArch 13-item nav)

**This is a design/migration document only. It does not authorize deleting, renaming, or rewriting any
existing route.** Every URL listed below remains live and functional exactly as it is today until a
compatibility redirect exists AND a regression test covers it. No navigation or routing code has been
changed as part of writing this document.

## Target primary navigation (13 items)

1. Overview
2. Research Studio
3. Evidence Library
4. Manuscripts
5. Dry Lab
6. Bioinformatics
7. Posture Analysis
8. Monitoring
9. Validation
10. Pipelines
11. AI Connections
12. Governance
13. Administration

## The six existing dashboard roles

Taken directly from `src/dashboard/server/auth.ts` (`DashUser.role`), not invented for this redesign:

| Role | Current meaning in the codebase |
|---|---|
| `admin` | Full access; the only role that should see all 13 nav items per the navigation rule below |
| `operator` | General working role — research, pipelines, connections |
| `clinician` | Clinical/validation workflows (Patients, Clinical, CDS) |
| `compliance` | Review/approval workflows (validation status, release records) |
| `auditor` | Read access to audit/governance records |
| `viewer` | Minimal/read-only access |

The redesign brief's "clinicians, researchers, reviewers and operators" maps onto these as:
clinician→`clinician`, researcher→`operator`, reviewer→`compliance`/`auditor`, operator→`operator`.

## Pre-auth routes excluded from navigation

`/login` and `/welcome` (onboarding/terms-acceptance gate, `TermsGuard` in `App.tsx`) are not part of the
13-item nav and are unaffected by this redesign — they render before the authenticated `Shell` exists.

## Complete route-mapping table

| Current route | Current component | New primary section | Proposed secondary tab | Role visibility | Migration risk |
|---|---|---|---|---|---|
| `/` | `Home.tsx` | Overview | Workspace | all | Low |
| `/conversations/*` | `Conversations.tsx` | *(no permanent top-level home)* | contextual panel inside Research Studio / Patients / Pipelines / AI Connections | all | **Medium** — requires building a contextual-panel component, not just a route move |
| `/patients` | `Patients.tsx` | Validation | Patients | clinician, compliance, admin | Medium |
| `/clinical` | `Clinical.tsx` | Validation | Clinical review | clinician, compliance, admin | Medium |
| `/ocr-study` | `OcrStudy.tsx` | Validation | OCR studies | clinician, compliance, admin | Medium |
| `/cds` | `CDS.tsx` | Validation | CDS | clinician, compliance, admin | Medium |
| `/pipelines` | `Pipelines.tsx` | Pipelines | Pipelines | operator, admin | Low |
| `/tasks` | `Tasks.tsx` | Pipelines | Scheduled tasks | operator, admin | Low |
| `/research` | `Research.tsx` | Research Studio | Analysis | operator, admin | Medium — `Research.tsx` and `ResearchStudio.tsx` are two separate components/data models merging under one nav item; confirm no API collision before merging |
| `/research-studio` | `ResearchStudio.tsx` | Research Studio | Task graph / Sources / Evidence matrix / Review *(already has this internal structure)* | operator, admin | Low |
| `/science` | `Science.tsx` (labelled "Public data") | Evidence Library | Public datasets | operator, admin | Low |
| `/aikosh` | `AikoshRegistry.tsx` | Evidence Library | AIKosh | operator, admin | Low |
| `/elab` | `ELab.tsx` | Dry Lab | E-LAB | operator, admin | Low |
| *(none — net new)* | *(none)* | Bioinformatics | Workspaces / Tools / Jobs / Artifacts | operator, admin | **High** — see scope decision below |
| *(none — net new)* | *(none)* | Posture Analysis | Sessions / Assessments / Metrics / Reports | clinician, operator, admin | **High** — see scope decision below |
| `/monitoring` | `Monitoring.tsx` | Monitoring | Devices / Streams / Freshness / Alerts / Reliability | operator, clinician, admin | Low |
| `/channels` | `Channels.tsx` | AI Connections | Channels | admin, operator | Medium — "providers" and "browser profiles" tabs don't exist as separate concepts in this component yet |
| `/audit` | `Audit.tsx` | Governance | Audit | admin, auditor, compliance | Low |
| `/skills` | `Skills.tsx` | Administration | Skills | admin | Low |
| `/hooks` | `Hooks.tsx` | Administration | Hooks | admin | Low |
| `/users` | `UsersMgmt.tsx` | Administration | Users | admin | Low |
| `/api-keys` | `ApiKeys.tsx` | Administration | API keys | admin | Low |
| `/settings` | `SettingsPage.tsx` | Administration | System settings | admin | Low |

Manuscripts (primary section 4) has no dedicated current route either — research-writing, thesis, sections
and exports currently live as tabs *inside* `/research-studio` (`ManuscriptWorkspace.tsx`,
`VisualsAndExport.tsx`). Whether Manuscripts becomes its own top-level section with those components moved
out, or stays a secondary tab under Research Studio, is an open decision not resolved by this document.

---

## Net-new section decisions

### BIOINFORMATICS

`/bioinformatics` is a new **aggregation workspace** over existing ANUClaw capabilities — explicitly **not**
a second execution engine. It must reuse the existing container runner, task execution, artifact ownership,
and research services rather than duplicating them.

**Backend inventory (what exists today, checked against the actual route files in
`src/dashboard/server/routes/`):**

| Capability the page needs | What exists now | Gap |
|---|---|---|
| Available container tools | `GET /api/elab/skills` — reads `SKILL.md` files from the skills directory, each with parsed capabilities/domain/input hint | None — directly reusable |
| Tool capability and validation status | Same endpoint also joins `tool_calls` (invocations, avg latency, success rate) | None for *usage-derived* status. No endpoint reports the per-tool pass/fail state from `CONTAINER-CONTRACT.md`'s own test suite — **missing** |
| Research jobs | `GET /api/pipelines/:id/runs`, `GET /api/research/runs/:id` | No single endpoint lists jobs *across* pipelines + research + elab together — **missing (needs a thin aggregation route, not new execution logic)** |
| Running/completed/failed executions | Partial, per-subsystem (pipelines has run status; research has run status) | No unified status feed — **missing** |
| Input/output artifacts | `GET /api/research/runs/:id/artifact.json` (hash-verified) | Research-only; no equivalent for pipeline-run or elab-run artifacts — **missing** |
| Reproducibility manifests | `src/research/service.ts#getRun` returns `output_sha256`/`input_sha256` already | Exists for research runs only — **partial** |
| Environment and tool versions | `RESEARCH_ENGINE_VERSION` constant (research); no equivalent surfaced for elab/container tools | **missing** |
| Logs with sensitive content redacted | `src/security/redact.ts` exists as a utility | **No endpoint exposes logs to the dashboard at all yet** — this is the largest gap |
| Links back to originating Research Studio projects | Research Studio's own `research_runs` reference is not currently joined to pipeline or elab runs | **missing** — would need a `project_id`/`research_studio_task_id` foreign reference added to pipeline/elab run records |

**Honest summary:** roughly half of this page (tool catalog, tool usage stats, research-run artifacts and
hashes) can be built today by reusing existing endpoints. The other half — a unified
jobs/executions/logs view and Research-Studio cross-linking — needs new, but thin, aggregation routes over
existing data; it does not require new execution or storage systems.

### POSTURE ANALYSIS

`/posture-analysis` is an **integration surface** for the separate PosturePulse application
(`src/integrations/posturepulse/`), not a re-implementation. **No full-page iframe** — confirmed problems:
authentication (separate session/cookie domain), CSP (clinician-web likely sets its own frame-ancestors),
accessibility (nested focus/landmark traps), navigation (back/forward breaks inside a frame), and
session-lifecycle (two independent logout/timeout clocks).

**Staged integration:**

- **Phase 1** (landing page inside ANUClaw, no new PosturePulse API surface required beyond what
  `src/integrations/posturepulse/` already calls):
  - Landing page with connection/health status
  - Consent-aware session list
  - Released-report summaries
  - Validation status
  - Safe deep links into clinician-web (plain `<a>` navigation, not an iframe)
  - Explicit, visible distinction between synthetic, validated, and unvalidated data on every row
- **Phase 2** (native views, requires versioned PosturePulse APIs — not yet confirmed to exist at that
  stability level, needs verification against the PosturePulse repo before scoping further):
  - Session details, assessment metrics, report provenance
  - Clinician sign-off status
  - Withdrawn/invalidated records
  - Tenant and consent enforcement

Clinician-web stays fully operational throughout. Its pose pipeline is never rebuilt or duplicated; it
remains the single source of truth for pose/assessment data.

---

## Implementation sequence (design/build order — no step authorizes skipping the one before it)

1. Introduce the new navigation shell without changing any route.
2. Add secondary-tab routing (nested routes under each of the 13 sections).
3. Move existing pages into the new information architecture (component moves/renames only — no behavior
   change).
4. Add compatibility redirects for old URLs **only after** migration tests exist for each redirect.
5. Build the Bioinformatics aggregation page (new thin routes over existing data, per the gap table above).
6. Build the Posture Analysis integration landing page (Phase 1 only).
7. Validate every role's navigation and direct-route authorization (see test matrix below).
8. Remove obsolete navigation entries **only after** the replacement is verified — "remove" means hiding
   the old nav *link*, never deleting the old *route*, until redirects are proven.

## Per-route test matrix (required before step 8 for every route above)

For every route in the table:
- Correct role visibility (the right roles see it, the wrong roles don't)
- Direct URL authorization (typing the URL directly enforces the same role check as the nav link)
- Browser back/forward behaves correctly across the new nested routing
- Refresh/deep-linking lands on the correct page and tab, not a blank/error state
- Active navigation state highlights the correct primary section *and* secondary tab
- Mobile/collapsed navigation renders and remains usable
- Legacy bookmark compatibility (an old direct URL, bookmarked before migration, still works post-redirect)

## Navigation behaviour rules carried into this document

- All 13 items are visible only to `admin`.
- Other roles see a role-filtered subset (per the Role visibility column above).
- Unavailable sections are hidden entirely, never shown disabled/greyed-out.
- Governance and Administration stay visually separated at the bottom of the nav.
- Secondary (tab) navigation expands only where a section actually has more than one tab.
- Direct URLs are preserved; redirects are added only after step 4's tests exist.


## AlphaFold DB update — 18 November 2026

Live structure workflow routes: `/nexarch/bioinformatics/structural-biology/alphafold`, `/nexarch/bioinformatics`, `/nexarch/evidence-library` (Add public structure), `/nexarch/dry-lab` (Select receptor structure). Studio “Attach structure artifact” carries `?project=`. These entries now route to the actual AlphaFold UI; unrelated preview features remain unavailable. See [AlphaFold UI](ALPHAFOLD-DB-INTEGRATION.md#nexarch-ui-and-molecular-viewer).
