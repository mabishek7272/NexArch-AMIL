# Acceptance matrix (plan.md §14–16)

Engineering status only. **Nothing here is clinical validation, regulatory clearance, or production readiness.**
Reproduce with [TESTING.md](TESTING.md). Last full run 2026-11-17 (after task 70): build OK; with disposable PostgreSQL 89 files / **1114 passed**, 36 skipped (6 live-model, 7 live-PosturePulse, 23 container tests — enabled only by environment); without PostgreSQL see TESTING.md; `eslint src` 0 errors / 300 warnings; dashboard build OK; OpenAPI valid under `openapi-spec-validator` 0.9.0 (29 paths, 10 for science); browser workflow **26/26** (real PaddleOCR, bounded live OpenRouter earlier, synthetic mock providers for the public-data page).

> **Update after task 72 (supersedes the run summary above where they differ; the line above is kept as history):** build OK (`tsc --noEmit` rc 0); PostgreSQL suite 89 files / **1128 passed**, 52 skipped (opt-in: live model, live PosturePulse, container, OCR, rehearsal); with the full image + real OCR service: container suite + rehearsal **38 passed, 1 skipped**; `eslint src` 0 errors / 303 warnings. Full-image tests and the final rehearsal are **superseding** earlier "thin image only" statements for F10.

## Status at a glance (task 72) — categories are kept separate on purpose

| Category | What belongs here |
|---|---|
| **Passing, real component, synthetic data (L2)** | Full container image: 7 core tools + gatk, vina, fastqc, bcftools, minimap2, snakemake, **nextflow (runs a one-process workflow)**; contract suite on the real image via an agent double; `runAgent` application path starting a hardened container and returning a tool-produced artifact; real PaddleOCR on a scanned page; the full document → report → review → export workflow ([rehearsal](evidence/acceptance-rehearsal-latest.json)); research dataset attachment with manifest integrity and isolation |
| **Passing, mock/double only (L1)** | Science connectors against the mock providers (search/describe/retrieve/parse/attach/export, GEO included, synthetic fixture); agent CLI **test double** for orchestration; PosturePulse client mocks |
| **Replayed (not fresh live)** | RCSB 4HHB, AlphaFold P69905, NCBI GCF_000819615.1 replayed offline from retained bytes, hash-verified, stored as `replay_of_live_artifact`. **GEO GSE2: the real bytes were never retained — it was fetched live once (hash + summary only) and CANNOT be replayed; a fresh request is pending in `live-artifacts/PENDING.json` (allowance 20/20 files, not reset).** |
| **Live-tested (bounded)** | AlphaFold, RCSB, NCBI Datasets, GEO (see ledger); real `claude` CLI startup; real CLI with a fake key against a local capture server |
| **Skipped / disabled by design** | Authenticated Claude-agent execution (`L-c`, spends money, needs explicit human authorization); live-model and live-PosturePulse tests (opt-in) |
| **Failing / known defect** | **PyMOL: installed but not functional** (Debian pymol 2.5.0 needs the `imp` module removed in Python 3.12). Pinned by a test; not fixed. Nextflow needs a writable cwd (fails in `/workspace`: `mktemp /workspace/nxf-tmp… denied`; fine in `/tmp` or a mounted group dir) |
| **Optional, not built** | `container/Dockerfile.optional` (episcanpy, pytdc, medspacy, pyscenic, squidpy, biotite, pyranges, deepchem, hail) — each with its reason in `container/python/optional.in`. Not required by any acceptance criterion |
| **Clinically unvalidated (all)** | No released clinical rules, no approved modules, no annotated OCR set, no pose agreement study, no device validation; the rehearsal's "clinician" is a **test fixture**, not an approval |

**Reproducibility:** [evidence/repro-manifest.json](evidence/repro-manifest.json) (image ID, arch, lock hashes, tool versions, fixture hashes). The GATK SHA-256 in it is a **local consistency check**, not publisher-authenticated integrity (GATK publishes no checksum).

