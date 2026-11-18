# OCR clinical-protocol review packet (DRAFT — BLANK, CLINICIAN-COMPLETABLE)

**Status: draft packet. Nothing here is approved, validated, released or production-ready; no real data, example report, threshold, reference range or source is supplied.** The product owner is the self-attested clinical lead for drafting; no credential is verified and no role-holder is assigned. Product status: **synthetic-only, clinically unvalidated, production-blocked.**

Inputs read for this packet: [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md) (CL-01–CL-04, CL-09), [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md), [OCR study preregistration](../validation/protocols/ocr-study-preregistration.md), [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md), [OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md).

**How to use:** complete the sections in your own controlled record; this file is a worksheet, not the record of authority and nothing written here is read by the software. A decision reaches the product only through the configuration and registers listed in §12 after your signed record exists. Where a field asks for a number, range or category boundary, supply it **only with a source reference you have verified**; otherwise leave it blank.

**Policy record (task 80).** Every OCR study value that used to be an engineering default is now a field of ONE versioned OCR study-policy record ([OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md)). The former conflicting defaults (parser 0.85 vs evaluation 0.8, 300/30 sample minimums, exact-match tolerance, unit handling) were removed from the code. **The OCR confidence threshold is an unresolved clinical/statistical decision, not an engineering default:** it must be set jointly by the clinical lead and the independent statistician, with a source reference, in the real-study policy; until then the field is `unconfigured`. The only values present in the software are the labelled SYNTHETIC TEST policy's, which are never usable with real data. Sections below map to the policy fields.

---

## 1. Intended use and non-intended use

*Source in the repository:* CL-01; [preregistration §1–2](../validation/protocols/ocr-study-preregistration.md)

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Intended use statement (what a reviewer may do with extracted values and drafts) | | |
| Intended users and their supervision | | |
| Explicit non-intended uses (diagnosis, triage, autonomous release, …) — confirm or amend the draft list | | |
| Wording standard for UI/exports that must match this statement | | |
| Relationship to regulatory advice (reference, if any) | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 2. Population, settings and exclusions

*Source in the repository:* CL-02

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Target population (age band, conditions) — OCR extracts what is on a report; state whose reports are in scope | | |
| Settings (clinic / lab / supervised review) and who confirms values | | |
| Languages and scripts in scope | | |
| Exclusions (document types, patient groups, report conditions) and the source or policy for each | | |
| Behaviour for out-of-scope documents (refuse, flag, route to manual) | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 3. Source-report categories (sampling frame)

