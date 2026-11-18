# Governance decision pack (FOR REVIEW — no decision below has been made)

**Audience:** founders, clinical leads, security, privacy and operations. **Default for every decision: NO-GO** for clinical use and for production deployment until the record at the end of each decision is completed by the accountable role.
Accountable roles are **roles only**: no person is assigned, because no source document in this repository names one. Related: [RELEASE-CANDIDATE-HANDOFF.md](RELEASE-CANDIDATE-HANDOFF.md), [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md),
[CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md), [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md), [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md), [PRODUCT-STATUS-BRIEF.md](PRODUCT-STATUS-BRIEF.md).

## 1. One-page product status (2026-11-17)

| | |
|---|---|
| **What works locally** | Document → real local OCR → human correction/confirmation → stored engine run → draft report → review by a provisioned clinician account → HTML/PDF export with content hashes ([rehearsal](evidence/acceptance-rehearsal-latest.json), 5/5). BaaS `/v1` API with tenant isolation (OpenAPI valid, 29 paths). Public-data connectors (AlphaFold DB, RCSB, NCBI Datasets, GEO) with provenance, immutable cache, workspaces, manifests. Hardened agent container; full image `anuclaw-agent:latest` whose tools were run on small fixtures (the `claude` CLI: startup only; PyMOL fails) ([manifest](evidence/repro-manifest.json), [container evidence](CONTAINER-CONTRACT.md)). |
| **Latest regression** | `tsc --noEmit` 0; PostgreSQL suite 89 files / 1128 passed / 52 skipped (opt-in); container suite + rehearsal 38 passed / 1 skipped; `eslint src` 0 errors. |
| **Synthetic-only** | All tested documents, tool inputs, tenants, patients and the "clinician" account (a **test fixture**, not a licensed person). Public records are used only for the science connectors; three real artifacts were replayed offline. No real patient, participant, device or provider-agreement data exists. |
| **Not validated** | Everything clinical: no released rules (`no_released_rules`), no approved modules or reference documents, no annotated OCR set, no posture agreement study, no real-device recordings, no usability study. No accuracy, safety or benefit claim is supported. |
| **Not production-ready** | No production deployment, secrets manager, backup/DR, provider-side spend cap, penetration test, data-processing agreements, regulatory assessment, support or training. Evidence level L5 reached nowhere. |
| **Not run / open** | Authenticated Claude-agent execution (never run; disabled); optional-tools image (not built); GEO GSE2 fresh live retrieval (pending); signed-export proposal (unapplied; does not fix upstream-wide isolation); PyMOL (installed but non-functional on Python 3.12). |

**Clinician decision materials (drafts; no decision made, no role-holder assigned):** [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md) · [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md) · [DASHBOARD-CLINICIAN-CHECKLIST.md](DASHBOARD-CLINICIAN-CHECKLIST.md) · [rule dossier draft template](../validation/templates/14-rule-dossier-draft.template.md). The product owner is treated as the *self-attested* clinical lead for drafting only; credentials are not verified and no approval is recorded.

## 2. How to read the register

Each decision lists: **Accountable role · Options (first = recommended) · Consequences · Evidence required before deciding · Dependencies · Rollback · Final approval record** (blank fields to be completed by the accountable role; nothing here is pre-filled).
A decision is *closed* only when its record is complete; until then the stated default applies.

## 3. Decision register

