# Validation tools and templates

Executable tools that turn **real annotated evidence** into reproducible reports. They were verified with **synthetic fixtures**
and independent numpy/scipy vectors; **no real validation result exists**. A report never says "validated", "passed" or "adequate for a
claim": it reports six things SEPARATELY (below) and leaves the decision to people.

```sh
npm run validate -- ocr    --annotations A.json --results R.json --out report.json
npm run validate -- pose   --reference REF.json --results R.json [--tolerances '{"static.shoulder_line_tilt":2}'] --out report.json
npm run validate -- device --log LOG.json --out report.json
npm run validate -- rule   --dossier D.json [--evaluator ./module.js] --out report.json
```
Exit codes: `0` report written · `2` bad input (reasons printed) · `3` rule dossier incomplete / boundary case failed.
Blank templates: `validation/templates/*.template.json` (they are rejected as inputs on purpose). Synthetic fixtures:
`validation/fixtures/`. Code: `src/validation/`. Tests: `src/validation/validation.test.ts` (44).

| Tool | Measures | Key safeguards |
|---|---|---|
| **ocr** (`ocr-eval.ts`) | analyte recall/precision; value, comparator, unit, reference low/high and **page attribution** accuracy with Wilson 95% CIs; extraction failures per page status; **silent errors** (wrong but unflagged) | an annotated document missing from the results is an input error; failed pages are reported as `extraction_failure`, not as misses, and stay in the all-items recall; extraneous candidates (invented values) reduce precision |
| **pose** (`pose-eval.ts`) | Bland–Altman bias + 95% limits of agreement with CIs, MAE/RMSE, proportional bias, whether the system's stated ± covers the error, tolerance rate; repeatability: within-subject SD, ICC(1,1), CV, MDC95 | unsupported/absent results stay in the denominator; unit mismatches/duplicates are input errors; `underpowered` and evidence assessment (independent reference, sample size, subjects) |
| **device** (`device-eval.ts`) | completeness, duplicates, gaps (and detection of known outages), delivery latency p50/p95/p99, out-of-order, backlog bursts, clock offset/drift, future-dated clock rate, and **how often a current value would have been shown** using the product's own freshness model | one recorded session of one device can never meet the structural minimums (a stated reason in every report) |
| **rule** (`rule-approval.ts`) | dossier completeness (named independent reviewer + credential reference + conflict statement, source, population, exclusions, version, thresholds, evaluation plan, change control), required boundary-case kinds, and **execution of the boundary cases** against the rule's evaluator | cannot approve: strongest output is `complete_awaiting_human_decision` or `signed_record_asserted_unverified`; placeholders (TBD, n/a, example) are rejected; a register-entry *draft* is emitted only when a signature block exists |

## The `evidence` block: six separate things, no verdict

| Field | What it says | What it does NOT say |
|---|---|---|
| `datasetAdequacy` | sample size and declared provenance versus minimums (`structuralMinimumsMet`, reasons, and whether the minimums were `caller_specified` or `tool_default_placeholder`) | anything about performance; that the data are representative; that the study is valid; a release decision |
| `annotationQuality` | annotator count, adjudication and reference independence **as declared in the input** (`self_declared_unverified`; `not_applicable_synthetic` for fixtures) | that annotators were qualified, independent or accurate — the tool cannot check |
| `uncertainty` | estimates carry intervals; which results are underpowered | that narrow intervals mean a good system |
| `protocolApproval` | a protocol reference, recorded as given (`reference_recorded_unverified`) or `not_recorded` | that the protocol exists, is sound or was approved |
| `measuredPerformance` | pointer: the numbers elsewhere in the report describe THIS dataset only | pass/fail |
| `clinicalAcceptance` | always `not_assessed_by_this_tool` | — responsible clinicians decide whether a measured performance is acceptable |