**Next-milestone planning documents (drafts for human review; they change no status):** [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) · [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md) · [validation templates](../validation/templates/README.md) · [upstream signed-export review checklist](proposals/posturepulse-upstream-review-checklist.md). **Every capability remains clinically unvalidated and production-not-ready**; no study, approval, signature or result exists.

**Governance review package (drafts):** [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md) · [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md) · [PRODUCT-STATUS-BRIEF.md](PRODUCT-STATUS-BRIEF.md). They record decisions still required; they change no status.


## Evidence levels (a capability is placed at the highest level it has actually reached)

| Level | Name | Meaning | How it is shown here |
|---|---|---|---|
| **L1** | Implemented | Code exists with automated tests using fakes/mocks or a disposable PostgreSQL. Proves logic, constraints, failure handling. | **L1** |
| **L2** | Locally verified | Exercised against the REAL component on this host (real PostgreSQL/Docker/OCR/pose model/backend/provider) with **synthetic** data. Proves it runs and integrates. | **L2** |
| **L3** | Synthetic evaluation | Quantitative evaluation with the validation tools on **synthetic fixtures**. Proves the tools and the pipeline mechanics; says nothing about real-world performance. | **L3** |
| **L4** | Clinical / measurement validation | Real, authorised, annotated data; independent reference; pre-specified protocol; named reviewers. | **L4** (none reached) |
| **L5** | Production readiness | Deployment, support, monitoring, rollback, data-processing agreements, drills. | **L5** (none reached) |

Other tags: **GATED** = implemented but blocked from clinical/operational use pending approvals · **MOCK** = only against a stand-in ·
**UNAVAILABLE** = not implemented or cannot run here · **PROPOSED** = diff written for review, not applied.

## Phase 0 — baseline

| Capability | Level | Evidence / limit |
|---|---|---|
| Inventory/scan of the existing system | L1 | `docs/SCAN-2026-11-17.md`; README corrected to remove unsupported claims. |
| Reproducible build/test/lint/synthetic environment | L2 | `npm test` on disposable PostgreSQL 17; `npm run verify:local` self-contained loopback profile. |
| **Docker runtime available** | L2 | Daemon reachable 2026-11-17 (Docker 29.8.1, linux/arm64) — the privileged helper is installed; see Phase 1 for what was run on it. |

## Phase 1 — trustworthy foundation (F01–F11, F16–F17)

| ID | Capability | Level | Evidence / limit |
|---|---|---|---|
| F01 | Patient retrieval scoped in SQL before scoring | L1 | `rag.test.ts`, `reference-corpus` tests. |
| F02 | Secrets fail closed; server-side sessions; scrypt + rehash; no default admin | L1 + L2 | auth/session tests; loopback HTTP; browser workflow. |
| F03 | CDS clinical auth fails closed; explicit demo mode | L1 | `api/server.test.ts`, `cds-auth` tests. A real SMART/JWKS issuer is **MOCK**. |
| F04 | Pre-egress policy on every model path; de-identification by data class | L1 + L2 | transport tests; live synthetic calls to the four roles. The **host text-only fallback now uses the same guarded transport** (was a direct provider call outside hooks-after/spend ledger). No provider data-processing terms → **no real patient data may be sent**. |
| F05 | Reproducible local runtime | L2 | RUNBOOK + `verify:local`; OCR needs the pinned 3.x stack. |
| F06 | Native/scanned/mixed PDF extraction with source display | L2 | real `pdf-parse` + real PaddleOCR 3.7.0 on synthetic pages. Annotated OCR accuracy: **tool exists (L3 fixture only); no real annotated set → no accuracy claim**. |
| F07 | Scheduled tasks real execution | L1 (real PG) | `tasks-pg.test.ts`, `task-scheduler.test.ts`. |
| F08 | Pipeline graph execution, cycle/edge rejection | L1 | `pipelines/graph.test.ts`. |
| F09 | EHR route order/persistence | L1 (real PG) | `ehr-pg.test.ts`. Real EHR endpoint: **MOCK**. |
| F10 | **Container contract** | **L2: full image built; 33 container tests passed on it at task 72 (31 at task 71); 1 skipped = authenticated agent, disabled** | See [CONTAINER-CONTRACT.md](CONTAINER-CONTRACT.md). Full image `anuclaw-agent:latest` (`96ce5ee9afe3`, hash-locked Python 3.12 env, GATK trust-on-first-use sha256) ran: double-agent contract tests, 7 core tool tests and 8 additional-tool tests with deterministic fixtures, real-CLI startup, fake-key credential/context capture. Found and fixed by execution: empty `hail` placeholder (moved to optional, image no longer claims it), snakemake crash as host uid. **Not run:** authenticated Claude-agent execution (explicit authorization pending); nextflow/pymol beyond presence; optional image not built. **Update (task 72):** nextflow now has FUNCTIONAL evidence; PyMOL has a pinned FAILURE (see 'Status at a glance'); the application path (`runAgent`) is exercised with an agent double. |
| F11 | Hooks/policy through one path | L1 | runAgent and modelCall enforce hooks; the fallback bypass is closed (above). |
| F16 | Rate/concurrency/quota; spend limits | L1 (real PG) | shared-store limits; spend ledger = **admission control, not a hard cap on charges**. Fair *queueing* is **not implemented** (over-limit requests are rejected with 429). |
| F17 | Build/test/lint/dashboard build | L2 | see results line. |