### D01 — Intended-use statement and target population
- **Accountable role:** Clinical lead (with Product owner). **Default:** no clinical use.
- **Options:** (a) Adopt the proposed decision-support-for-qualified-review statement in [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §1 after amendment; (b) narrow to research/education only; (c) defer.
- **Consequences:** (a) defines scope of every study and rule; wider than any module's population is not allowed. (b) avoids medical-device scope questions but removes clinical use. (c) blocks all downstream milestones.
- **Evidence required:** clinical lead's reasoning; list of settings, users, exclusions; non-intended-use list accepted.
- **Dependencies:** none (first decision); feeds D06, D08, D09, D12.
- **Rollback:** supersede with a new signed statement; studies run under the old statement are re-assessed.
- **Approval record:** statement version ____ · approver/role ____ · credential ref ____ · date ____ · signature (blank).

### D02 — Authenticated Claude-agent execution
- **Accountable role:** Engineering lead + Finance owner. **Default:** disabled.
- **Options:** (a) Keep disabled until D03 is closed, then run the single human-enabled test `L-c` with a capped key; (b) never enable (host text-only/other providers); (c) enable now.
- **Consequences:** (a) closes the one open boundary ("no evidence a Claude agent drives the container tools") at bounded cost. (b) agent tools unavailable. (c) **not recommended**: the in-app ledger is admission control, not a hard cap.
- **Evidence required:** provider-side key limit exists (D03); test key scoped; a person authorises the run and the maximum spend.
- **Dependencies:** D03.
- **Rollback:** revoke the key; keep `ANUCLAW_REAL_AGENT_CREDENTIAL_TEST` unset.
- **Approval record:** decision ____ · max spend ____ · key owner ____ · approver/role ____ · date ____ · signature (blank).

### D03 — Provider-side spend cap and quotas
- **Accountable role:** Finance owner + Engineering lead. **Default:** no paid calls.
- **Options:** (a) Per-environment, per-key provider budgets with alert thresholds; (b) a single shared key with an account-level limit; (c) none.
- **Consequences:** (a) bounded loss per tenant/environment, more keys to manage. (b) simpler, wider blast radius. (c) unacceptable (runaway-loop risk).
- **Evidence required:** screenshot/export of the provider limit configuration (no key values), alert recipients, tested alert.
- **Dependencies:** D12 (secrets handling).
- **Rollback:** lower the limit to zero or revoke the key.
- **Approval record:** limits ____ · alert owner ____ · approver/role ____ · date ____ · signature (blank).

### D04 — Production container-isolation model
- **Accountable role:** Security lead + Operations lead. **Default:** no production agent execution.
- **Options:** (a) dedicated worker host/VM with rootless or sandboxed runtime and no host Docker socket in the app; (b) managed sandbox service; (c) the current host-Docker design (development only).
- **Consequences:** (a)/(b) add infrastructure cost and a new threat-model review. (c) is not acceptable for production: the app would hold a privileged socket.
- **Evidence required:** threat model; isolation test results on the chosen runtime; resource quotas per tenant.
- **Dependencies:** D02, D08.
- **Rollback:** disable agent execution (the runner already falls back to labelled text-only).
- **Approval record:** model ____ · reviewer ____ · approver/role ____ · date ____ · signature (blank).

### D05 — PyMOL
- **Accountable role:** Engineering lead. **Default:** left as is (known failure).
- **Options:** (a) Remove from the core image; keep as a future optional tool; (b) add an `imp` compatibility shim; (c) build PyMOL from source in the optional image.
- **Consequences:** (a) removes a non-functional tool and a false capability claim; smallest change. (b) fragile. (c) heavy build, only if molecular graphics are required.
- **Evidence required:** whether any workflow needs PyMOL; after change, a test that either passes or the tool is listed absent.
- **Dependencies:** D07 if (c).
- **Rollback:** restore the previous image tag (image IDs are recorded in the manifest).
- **Approval record:** option ____ · approver/role ____ · date ____ · signature (blank).

### D06 — Signed export for PosturePulse (upstream)
- **Accountable role:** PosturePulse upstream owners: Security owner + Privacy officer + Clinical lead. **Default:** do not apply.
- **Options:** (a) Require upstream review, answer A1–A8 in [the review checklist](proposals/posturepulse-upstream-review-checklist.md), then apply; (b) replace HMAC with an asymmetric design first; (c) reject the proposal.
- **Consequences:** (a) closes one door (export needs an explicit per-session grant) but **does not establish upstream-wide isolation**; ~20 role-only routes stay open until D06b. (b) stronger attribution, new design work. (c) the live-verified import path remains as is.
- **Evidence required:** completed checklist A–D; upstream CI pass on upstream infrastructure; pen-test scope updated.
- **Dependencies:** D12 (secrets), D10 (privacy).
- **Rollback:** unset `EXPORT_SIGNING_SECRET` (route returns 503) or `git apply -R` and drop the grant table.
- **Sub-decision D06b:** apply a grant model to the other role-only routes, or accept the exposure in writing.
- **Approval record:** A1–A8 decisions ref ____ · approver/role ____ · date ____ · signature (blank).

### D07 — Optional-tools image
- **Accountable role:** Engineering lead. **Default:** not built.
- **Options:** (a) Build only when a named study needs a tool (episcanpy, pytdc, medspacy, pyscenic, squidpy, biotite, pyranges, deepchem, hail); (b) build now; (c) drop the optional list.
- **Consequences:** (a) no cost until needed; (b) hours of build and unresolved source-built dependencies; (c) tools unavailable.
- **Evidence required:** the requesting study/use case; per-tool reason in `container/python/optional.in`.
- **Dependencies:** none.
- **Rollback:** none needed (separate image).
- **Approval record:** tools ____ · approver/role ____ · date ____ · signature (blank).

### D08 — Authorise a clinical validation programme (and its funding)
- **Accountable role:** Founders/sponsor + Clinical lead. **Default:** no studies.
- **Options:** (a) Fund the staged programme in [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md) starting with OCR; (b) research-only use with no clinical claims; (c) pause.
- **Consequences:** (a) needs ethics approval, data, annotators, statistician and a budget before any claim is possible. (b) cheaper; no clinical use. (c) the product stays a demonstrator.
- **Evidence required:** budget, named protocol owner/clinical lead/statistician, data sources, timeline.
- **Dependencies:** D01, D09, D10, D11.
- **Rollback:** stop at a milestone exit point; results to date are retained as study records.
- **Approval record:** scope ____ · budget ____ · approver/role ____ · date ____ · signature (blank).

### D09 — Ethics/institutional approval route and study sites
- **Accountable role:** Protocol owner + Clinical lead. **Default:** no human-subject data collected.
- **Options:** (a) Institutional ethics review with a named site; (b) commercial IRB; (c) retrospective de-identified data only under a data-use agreement.
- **Consequences:** drives timeline, consent forms, allowed data flows and which studies are possible (posture/device need prospective consent).
- **Evidence required:** approval reference, consent forms from the [templates](../validation/templates/README.md), site agreement.
- **Dependencies:** D01, D10.
- **Rollback:** suspend recruitment; withdraw per the consent withdrawal procedure.
- **Approval record:** route ____ · reference ____ · approver/role ____ · date ____ · signature (blank).

### D10 — Privacy, data-processing agreements and provider data flows
- **Accountable role:** Privacy / data-protection officer + Legal. **Default:** synthetic or locally processed data only; `ELAB_DEID_REQUIRED` on.
- **Options:** (a) Sign DPAs with each provider before any identifiable data flows (purpose limitation, no training, retention, location, sub-processors, breach notice); (b) local-only processing (no external model/OCR provider for personal data); (c) no personal data.
- **Consequences:** (a) enables hosted providers, adds contract work. (b) reduces functionality/cost flexibility. (c) blocks clinical use.
- **Evidence required:** signed agreements, DPIA, retention schedule, residency decision.
- **Dependencies:** D01.
- **Rollback:** switch the provider setting (via the [change-control record](../validation/templates/07-model-provider-change-control.template.md)); request deletion per the DPA.
- **Approval record:** providers/agreements ref ____ · approver/role ____ · date ____ · signature (blank).

### D11 — Regulatory pathway
- **Accountable role:** Regulatory/quality lead + Legal counsel. **Default:** no medical-device claim; no marketing of clinical use.
- **Options:** (a) Formal qualification/classification assessment per target jurisdiction once D01 is signed; (b) position strictly as research/education tooling with documented limits; (c) defer.
- **Consequences:** (a) defines evidence and quality-system obligations (and may expand D08's scope). (b) limits what can be claimed or sold. (c) risk of misaligned claims.
- **Evidence required:** written assessment by qualified regulatory advisers.
- **Dependencies:** D01.
- **Rollback:** reposition claims/documentation; withdraw a feature from the clinical scope.
- **Approval record:** pathway ____ · assessment ref ____ · approver/role ____ · date ____ · signature (blank).

### D12 — Roles, secrets management and the development default
- **Accountable role:** Founders (roles), Security lead (secrets). **Default:** no production secrets exist.
- **Options:** (a) Name the accountable people for every role in the protocol and plan; adopt a secrets manager; remove the development default database password path from production builds; (b) partial (secrets only).
- **Consequences:** (a) makes gates signable. (b) approvals remain unassigned.
- **Evidence required:** named role list; secrets-manager choice and rotation schedule; confirmation that startup refuses defaults in production (already tested locally).
- **Dependencies:** none.
- **Rollback:** reassign roles by amendment; rotate secrets.
- **Approval record:** role list ref ____ · approver/role ____ · date ____ · signature (blank).

### D13 — Clinical rule sources and owners (per module)
- **Accountable role:** Clinical lead; a named clinical owner **per rule/module** plus an independent reviewer. **Default:** `CLINICAL_RULES` empty; every module `not_approved`.
- **Options:** (a) Onboard owners and sources for one narrow module first, following [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md); (b) no clinical rules (extraction/draft-report tool only); (c) several modules in parallel.
- **Consequences:** (a) keeps scope and review load manageable. (b) simplest and safest. (c) risk of under-reviewed content.
- **Evidence required:** guideline sources with licence confirmation, owner credentials, dossier, boundary cases.
- **Dependencies:** D01, D08.
- **Rollback:** the rule's pre-declared rollback trigger; register entry marks the version withdrawn.
- **Approval record:** module ____ · owner/reviewer ____ · register ref ____ · date ____ · signature (blank).

### D14 — GEO GSE2 fresh live retrieval
- **Accountable role:** Engineering lead (allowance owner). **Default:** pending; allowance (20 files / 100 MiB) not reset.
- **Options:** (a) Leave pending; (b) approve exactly one additional request recorded in `PENDING.json` and replay it; (c) raise the allowance.
- **Consequences:** (b) converts the one non-replayable GEO artifact into evidence at trivial cost (14,878 bytes expected). (c) unnecessary.
- **Evidence required:** written approval of the single request.
- **Dependencies:** none.
- **Rollback:** none needed.
- **Approval record:** decision ____ · approver/role ____ · date ____ · signature (blank).

### D15 — Clinical-use go/no-go
- **Accountable role:** Accountable executive + Clinical lead. **Default: NO-GO.**
- **Options:** (a) Stay no-go until PRODUCTION-READINESS-PLAN gates G0–G8 have signed evidence; (b) limited supervised pilot only after the relevant validation studies meet **pre-declared** criteria; (c) go (not available: no evidence exists).
- **Consequences:** (a) is the only option the current evidence supports.
- **Evidence required:** signed validation-result summaries, rule dossiers in the register, usability results, incident process tested.
- **Dependencies:** D01–D13.
- **Rollback:** pause pilot per stopping criteria; roll back content versions.
- **Approval record:** decision ____ · residual-risk statement ref ____ · approvers/roles ____ · date ____ · signatures (blank).

### D16 — Production deployment go/no-go
- **Accountable role:** Accountable executive + Operations lead + Security lead. **Default: NO-GO.**
- **Options:** (a) Stay no-go until gates G3–G5 and G8 are signed (security, infrastructure, spend controls, pilot readiness); (b) deploy a non-clinical research environment only after G3–G5; (c) go (not available).
- **Consequences:** (b) allows research use without clinical claims.
- **Evidence required:** pen-test with no open critical/high, backup restore and DR drills, observability and rollback rehearsal.
- **Dependencies:** D03, D04, D10, D12.
- **Rollback:** tested application/migration rollback; DNS/ingress disable.
- **Approval record:** decision ____ · approvers/roles ____ · date ____ · signatures (blank).

### D17 — Study storage and identity for real OCR studies
- **Accountable role:** Security lead + Privacy officer + Engineering lead. **Default:** real studies refused (synthetic-only local adapter; object-store contract not implemented).
- **Options:** (a) Fund an object-store adapter with customer-managed encryption, retention locks and per-role access policy, plus SSO/MFA for study users, before any real study; (b) run real studies only inside an existing governed research environment and use this tooling for synthetic dry runs; (c) none.
- **Consequences:** (a) enables hosted studies, new infrastructure and security review. (b) avoids building storage, changes the integration plan. (c) no real OCR study.
- **Evidence required:** storage design and threat model, encryption/retention evidence, access review, pen-test scope update.
- **Dependencies:** D04, D10, D12. Security analysis: [OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md); a production object-store implementation must pass the contract harness (`object-store-contract.ts`) **and** human review; passing the harness alone is not approval.
- **Rollback:** disable study routes (unset `ANUCLAW_STUDY_STORAGE`; they return 503) and export/destroy per the retention plan.
- **Approval record:** option ____ · approver/role ____ · date ____ · signature (blank).

### D18 — AIKosh data: provenance, licence and permitted uses
- **Accountable role:** Data steward + Privacy officer + Legal (clinical owner for any clinical-evidence use). **Default:** every AIKosh file "unknown — blocked from external processing".
- **Options:** (a) Obtain provenance, licence text and consent/de-identification evidence per file, then record and second-person-approve narrowly scoped uses (start with local-only RAG indexing of non-narrative reference data); (b) keep AIKosh strictly for local evaluation; (c) remove the data.
- **Consequences:** (a) enables local RAG and, only with a DPA and de-identification evidence, external use; narrative and identifier fields stay blocked unless released by name. (b) benchmarks keep working offline; no product use. (c) no benchmarks.
- **Evidence required:** see [AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md) §6; fine-tuning additionally needs the completed dataset card and readiness checklist — **passing it does not authorize fine-tuning or clinical use**.
- **Dependencies:** D10, D13.
- **Rollback:** revoke the approval (permanent; record a new one if needed); delete derived indexes/embeddings per the retention plan.
- **Approval record:** option ____ · files/hashes ____ · approver/role ____ · date ____ · signature (blank).

### D19 — Real posture video and real device monitoring studies
- **Accountable role:** Protocol owner + Clinical lead + Privacy officer (ethics/IRB for approval). **Default:** no real video, device or participant data; synthetic tooling only.
- **Options:** (a) Approve a staged programme: sign the posture preregistration and monitoring protocol, fund reference equipment, devices and sites, then run supervised pilots; (b) restrict to synthetic and bench-only testing; (c) defer.
- **Consequences:** (a) needs consent, ethics, demographic coverage, trained raters, reference measurement, storage with encryption/retention, DPAs and an independent statistician before any recording; (b) no accuracy claim is possible; (c) posture and monitoring stay demonstrators.
- **Evidence required:** [monitoring protocol §7](MONITORING-VALIDATION-PROTOCOL.md) list; signed preregistration approvals; frozen system manifest; pre-declared tolerances and freshness windows.
- **Dependencies:** D01, D08, D09, D10, D12, D17.
- **Rollback:** pause recruitment; withdraw participants per consent; destroy data per the retention plan.
- **Approval record:** option ____ · approver/role ____ · date ____ · signature (blank).

### D20 — OCR study-policy activation gate
- **Accountable role:** Protocol owner + Clinical lead + Independent statistician + Independent reviewer. **Default:** the real-study policy is a draft with every field unconfigured and cannot be activated.
- **Options:** (a) Complete the policy fields jointly (clinical lead + statistician) with source references, obtain independent review, and fund an approved-protocol gate before activation is ever enabled; (b) keep OCR strictly synthetic (no real-study policy); (c) defer.
- **Consequences:** (a) required before any real corpus, real-data acceptance or locked real evaluation; activation also needs engineering work (the gate does not exist); (b) tooling stays a demonstrator; (c) blocks the OCR study.
- **Evidence required:** [OCR-PROTOCOL-REVIEW-PACKET.md](OCR-PROTOCOL-REVIEW-PACKET.md) §15 values with source references; decision and independent-review references; the approved protocol; a recorded two-person review and a readiness report with zero open items (readiness alone still does not permit activation — see [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) §7).
- **Dependencies:** D01, D09, D10, D17; CL-03, CL-04, CL-09.
- **Rollback:** save a new draft version (immutable history); no activated state exists to roll back in this build.
- **Approval record:** option ____ · approver/role ____ · date ____ · signature (blank).

## 4. Summary of defaults

| Area | Default until a record is signed |
|---|---|
| Clinical use | **NO-GO** |
| Production deployment | **NO-GO** |
| Paid/authenticated agent execution | disabled |
| Identifiable data to any provider | not allowed |
| Signed-export application | not applied |
| Clinical content release | none (empty rule set) |
| Real OCR study policy | draft, all fields unconfigured, activation blocked |
| Real posture video / real device data | not collected; synthetic tooling only |
| AIKosh data in RAG / embeddings / prompts / fine-tuning / external processing | blocked for every file |