`structuralMinimumsMet: true` is therefore only "the file is big enough and declares the right things". It is **not** clinical
validation, safety evidence, regulatory evidence or an automatic release decision. The default minimums (OCR 300 truth items / 30
documents; pose 35 pairs per metric / 30 subjects; device 1000 observations, plus a standing "one session of one device" reason) are
**placeholders** so the tools can refuse tiny samples; the real numbers belong in the study protocol and should be passed explicitly
(`minTruthItems`, `minPairsPerMetric`, …), after which the report says `caller_specified`. Other parameters that change results and
must also come from the protocol: the OCR uncertainty-flag threshold (`lowConfidenceThreshold`, default 0.8) and pose tolerances.
Known measurement caveat: OCR *precision* counts unannotated candidates as wrong, so an incomplete annotation understates it.

## What a real use needs

1. A clinical/measurement lead who writes the protocol (population, reference standard, targets, minimums) **before** looking at results.
2. Real, authorised, de-identified material and independent annotation. 3. The tool's report attached to the protocol with every
failure's disposition. 4. For rules: the reviewer's own signed record, then `docs/clinical-release-register.json`.

## Posture and monitoring validation tooling (task 77)

Synthetic-only; see [POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md) and [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md). Code: `src/validation/pv/`; tests: `pv.test.ts`; rehearsal: `npm run pv:demo`. It wraps `validate pose` / `validate device` and adds locking, repeated-run capture and gate/taxonomy reports. No acceptance function exists.

## OCR study tooling (task 73)

**Implemented, synthetic-only, clinically unvalidated.** Supports the (unapproved) [OCR study preregistration draft](../validation/protocols/ocr-study-preregistration.md). No real data, annotator, adjudicator or approval exists; nothing here converts agreement or any measurement into acceptance.

| Piece | Where | What it does |
|---|---|---|
| Locked test-set manifest | `src/validation/study/manifest.ts` | opaque case IDs, source/annotation/truth hashes and provenance, annotation versions, adjudication head hash, lock state and a hash-chained lock history; `verify` re-hashes everything and can compare the lock digest with an anchor recorded **outside** the directory |
| Lock / unlock | same | writes outside `outputs/` are refused while locked and files are read-only; **unlock requires a human-written authorization record** (blank template `validation/templates/unlock-authorization.template.json`) bound to the current manifest hash and lock digest, single-use, from a person different from the requesting user; the tool cannot verify who that person is; there is no bypass flag or environment variable; unlocking is permanent in the manifest and audit log and later reports say the lock was reopened |
| Agreement and adjudication | `src/validation/study/agreement.ts` | percent agreement, Cohen's κ (categorical), numeric differences with **protocol-configured** tolerance (default exact), item-presence agreement, disagreement queue, append-only hash-chained adjudication records preserving both original annotations, ambiguous items excluded **and listed**, missingness report |
| Workflow service + CLI | `src/validation/study/workspace.ts`, `scripts/ocr-study.ts` (`npm run study:ocr -- <command>`) | register dataset → de-identification attestation → manifest → annotation import (append-only versions, annotators blind) → disagreement review → truth → lock → development/locked evaluation → report export; scope/workspace isolation (other scopes and non-members get "not found"), roles, hash-chained audit log |
| Evaluation report | `evaluate` | wraps `validate ocr` and adds silent-error list, error types (severity `unassigned` unless supplied), missing/invented fields, confidence calibration, annotation agreement, and full provenance; development runs are refused on locked/external splits |
| Tests | `src/validation/study/study.test.ts` (18; one added after the browser check found that siding with the annotator who did not record an item crashed the truth builder) | tampered manifests/files/log, unauthorized workspace access, lock bypass attempts, annotation revision history, disagreement preservation, report provenance, CLI smoke |
| Fixtures | `validation/fixtures/ocr-study/` | synthetic only |

Limits: the local CLI trusts the asserted user id (no authentication) and has no HTTP route or dashboard page; storage is files under a mandatory `--root` outside the repository; a person with write access to the whole study directory can rewrite the manifest **and** its hashes, which is why the lock digest must be recorded elsewhere; de-identification attestations are recorded, not verified.

## OCR study-policy layer (task 80)

One versioned policy record now supplies every OCR threshold, flag set, severity map, unit rule, tolerance and minimum; see [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md). `evaluateOcr(a, r, { policy })` and `parseLabLines(..., policy)` default to the labelled SYNTHETIC test policy; human-annotated evidence is refused. The CLI `--options` flag was removed; `ocr-study policy-stamp` prints the synthetic policy stamp that locked runs must carry.