## Phase 2 — medical-report workflow

| Capability | Level | Evidence / limit |
|---|---|---|
| Uncertainty flags, confirm/correct/reject, revisions, hashed snapshots, supersession | L1 + L2 | real-PG workflow tests; browser workflow. |
| SOAP + plain-language draft; HTML/PDF export from one snapshot | L1 + L2 | export tests; PDF parsed back in the browser run. |
| Clinician-only sign-off | L1 + L2 | licensed-clinician role; API cannot sign off. |
| `/v1` API + OpenAPI; two-tenant isolation | L1 + L2 | `baas-v1-pg.test.ts`; `verify:local`; OpenAPI valid under `openapi-spec-validator` 0.9.0. |
| OCR/extraction evaluation on annotated data | **L3 (tool + fixture)** | `npm run validate -- ocr` (value/unit/interval/page accuracy, silent errors, failures). **L4: no real annotated set exists.** |
| **OCR study tooling** (locked test-set manifests, lock/unlock with human authorization, annotation agreement + adjudication, workspace workflow + CLI, locked evaluation report) | **L1 — implemented, synthetic-only, clinically unvalidated** | `src/validation/study/` + `scripts/ocr-study.ts`; 18 tests (tampering, isolation, lock bypass, revision history, disagreement preservation, report provenance); fixtures `validation/fixtures/ocr-study/`; details in [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#ocr-study-tooling-task-73). Preregistration is a **draft with blank approvals** ([ocr-study-preregistration.md](../validation/protocols/ocr-study-preregistration.md)). No real data, annotators or approvals exist; no accuracy claim. The CLI trusts an asserted user id; the authenticated API and dashboard layer is the next row. |
| **Authenticated OCR-study workspace layer** (API `/api/ocr-study`, dashboard page, seven study roles, server-side lock protections, two-person unlock, audit allow-list, fail-closed storage) | **L1 + L2 (real PostgreSQL, real sessions, headless browser) — implemented, synthetic-only, clinically unvalidated** | API/authorization tests: `src/validation/study/study-api-pg.test.ts` (14); browser check 15/15: [verification-study-ui-latest.json](verification-study-ui-latest.json); contract: [openapi-ocr-study.json](openapi-ocr-study.json) (25 paths, valid); details in [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#authenticated-ocr-study-workspace-layer-task-74). Every page/export carries the notice "Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval.". **Not production-ready:** only a synthetic local storage adapter exists (no encryption at rest/retention/access control); the object-store contract has no implementation; real studies are refused by the API. No acceptance function exists for any role. |
| **OCR-study security readiness** (member suspension/removal with two-person control and last-owner protection, re-authentication hooks, origin/CSRF guard, request/archive/pagination limits, rate limits, security headers, structured security events, object-store contract harness) | **L1 + L2 (real PostgreSQL) — implemented, synthetic-only, clinically unvalidated; real-study and production status BLOCKED** | [OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md) (no risk marked resolved); `study-security-pg.test.ts` (8), `object-store-contract.test.ts` (15, contract harness with a test-only fake — **not storage evidence**), `security-units.test.ts` (3); details in [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#security-readiness-controls-for-the-ocr-study-layer-task-75). Not implemented: object-store adapter, SSO/MFA, independent penetration test, shared rate limiting, WORM audit. |
| **AIKosh data governance and local evaluation** (offline inventory of 20 files, immutable registry, two-person approval workflow, egress taint guard, six local benchmark adapters with split/contamination controls, dataset-card and fine-tuning-readiness templates) | **L1 + L2 (real PostgreSQL; offline container inventory) — implemented, local-only, clinically unvalidated** | [AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md); `src/aikosh/aikosh.test.ts` (22), `src/aikosh/aikosh-pg.test.ts` (5, incl. OpenAPI contract); [openapi-aikosh.json](openapi-aikosh.json) (6 operations, valid). **Every file: licence, consent, de-identification and external processing unknown — blocked.** No file approved; no embedding, RAG, prompt or fine-tuning use exists; no model, provider or network call was made. Benchmarks use trivial baselines and compute no clinical score. The dashboard page `/aikosh` is built but was not browser-verified. Parquet not read in TypeScript. |
| **Posture and monitoring validation tooling** (synthetic-only workspace with media refusal, manifests/locks with external digest, repeated-run capture with model/config/environment hashes, quality-gate and taxonomy reports; synthetic monitoring scenarios with source-vs-receipt freshness checks and a simulation-only alert workflow; upstream-report protection fixtures) | **L1 — implemented, synthetic-only, clinically unvalidated, production-blocked** | [POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md), [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md), [preregistration draft](../validation/protocols/posture-validation-preregistration.md) (blank approvals); `src/validation/pv/pv.test.ts` (19); rehearsal [pv-synthetic-run-latest.json](evidence/pv-synthetic-run-latest.json). **Drawn/mannequin/parametric response does not prove human accuracy**; no real person, video, device or approval exists; data-layer service with asserted user id (no route, UI or authentication); no alert is a clinical alert. |
| **Clinician decision workspace** (worksheet of nine clinical-lead decisions, clinician protocol review, draft-only rule dossier template with an unpopulated example, documentation-only dashboard checklist) | **documentation — no status change; all capabilities remain synthetic-only, clinically unvalidated, production-blocked** | [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md), [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md), [DASHBOARD-CLINICIAN-CHECKLIST.md](DASHBOARD-CLINICIAN-CHECKLIST.md), [14-rule-dossier-draft.template.md](../validation/templates/14-rule-dossier-draft.template.md). Blank decision/independent-review sections; no credential verified, no role-holder assigned, no approval or signature recorded, no threshold or source supplied; no dashboard control added. |
| **OCR study-policy configuration layer** (one versioned policy record replacing conflicting engineering defaults; draft persistence with immutable hash-chained versions; fail-closed real registration/acceptance/locked real evaluation; policy audit report; version drift checks) | **L1 + L2 (real PostgreSQL) — implemented; draft / synthetic-only / clinically unvalidated / production-blocked** | [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md); `src/ocr-policy/policy.test.ts` (12), policy tests in `study-security-pg.test.ts`; OpenAPI now 39 operations (34 paths). **Every real-study field is unconfigured; no value, threshold, source, approval or role-holder was chosen; activation is blocked unconditionally.** The OCR confidence threshold is documented as an unresolved clinical/statistical decision. Second-reader and acceptance/stopping fields are references only (not enforced by code). |
| **Draft OCR policy dashboard + two-person review + readiness report** (role-restricted editing/viewing, no activation surface anywhere; submit/review with external-reference-only decisions; refuses self-review, stale review, replay, tampered chain, cross-tenant; mechanical secondReaderRule enforcement; readiness report always ineligible) | **L1 + L2 (real PostgreSQL + headless browser) — implemented; draft / synthetic-only / clinically unvalidated / production-blocked** | [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) §7; 13 + 35 (4 new) + 31 (4 new) tests; browser 22/22; OpenAPI 43 operations (37 paths), confirmed to contain no activate/approve/accept/release path. No draft or review action makes real-data registration or real-study evaluation available; external references are recorded, never verified. |

## Phase 3 — clinical engines, evidence, review

| Capability | Level | Evidence / limit |
|---|---|---|
| Rules framework; printed-interval comparison | L1 | `rules*.test.ts`. |
| **Clinical rules** | **GATED** | 0 released. `docs/clinical-release-register.json` + CI test; dossier checker `npm run validate -- rule` (L3 fixture) can never approve. |
| **Seed oncology/neurology CDS modules (F13)** | **GATED (new)** | now return 409 `clinical_content_not_released` unless the register lists `cds.<domain>` at that version (non-production developer override labels output `seed_unvalidated`). `release.test.ts`, `elab.test.ts`. |
| Embedding retrieval over approved content | L1 + L2 | live embedding probe; corpus has **no approved real content** → `no_evidence`. |
| Decision 1 → Gemma review of a verified stored run | L1 + L2 | live synthetic run `completed`; outage → explicit `decision_*` status. Model output is fallible, not clinical certainty. |

## Phase 4 — posture, ergonomics, orthopedics

| Capability | Level | Evidence / limit |
|---|---|---|
| PosturePulse import: contract/binding/timestamp/hash checks; trusted-upstream fetch **and** HMAC-signed-bundle path (separate, labelled) | L1 | `upstream.test.ts` (stand-in now faithful to the real subject view), `posturepulse-pg.test.ts`. |
| **Real backend, seeded results** (consent → session → report → sign-off → import) | L2 | `posturepulse-live.test.ts`, separately labelled `seeded_metrics`; backend/report/hash path only. |
| **Real backend + real video pipeline on a SYNTHETIC mannequin clip** (upload → PyAV decode → MediaPipe pose model → quality gate → metrics → report → clinician release → ANUClaw import) | **L2** | `scripts/posturepulse-e2e/run.sh`; no metric seeded; report rows carry `mediapipe-pose-full/1.1.1` provenance. The shoulder-line row moved −0.7° → −13.8° when the drawn shoulders were tilted (responds to input). Evidence: `docs/evidence/posturepulse-synthetic-pipeline.json`. **A drawn mannequin is not a person: no accuracy statement of any kind.** |
| **Defect found and fixed:** a released report with a clinician-withdrawn row failed the hash check (subject view omits the row, digest covers it) | L2 | upstream path now fetches the full body (clinician route) and requires the subject view to equal it minus withdrawn rows; verified live with `EXCLUDE_ROW=1`. |
| Signed export from the real upstream | **PROPOSED — scratch-only tests** | `docs/proposals/posturepulse-signed-export.{md,diff}` (12 files, +435 lines, sha256 `da052876…3514`, one additive migration, `git apply --check` OK, **not applied**). Round 2 found the upstream has **no clinician↔session ownership model** (role-only checks), so round 1 let any clinician export any session; the proposal now requires server-verified per-session authorisation (explicit operator-created grant ONLY — round 3 removed the "signing clinician" exception because sign-off is a role-only upstream route any clinician could use on any session; no backfill → everything pre-existing fails closed). The same role-only exposure on ~20 other upstream routes is **recorded, not fixed**. Integrity is labelled: the exported view is digested separately; with withheld rows the sign-off digest is an **upstream signed claim**, not independently verified; HMAC = shared secret, no independent clinician attribution. Scratch tests: backend jest 50 suites/544 tests; live HTTP with 2 clinicians (7/7 twice; the signing clinician is refused until granted). ANUClaw patient authorisation is unchanged and tested (`posturepulse-routes-pg.test.ts`). |
| Pose accuracy/repeatability evaluation | **L3 (tool + synthetic fixture)** | `npm run validate -- pose`; formulas match independent numpy/scipy. **L4: needs a real annotated reference study.** |
| Clinical measurement claims | **GATED** | measurement-agreement study not done. |

## Phase 5 — laboratory specialties and medication evidence

| Capability | Level | Evidence / limit |
|---|---|---|
| Specialty registry (no "approved" state) | L1 | `registry.test.ts`. |
| Department rule content | **GATED / UNAVAILABLE** | none approved. |
| Standard chemistry descriptors | L1 + L2 | RDKit (isolated venv), differences vs built-in shown. |

## Phase 6 — physiological monitoring

| Capability | Level | Evidence / limit |
|---|---|---|
| Two-clock freshness, skew, out-of-order, backlog handling | L1 (real PG) + L2 (browser) | `model.test.ts`, `monitoring-pg.test.ts`, `verify:local`. |
| **Device reliability evaluation** (completeness, gaps, latency, clock offset/drift, current-value availability) | **L3 (tool + fixture)** | `npm run validate -- device`. **L4: needs recordings from real devices.** |
| Labelled simulator; simulation-only alerts | L1 | DB `CHECK`; GATED for real alerts. |
| FHIR adapter | **MOCK** | no gateway/device. |
| Real hardware adapter | **UNAVAILABLE** | external requirement. |

## Phase 7 — research, epidemiology, discovery, prediction

| Capability | Level | Evidence / limit |
|---|---|---|
| Statistics core, direct standardisation | L1 | scipy-verified vectors. |
| Governed datasets, registered analyses, reproducible re-runs | L1 + L2 | real-PG + browser. |
| Prediction/biomarker analyses | **GATED** | research-only acknowledgement. |
| Molecular docking | **UNAVAILABLE** | needs the full container image (not built). |

## Research Studio (autonomous manuscript/thesis authoring) — added 2026-11-18

| Capability | Level | Evidence / limit |
|---|---|---|
| Durable task-graph engine, evidence graph, manuscript/thesis authoring, visuals, exports (M1–M6) | **L1 + L2 (real PostgreSQL, real HTTP, real headless Chromium) — implemented, synthetic/offline-fixture only** | `src/research-studio/` (task-store, evidence-service, manuscript-service, visual-service, export-service + agents); 18 test files / 142 tests; one integrated M6 acceptance test exercises the full pipeline (brief → planner → import → dedup → screening → excerpts → claims → matrix → manuscript → citation audit → critique → PRISMA flow → visuals → export → cross-tenant isolation) in a single run. Full details, exact fresh results and the exact boundary preventing a production-ready claim: [RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md). |
| Browser/MCP research transport | **L1 + L2 (real headless Chromium) — SIMULATED provider only** | `browser/simulated-provider-adapter.ts` drives an offline `file://` fixture. No real Gemini/GLM/ChatGPT/Claude.ai account has ever been automated; no paid model-API call has ever been made by any Research Studio code path; a real connector fails closed absent explicit configuration/authorization. |
| Manuscript/visual/statistical content | **L1 — deterministic only, no model generation anywhere** | Every section is either human-authored (via the author's own text) or an honest `deterministic_digest` placeholder; every chart is either computed from real evidence-graph rows (PRISMA) or reads a real hash-verified `research_runs` artifact (data-derived) or carries layout/labels only with no measured-looking field accepted (conceptual). |
| Research-integrity hard rules (no invented citations/identifiers/quotations/locators/methods/data/results/statistics; claim support/identifier resolution/locator presence kept separate; "unknown" is never "verified"; editorial edits preserve meaning/quantities/citations; no detector-evasion or "0% AI" requests honoured) | **L1** | `security-m6-pg.test.ts`, `citation-service.test.ts`, `evidence-service-pg.test.ts`, `agents-m4-pg.test.ts` (editorial agent's `FORBIDDEN_PARAM_PATTERN`). |
| Manuscript export as journal acceptance, peer review, academic approval, or clinical validation | **NOT CLAIMED, NOT IMPLEMENTED** | Every export, compliance report, and the dashboard's own notice state explicitly that nothing here is a journal acceptance, completed review, or clinical/academic approval. Human confirmation is required before any external use. |

## Public scientific data (research-only) — added 2026-11-17

| Capability | Level | Evidence / limit |
|---|---|---|
| Connectors for AlphaFold DB, RCSB PDB, NCBI Datasets, GEO; immutable versioned cache; provenance (URL, version, SHA-256, licence, attribution, classification); structured parsers; scoped workspaces; manifest | **L1** | `src/sciencedata/` — 24 deterministic tests (parsers, Zip/Zip64 safety, classification, fetcher outage/429/oversize/redirect/timeouts) + 12 real-PostgreSQL service tests + 5 route tests (dashboard and `/v1`: authentication, roles, ownership, tenant isolation), all against a **synthetic mock** of the providers. |
| Dashboard "Public data" page and BaaS `/v1/science/*` (10 OpenAPI paths) | **L1 + L2** | browser workflow against the synthetic mock (26/26 `verify:local`); OpenAPI valid. |
| **Live retrieval from the real providers (bounded)** | **L2 — partial, with gaps** | `scripts/verify-science-live.ts`, evidence in `docs/evidence/science-live-*.json`; ledger **20/20 files, 735,970 bytes (0.70 MiB of 100 MiB), 34 requests** (the ledger includes 4 diagnostic GETs of one 14.9 KB file made while debugging, and HEAD/probe requests). See below. |
| Ingestion review (2026-11-17) | **L1** | hardened: symlink/duplicate/declared-total/Zip64-directory zip refusals, provider-confined redirects and file URLs, `refresh` + verified cache, `access_denied` (403 is never inferred to be controlled access), explicit provider-policy terms (`termsBasis`, record-specific terms "not established"). Each has a regression test; see SCIENCE-DATA.md. |
| **Replay of live-fetched artifacts (offline)** | **L1 + L2 (real bytes) / synthetic for GEO** | `replay()` + `scripts/replay-science-artifact.ts`: hash-verified, labelled `replay_of_live_artifact`, ledger untouched. Real AlphaFold PDB and NCBI Zip64 archive replayed end to end (store→parse→attach→manifest→isolation→tamper). GEO path exercised only with a **synthetic** matrix. **GSE2 real bytes were not retained → live request PENDING** (exact request in `docs/evidence/live-artifacts/PENDING.json`; needs the 20-file allowance raised by explicit decision). |
| Classification | L1 + L2 | AlphaFold = `predicted`; PDB 4HHB = `experimental` (a PDB entry whose record says "theoretical/computational" is `predicted`; tested on the mock; its B column is never treated as pLDDT); RefSeq = `curated_reference`; GFF3 annotation = `predicted`; GEO = `author_supplied`. |
| Anything built on this data (structure prediction, docking, biomarker discovery) | **UNAVAILABLE / GATED** | downloading is not running AlphaFold; docking needs the full container image; biomarker/prediction analyses stay research-only and gated. Nothing here enters the clinical evidence corpus (tested). |

**Live results (real services, public records):**
| Source | Result |
|---|---|
| AlphaFold DB `P69905` (human haemoglobin α) | OK — model version v6, PDB 92,096 B, sha256 `d9d7ad46…`, parsed: 1 chain, 142 residues, 1,077 atoms, mean pLDDT 98.06 (derived summary kept separately); classified `predicted`. |
| RCSB `4HHB` | OK — entry + PDB file 473,850 B (`abf382e0…`), `experimental` (X-ray), 4 chains/574 residues/4,779 atoms, B-factor not treated as confidence; full-text search "hemoglobin" returned ranked entries. |
| NCBI Datasets `GCF_000819615.1` (phiX174 RefSeq) | **First attempt FAILED live**: the real archive is **Zip64** and the reader rejected it. Fixed and regression-tested (Zip64 fixture), verified offline against the already-downloaded real archive, then re-run OK: zip (6,348 B) + FASTA (NC_001422.1, 5,386 bp, GC 44.76%, parsed) + GFF3 (6,571 B) stored as separate sources with parent links. |
| GEO search / describe | OK (E-utilities search; SOFT metadata, contact fields dropped). |
| GEO `GSE346184` series matrix | **HTTP 403 from the provider** (even for the series directory). The connector now reports `access_denied`, omits the file, and does **not** infer controlled access (the status alone does not establish why). |
| GEO `GSE2` series matrix | **Connector retrieval FAILED live** (stalled): cause found by experiment — axios' default `Accept` header makes `ftp.ncbi.nlm.nih.gov` stall on file GETs (curl was fine). Fixed (`Accept: */*`), regression-tested. The fixed fetcher then fetched the real matrix (14,878 B, `9fcf768c…`) and the parser summarised it (5 samples × 897 features, 0 missing; "Cerebellar development"). **Not verified live:** the full service retrieve → store → parse flow for GEO — the 20-file budget was exhausted by the diagnostics. |
| Not verified live (mock only) | AlphaFold mmCIF/PAE, RCSB mmCIF, NCBI taxon search, rate-limit and outage handling, oversize refusal, integrity tamper detection. |

Live checks establish connectivity and that the parsers read real files of these formats. They say nothing about the scientific validity of the content, and no controlled-access data was touched.

## What is NOT reached anywhere in this build

- **L4 (clinical/measurement validation):** no real annotated OCR set, no pose agreement study, no real-device recordings, no approved rule, module or reference document.
- **L5 (production readiness):** no deployment, no data-processing agreement with a model provider, no operations ownership, no drills, no provider-side spend limit.

## Human actions required (exact steps and acceptance criteria)

| # | Action | Acceptance criterion |
|---|---|---|
| 1 | Let the already-running full-image build finish (or rebuild: `docker build -t anuclaw-agent:latest container/`; hours on this network) | the command in CONTAINER-CONTRACT.md passes including the 7 tool smoke tests |
| 1b | To prove **authenticated agent execution** (optional, spends money): set `ANUCLAW_REAL_AGENT_API_KEY` in your shell environment and run with `ANUCLAW_REAL_AGENT_CREDENTIAL_TEST=1` | test `L-c` passes (agent answers `pong`); it still does not prove tool execution |
| 2 | Review `docs/proposals/posturepulse-signed-export.md` (especially Authorisation and the table of other exposed routes) and, if accepted, apply the diff in the PosturePulse repo, run `prisma migrate deploy`, and grant access per session with `scripts/grant-session.ts`; set `EXPORT_SIGNING_SECRET` (+ optional `EXPORT_SIGNING_KEY_ID`) there and the same key in `ANUCLAW_POSTUREPULSE_IMPORT_KEYS` here | `SIGNED_EXPORT=1 scripts/posturepulse-e2e/run.sh …` shows the signed-bundle live test passing |
| 3 | Provide real, authorised, de-identified material + a named annotator pair; fill `validation/templates/*` under a written protocol | `npm run validate` reports whose `evidence.datasetAdequacy` was computed with protocol-specified minimums (`thresholdsSource: caller_specified`) **and** a clinical lead's sign-off of the protocol, the annotation quality and the measured performance (the tool decides none of these) |
| 4 | Clinical approvals (named reviewer, source, population, exclusions, boundary cases) per rule/module | dossier status `signed_record_asserted_unverified` **plus** the reviewer's own signed record attached to the PR adding the register entry |
| 5 | Provider data-processing terms; a provider-side spend limit on the API key | written agreement on file; limit visible in the provider console |
| 6 | Real devices, real video of consenting people (ethics approval), study datasets | measured results attached to the relevant protocol |


## AlphaFold DB update — 18 November 2026

AlphaFold DB current API: all five official metadata operations; fixture transport failures and real PostgreSQL ownership/hash/invalidation routes; NexArch import/confidence/provenance/receptor workflow. Live metadata and fixture/browser evidence are separate. Governed PDBQT preparation remains unavailable, so receptor handoffs require preparation and never auto-run docking. Exact results: [integration and evidence](ALPHAFOLD-DB-INTEGRATION.md#verification-and-reproduction).