*Source in the repository:* preregistration §2; the future [evidence register](#13-blank-evidence-register-for-the-future-corpus)

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Report types in scope (e.g. by specialty/test family) | | |
| Laboratories / vendors / templates in scope | | |
| Native-text vs scanned vs phone-photograph proportions required | | |
| Layout classes (multi-page, multi-column, merged-cell tables, handwritten annotations) | | |
| Value classes that must be represented (comparators, mixed units, missing ranges, flagged/abnormal) | | |
| Minimum documents per stratum (set WITH the statistician, not here) | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 4. OCR error-severity definitions

*Source in the repository:* CL-03; preregistration §7; `SEVERITY_KEYS` in `src/dashboard/server/routes/ocr-study.ts`

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Severity labels (ordered) and their definitions | | |
| Mapping: value | | |
| Mapping: comparator (`<`, `>`) | | |
| Mapping: unit | | |
| Mapping: reference low / reference high | | |
| Mapping: page attribution | | |
| Mapping: missed item | | |
| Mapping: extraction failure (page) | | |
| Mapping: extraneous candidate | | |
| Any analyte-class-specific escalation of severity | | |
| Which severities are 'critical' (stop study) — see §8 | | |

Error types are fixed by the tooling; **severity is assigned only by you, before any result is seen.** Labels are descriptive and cannot accept a study.

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 5. Required human confirmation and low-confidence policy

*Source in the repository:* CL-04; `src/documents/lab-parser.ts` (flag rules, default 0.85); `src/validation/ocr-eval.ts` (`lowConfidenceThreshold`, default 0.8); [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md)

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Confirm that EVERY extracted value requires human confirmation before it can enter a snapshot (the product enforces this; state any exception — none is currently allowed) | | |
| Confidence value below which a candidate is flagged for extra scrutiny (single value for parser AND evaluation) | | |
| Additional automatic flags you require (missing unit, inequality value, comma-decimal ambiguity, missing reference interval, lab flag present, …) — keep / change / add | | |
| Who may confirm, correct or reject; when a second reader is required | | |
| Review burden accepted (flagged items per document) | | |
| Handling of pages with `ocr_unavailable` or failed extraction | | |
| Prohibited behaviours (e.g. auto-accepting unflagged values, bulk confirm) | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 6. Unit, value, range and page-attribution review requirements

*Source in the repository:* CL-04; preregistration §6; `normUnit` in `src/validation/ocr-eval.ts`

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Unit equivalence table (which spellings/symbols count as the same unit) with the convention relied on | | |
| Units that must NEVER be merged or auto-converted | | |
| Value rules (decimal separators, significant figures, comparators, rounding as printed) | | |
| Reference interval rules (printed range vs laboratory-specific; handling of missing/ambiguous ranges) | | |
| Page attribution requirements (what must be traceable to which page/region) | | |
| Annotation guide version and location | | |
| Reader qualification and training for annotators and adjudicator | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 7. Ground truth and independence (clinician requirements)

*Source in the repository:* preregistration §4; [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md)

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Qualification of the two independent annotators and of the adjudicator (adjudicator must not be an annotator) | | |
| Blinding requirements (annotators and adjudicator never see system output) | | |
| Handling of ambiguous/illegible items (excluded AND listed) | | |
| Inter-annotator agreement reporting required before adjudication | | |
| Whether tolerance on numeric agreement is allowed (default tooling setting is exact match) | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 8. Study acceptance and stopping criteria (placeholders — set BEFORE data are examined, with the independent statistician)

*Source in the repository:* CL-09; preregistration §8; [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §12–13

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Primary endpoint(s) | | |
| Per-field acceptance bounds and the comparator (if any) | | |
| Silent-error criterion (zero-tolerance observed AND upper confidence bound requirement) | | |
| Flagged-error capture requirement and review-burden limit | | |
| Per-stratum requirements (a failing pre-declared stratum blocks pooled acceptance) | | |
| Immediate-stop conditions (harm or credible near-miss; privacy breach; leaked test data; loss of consent validity) | | |
| Interim review rules and reviewer | | |
| Handling of repeated looks at the locked set | | |
| Resumption rule after a stop | | |

The tooling reports measurements and never decides acceptance (`clinicalAcceptance: not_assessed_by_this_tool`). The tool's built-in minimums (300 truth items / 30 documents) are placeholders.

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 9. Ethics, consent, de-identification and provider-processing evidence

*Source in the repository:* preregistration §9; [OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md) §6; D09, D10, D17

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Ethics / IRB reference and date | | |
| Data-use agreement or consent basis for the corpus (reference) | | |
| Consent scope covering research use of reports | | |
| De-identification method, tool/version, reviewer, residual-risk assessment (reference) | | |
| Free-text, image, metadata and file-name checks performed | | |
| Named de-identification attester (the software records the attestation; it cannot verify it) | | |
| Provider-processing: signed DPA reference for ANY provider that would touch documents (OCR engine, hosting); otherwise local-only processing statement | | |
| Retention period and destruction method; withdrawal handling | | |
| Production storage design reference (the synthetic adapter must not hold real data) | | |
| Incident / breach procedure and contacts | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 10. Independent statistician and independent reviewer

> A dashboard panel now supports preparing draft values (with source references) and recording a two-person review of a policy VERSION (external decision + signature references, recorded not verified). See [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) §7. The review is not the sign-off recorded in §10's table below, which refers to the protocol itself.

*Source in the repository:* preregistration §8, §11

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Statistician (role holder assigned by the organisation) and independence statement | | |
| Sample-size derivation (assumptions, expected performance, clustering by document, sensitivity analysis) | | |
| Interval method (clustering), multiplicity and subgroup plan, missing-data rule | | |
| Independent clinical reviewer (role holder), credential reference, conflict-of-interest statement | | |
| Review scope (protocol, severity map, unit table, acceptance criteria, results) | | |

| Role | Name | Credential / reference | Decision | Signature reference | Date |
|---|---|---|---|---|---|
| Independent statistician | | | | | |
| Independent reviewer | | | | | |
| Clinical lead | | | | | |
| Privacy / data-protection officer | | | | | |
| Protocol owner | | | | | |

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 11. Locked-set custodian and external lock-digest procedure

*Source in the repository:* preregistration §4–5; threat model AC-4, AC-5, AC-13; `scripts/ocr-study.ts lock/verify`

**To be completed by the clinical lead** (blank; nothing is pre-filled; any threshold or range requires a cited source):

| Item | Entry | Source reference (title, version, publisher) |
|---|---|---|
| Locked-set custodian (role holder) who holds the locked set and is independent of the developers | | |
| Where the lock digest is recorded OUTSIDE the study system (e.g. the signed preregistration) and who records it | | |
| Who verifies against the recorded digest, how often, and what happens on mismatch | | |
| Who may authorize an unlock, the required evidence (protocol-deviation reference), and independence from the requester | | |
| Procedure for counting and reporting every look at the locked set | | |
| Access list for the locked set and review cadence | | |

**Procedure (draft, to be confirmed):** (1) custodian locks; (2) the digest is written into the signed preregistration or another system the study team cannot edit; (3) every verification and locked evaluation supplies that recorded digest; (4) unlocking needs a human-written authorization record from a different person, is single-use and is permanent in the manifest and audit log. The software cannot prove its own custody.

**Clinical lead decision, rationale, date and signature reference:** _(blank)_

**Independent review (separate; blank):** reviewer role / conflict statement / findings / outcome / date / signature reference: _(blank)_

---

## 12. Decision-to-implementation traceability

| Clinical decision | Affected workflow | Code / configuration location | Test / evidence required | Rollback path |
|---|---|---|---|---|
| Intended use / population / exclusions (CL-01, CL-02) | all OCR UI and exports; consent text; study eligibility | Wording in dashboard pages (`dashboard/src/pages/Clinical.tsx`, `OcrStudy.tsx`), `docs/*` protocols; per-study `studyRef`/`protocolRef` in dataset registration (`src/validation/study/workspace.ts`) | review of every page and export wording against the signed statement; study eligibility checklist | revert wording/config to the prior statement version; suspend recruitment; re-assess studies run under the old statement |
| Source-report categories (strata) | corpus sampling and split assignment | evidence register (§13); split assignment in `src/validation/study/workspace.ts` / AIKosh `splits.ts` style group split | stratum counts per split; leakage report (`assertNoSplitLeakage`) | re-assign splits on a NEW locked set; keep the old set's report as history |
| OCR error-severity definitions (CL-03) | OCR study reports (error types, silent errors) | policy field `severityMap`; `PUT /api/ocr-study/studies/:id/severity-map` (clinical lead role) writes a new SYNTHETIC-chain policy version; the real-study chain is edited via `/policy` | signed severity map dated before first look; audit entry `ocr_study.severity_map_set`; report shows labels | set a new map (audit-logged); reports state the map hash in force at generation |
| Human confirmation policy (CL-04) | document → candidate → confirmation → snapshot | `decideCandidate`, `createSnapshot` in `src/documents/workflow.ts` (snapshot blocked while candidates are pending); dashboard Clinical page | `src/documents/workflow-e2e-pg.test.ts`; rehearsal `acceptance-rehearsal-latest.json`; change tests for any new exception | revert the workflow change; snapshots/reports created under it are superseded |
| Low-confidence threshold and automatic flags (CL-04) | candidate flags; reviewer burden; silent-error definition | policy fields `confidenceFlagThreshold` and `enabledReviewFlags` in `src/ocr-policy/policy.ts`, consumed by `parseLabLines` (`src/documents/lab-parser.ts`) and `evaluateOcr` (`src/validation/ocr-eval.ts`); edited via `PUT /api/ocr-study/studies/:id/policy` (real-study chain, unconfigured) | policy audit report shows the field, its source-reference presence and the version each run used; tests prove parser and evaluation move together | save a new draft policy version (immutable history); runs keep the exact version they used |
| Unit normalization table (CL-04) | unit-correct metric; any future auto-normalization | policy field `unitEquivalence`; `normUnit` in `src/validation/ocr-eval.ts` and the AIKosh benchmark both read it | table review by the clinical lead; unit-pair test cases (must-not-merge pairs); evaluation re-run | revert the table; results are tagged with the code version |
| Value / range / page-attribution review requirements | annotation guide; scoring rules | annotation guide (to be written); scoring in `evaluateOcr` (`src/validation/ocr-eval.ts`) | annotation-guide version recorded in the preregistration; agreement report (`agreement.ts`) | new guide version → new annotation versions; adjudications against old versions are stale, not deleted |
| Acceptance / stopping criteria (CL-09) | study decision outside the software | preregistration §8 and the validation-result summary template; **no code path accepts a study** | criteria document dated before first data look; independent statistician sign-off reference | amendment with rationale; invalidates affected results until re-tested |
| Ethics / consent / de-identification / DPA evidence | registration of any real dataset (currently refused) | `registerDataset` real-data refusal and `attestDeidentification` in `src/validation/study/workspace.ts`; `ANUCLAW_STUDY_STORAGE`; `ELAB_DEID_REQUIRED` | evidence references in §9; production storage passing the contract harness (`object-store-contract.ts`) and human review | stop recruitment; withdraw per consent; destroy per retention plan; disable study routes (unset `ANUCLAW_STUDY_STORAGE`) |
| Locked-set custody and external digest | verification and locked evaluation | `lock`, `verify`, `unlock` in `src/validation/study/manifest.ts`; routes `…/verify`, `…/evaluations` require `expectedLockDigest` | recorded digest outside the system; verification run record; unlock authorization records | new locked set with a new digest; the old set is retained as history |
| Independent statistician / reviewer requirements | study governance | preregistration §11 approvals; role matrix in `src/dashboard/server/ocr-study-access.ts` (statistician, auditor) | signed approvals (outside the software); membership records | reassign roles by amendment; membership suspension is audit-logged |

A decision takes effect in the product only when its row's evidence exists and the change is made through code review and the normal change-control record ([07-model-provider-change-control.template.md](../validation/templates/07-model-provider-change-control.template.md)). Nothing in this table is a decision.

---

## 13. Blank evidence register for the future corpus

**One row per case. Case ID only — no patient name, identifier, date of birth, report text, file name, or example content may be written here.** Rows are added only after the dataset has an approved protocol, ethics reference and a recorded de-identification attestation. This register is a template; **it contains no rows, no patient data and no evidence.** The case ID is the opaque `c-…` identifier generated at dataset registration.

| Case ID (opaque) | Provenance (agreement / consent reference) | De-identification attestation reference | Category (stratum from §3) | Annotation status (not started / annotator A / annotator B / both / adjudicated / excluded-ambiguous) | Split assignment (development / locked_validation / external_validation) | Assigned by (role) and date | Notes (no content) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |
| | | | | | | | |

**Register rules:** a case enters only with a de-identification attestation reference; split assignment is made by someone independent of the developers and never changed after the lock; excluded or ambiguous cases stay listed with the reason code (no silent exclusion); the register's hash is recorded with the lock digest.

---

## 14. Fields that must be complete before ANY real OCR corpus is accepted

**Clinical lead:** §1 intended/non-intended use · §2 population, settings, exclusions · §3 report categories and value classes · §4 every severity mapping · §5 confirmation policy, confidence value, automatic flags, second-reader rule · §6 unit equivalence table and must-not-merge units, value/range/page rules, annotation guide and reader qualification · §7 annotator/adjudicator qualifications and blinding · §8 stopping conditions and clinical acceptance rationale · §9 ethics, consent, de-identification and attester references · §11 custodian, external digest location, unlock authorizer rules — each with a source reference where a number or boundary is given.

**Independent statistician:** §8 primary endpoints, acceptance bounds, silent-error bound, per-stratum rules, interim/stopping rules, repeated-look handling · §10 sample-size derivation, interval method, multiplicity/subgroup plan, missing-data rule, independence statement · §3 minimum documents per stratum · §7 agreement reporting and tolerance policy.

**Independent reviewer:** §10 credential reference and conflict statement; review outcome for §4–§8.

All signature fields reference records kept outside this repository; none is completed here.

---

## 15. Values the clinical lead AND the independent statistician must jointly provide before a real policy can be reviewed

Each must be entered in the real-study policy with a **source reference** (recorded, not verified) and a decision reference (kept outside this repository). All are `unconfigured` today.

| Policy field | Decision owners | Notes |
|---|---|---|
| `confidenceFlagThreshold` | clinical lead + statistician | one value shared by parser and evaluation; unresolved clinical/statistical decision |
| `enabledReviewFlags` | clinical lead | which of the seven automatic flags are on |
| `severityMap` (9 error types) | clinical lead | fixed before any result is seen |
| `humanConfirmation` | clinical lead | only `every_candidate_confirmed` is supported (code cannot enforce less) |
| `secondReaderRule` | clinical lead + statistician | recorded; not enforced by code yet |
| `unitEquivalence` | clinical lead | equivalent groups; case/micro/whitespace rules |
| `annotationTolerance` | statistician + clinical lead | numeric agreement tolerance |
| `minTruthItems`, `minDocuments` | statistician | structural minimums from the sample-size derivation |
| `calibrationBins` | statistician | reporting configuration |
| `acceptanceCriteriaRef`, `stoppingRulesRef`, `independentReviewRequirementsRef` | clinical lead + statistician + independent reviewer | references to the signed documents; the software never evaluates acceptance |
| Policy-level references | clinical lead; independent reviewer | clinical-lead decision reference; independent-review reference |

Even when every field is configured the policy stays a draft: activation needs an externally recorded authorization, an independent-review reference and an approved-protocol gate that does not exist in this build.