## Authenticated OCR-study workspace layer (task 74)

**Implemented, synthetic-only, clinically unvalidated.** Every page and export carries: *"Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval."*. API contract: [openapi-ocr-study.json](openapi-ocr-study.json) (25 paths, generated by `npm run openapi:study`, validated, and checked against the implemented routes by a contract test). Routes: `src/dashboard/server/routes/ocr-study.ts` mounted at `/api/ocr-study`; page: `dashboard/src/pages/OcrStudy.tsx` (`/ocr-study`).

**Authority comes from the server, never the request body.** Identity = the verified dashboard session (JWT cookie/bearer, same mechanism as every dashboard route). Study role, tenant and lock state = PostgreSQL membership and the manifest. Bodies containing `userId`, `tenantId`, `role`, `lockState`, `actorId`, `accepted` (also inside `options`/`record`/`authorization`) are refused with `forbidden_field`. Dashboard accounts with the `viewer` role cannot use the layer; the dashboard `patient_access` grants are not used because study datasets are de-identified documents, not patient records. Workspaces use the dashboard tenant convention (`dashboard:<creator id>`: each dashboard user is their own tenant) and sharing is explicit membership; non-members and other tenants get the same "not found".

| Study role (one per user per study) | May |
|---|---|
| Study owner | create the study, add members, view manifests/agreement summary/audit, authorize an unlock (never their own request) |
| Dataset custodian | register synthetic datasets, record the attestation, generate the manifest, build truth, lock, request and execute an unlock |
| Annotator | see only datasets assigned to them, download assigned sources, import **their own** annotation versions, read **their own** versions; nothing of the other annotator, the queue, the agreement or the manifest |
| Adjudicator | see the disagreement queue with annotators replaced by A/B, submit adjudications; cannot import or edit annotations, cannot be an annotator |
| Statistician | aggregate agreement/missingness (no item-level content), verify (with an external digest), run development/locked evaluations, export reports |
| Clinical lead | set descriptive severity labels, view summaries/manifest, authorize an unlock, export reports; **cannot accept a study** — no endpoint can (`POST …/acceptance` always answers 403 `acceptance_not_available`) |
| Read-only auditor | view manifests, audit and exports; no write action |

**Locked-set protections, server-side.** Development runs are refused on locked/external splits. Unlock is a three-step flow between two different authenticated users: the custodian requests (bound to the current manifest hash and lock digest); a study owner or clinical lead authorizes with a reason, protocol-deviation reference and their credential reference (identity from the session; hashed, single-use); the custodian executes. Refused: reuse (`authorization_already_used`), a changed manifest or lock digest (`authorization_mismatch`, authorization not consumed), tenant mismatch, requester == authorizer, anyone but the requester executing. Verifying or evaluating a locked dataset **requires an expected lock digest supplied from outside** (`expected_lock_digest_required`): *repository-local write access can rewrite the manifest and its hashes, so the system cannot prove its own custody; independent custody exists only if the digest was recorded elsewhere (e.g. the signed preregistration) and that recorded value is supplied.*

**Audit.** Each action writes an `audit_events` row (`target_type = ocr_study`) restricted by an allow-list to identifiers, hashes, counts and authorization metadata; free text (reasons) appears only as a SHA-256 and a length; refusals are logged too. The file-store audit chain is verified when the audit is viewed.

**Storage is pluggable and fails closed** (`src/validation/study/storage.ts`). Only `local_synthetic` is implemented: it needs `ANUCLAW_STUDY_STORAGE=local_synthetic` and an explicit absolute `ANUCLAW_STUDY_LOCAL_ROOT` (no default), is refused in production, and accepts only synthetic datasets. `object_store` is the production **contract** (`StudyObjectStore`: immutable put, get, list, retention lock) and requires `ANUCLAW_STUDY_OBJECT_STORE`, `…_CREDENTIAL_REF`, `…_ENCRYPTION_KEY_REF`, `…_RETENTION_DAYS`, `…_ACCESS_POLICY_REF`; **no implementation ships**, so even a complete configuration yields `not_implemented`; it never falls back to local files. Unconfigured/invalid storage gives 503 `study_storage_unavailable` for every study route and writes nothing. No cloud credentials, buckets or uploads exist in this repository. The file-store engine still does its own file I/O under the local root: porting it onto `StudyObjectStore` is part of the work before a real study.

| Evidence | Where |
|---|---|
| API + authorization tests (real PostgreSQL, real sessions): cross-tenant, non-member, annotator blinding, adjudicator immutability, manifest tampering, lock/unlock replay, authorization mismatch, audit-content exclusion, storage configuration failure, role matrix, forbidden body fields, OpenAPI contract | `src/validation/study/study-api-pg.test.ts` (14) |
| Browser check of the page (headless Chromium, isolated profile, seven roles in sequence, 15 checks; screenshots not committed) | `scripts/verify-study-ui.ts` → [verification-study-ui-latest.json](verification-study-ui-latest.json) |

Limits: no SSO/MFA beyond the dashboard's existing session; no email notifications; sources are limited to 1 MiB each (synthetic only); the dashboard has no multi-user organisation model, so "tenant" means the study creator's dashboard tenant plus explicit membership.

## Security-readiness controls for the OCR-study layer (task 75)

**Implemented, synthetic-only, clinically unvalidated; real-study and production status remain BLOCKED.** Analysis and abuse cases: [OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md) — **no risk there is marked resolved**; tests are listed as what they show, never as closure. API contract now 31 paths ([openapi-ocr-study.json](openapi-ocr-study.json)).

| Control | Behaviour |
|---|---|
| **Membership lifecycle** | study owners suspend / remove / reinstate members with a stated reason; access is revoked on the next request (membership is re-read each time) and mirrored into the file store; rows, annotations, adjudications and audit entries are **never deleted or rewritten**; a removed member cannot be re-added; the last active study owner cannot be suspended or removed; suspending/removing a **dataset custodian or clinical lead** needs a request, an approval by a different study owner or clinical lead (neither the requester nor the member concerned), and execution by the requester (single use; an approver who lost their role voids it); audit holds only the reason's SHA-256 and length. No permanent deletion of studies, datasets or records exists. |
| **Re-authentication hooks** | `ANUCLAW_STUDY_REAUTH` (`required` in production, `off` otherwise) and `ANUCLAW_STUDY_FRESH_SESSION_SEC` (120): unlock authorization/execution, member changes, severity configuration and report export need a fresh session or `reauthPassword` (verified against the stored hash, never logged). Password re-entry only — not MFA. Export is now `POST …/export` so the password is never in a URL. |
| **Origin / CSRF guard** | cross-site `Origin`, `Sec-Fetch-Site: cross-site` and non-JSON bodies refused; in production a cookie-authenticated mutation must carry a same-origin Origin (`ANUCLAW_STUDY_REQUIRE_ORIGIN`). |
| **Limits** | body 4 MB; sources 1 MiB each / 3 MB / 50; archive, compressed and executable content refused by magic bytes whatever the declared type; ≤5000 annotation items; ≤500 result documents / 20000 candidates; JSON depth ≤12; pagination ≤200 on queue, adjudications, cases, members and audit. |
| **Rate limits** | per user per minute, in-process: sensitive 20, expensive 10, upload 20, general 600 (`ANUCLAW_STUDY_RATE_*`); `429` with `Retry-After`; refusals audited. Not shared across instances. |
| **Headers** | `nosniff`, `no-store`, restrictive CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, same-origin resource/opener policies; no CORS is opened. |
| **Security audit events** | `security.reauth_required`, `security.reauth_failed`, `security.rate_limited`, `denied`: allow-listed tokens only (no names, emails, reasons, credentials or content). |
| **Object-store contract harness** | `StudyObjectStore` stays **unimplemented**. `src/validation/study/object-store-contract.ts` defines 10 cases (tenant isolation, encryption metadata, immutable versions, retention lock, deletion hold, signed-access expiry, checksum verification, atomic visibility, access revocation, audit events) that any future implementation must pass; `object-store-fake.ts` is an in-memory, test-only fake with 13 switchable defects proving each case detects its violation. **This is a contract harness, not production-storage evidence.** |

Tests: `study-security-pg.test.ts` (8, real PostgreSQL), `object-store-contract.test.ts` (15), `security-units.test.ts` (3).

