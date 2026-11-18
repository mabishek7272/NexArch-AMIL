# OCR study-policy configuration layer (task 80)

**Status: implemented; draft / synthetic-only / clinically unvalidated / production-blocked.** The software chooses no clinical threshold, acceptance criterion, severity category, source, approval, role-holder or signature. Review packet: [OCR-PROTOCOL-REVIEW-PACKET.md](OCR-PROTOCOL-REVIEW-PACKET.md) (§15 lists the values to be provided).

## 1. What was found and replaced
| Former hard-coded / default value | Where it lived | Now |
|---|---|---|
| OCR confidence flag threshold 0.85 (parser) **and** 0.8 (evaluation) — conflicting | `lab-parser.ts`, `ocr-eval.ts`, study option | policy field `confidenceFlagThreshold`: one value, consumed by both; **unresolved clinical/statistical decision** |
| automatic review flags (always on) | `lab-parser.ts` | `enabledReviewFlags` |
| severity labels (`unassigned`, per-workspace JSON) | study routes/workspace | `severityMap` |
| human confirmation (every candidate decided) | `workflow.ts` | `humanConfirmation` (declared; code enforces the only supported value) |
| second reader | none | `secondReaderRule` (recorded; **not enforced by code**) |
| unit normalization (lower-case, µ→u, a `u/i`→`u/l` rule in the AIKosh benchmark) | `ocr-eval.ts`, `aikosh/bench/loaders.ts` | `unitEquivalence` (the AIKosh benchmark now uses the same function; the `u/i`→`u/l` guess was removed) |
| annotation tolerance (exact match literal) | `agreement.ts` | `annotationTolerance` |
| 300 truth items / 30 documents, 10 calibration bins | `ocr-eval.ts`, `workspace.ts` | `minTruthItems`, `minDocuments`, `calibrationBins` |
| acceptance / stopping / independent-review placeholders | docs only | three reference fields (never evaluated by code) |

## 2. The record
`src/ocr-policy/policy.ts`: policy id, version, kind (`real_study` | `synthetic_test`), 13 fields each `unconfigured` or `configured` (value + **source reference** + setter + time), clinical-lead decision reference, independent-review reference, previous-version hash, content hash. A real-study field can be configured only with a valid value **and** a source-reference string; **presence of a reference is not verification or approval.** Effective state: a real policy is always "draft — not effective"; the synthetic test policy is "usable with synthetic data only".

## 3. Fail-closed behaviour
- **Real-study registration, real-data acceptance, real (human-annotated) evaluation:** refused (`policy_not_active`) with the list of unconfigured fields — even when every field is configured and both references are present.
- **Activation:** `POST …/policy/activate` is always refused (`activation_blocked`) and audited; it needs an externally recorded authorization reference, an independent-review reference and an approved-protocol gate that does not exist (`ACTIVATION_GATE_AVAILABLE = false`). The database has no `active` state.
- **Acceptance-style report:** no such report exists; the gate refuses the purpose for every policy.
- **Synthetic policy:** separate chain, labelled `SYNTHETIC TEST VALUE — not a clinical or statistical choice`, never usable with real data; synthetic data uses only the synthetic policy.
- **Drift:** locked datasets are evaluated under the policy version bound at lock time (verified against the immutable record); results must carry the policy stamp they were produced under, and a different version is refused (`policy_version_drift`); a locked run without a stamp is refused.

## 4. Persistence and authorization
Table `ocr_policies`: immutable versions (UPDATE/DELETE/TRUNCATE refused by triggers; state can only be `draft`), hash chain per policy id verified on every load (`policy_tampered`). Draft edits: study owner, clinical lead, statistician (reauthentication hook applies); view: also auditor and dataset custodian; everyone else refused; non-members see "not found". Routes (OpenAPI 39 operations (34 paths)): `GET|PUT /studies/:id/policy`, `POST …/policy/activate`, `GET …/policy/report`.

## 5. Comparison / audit report
`GET …/policy/report` lists every field with configuration status, source-reference presence (explicitly **not** verification), affected code paths, whether code enforces it, and the policy version/hash used by each run. It selects no threshold and recommends nothing.

## 6. Limits
Second-reader and acceptance/stopping/independent-review fields are references only. The document pipeline's parser uses the labelled synthetic policy until a real policy can be activated. No UI page was added for policy editing (API only). No real policy exists.

## 7. Dashboard panel and two-person review (task 81)

**Implemented; draft / synthetic-only / clinically unvalidated / production-blocked.** Panel: `dashboard/src/pages/OcrPolicyPanel.tsx`, rendered inside `/ocr-study` for any study member who can view the policy. It always shows **"DRAFT ONLY — REAL-STUDY ACTIVATION BLOCKED"**, the 13 fields with status/source-reference presence/affected code paths, the hash-chain integrity state, and the readiness report. No field is pre-filled. **No control on the page or in the API can activate, approve, accept or release anything** — a static test checks the OpenAPI contract contains no such path.

- **Who can edit:** study owner, clinical lead, statistician (draft values + source references; re-authentication applies).
- **Who can view only:** auditor, dataset custodian. Annotators and adjudicators see no policy panel.
- **Review workflow (`…/policy/reviews`):** a draft version is submitted, then a **different** study member with a review role (owner, clinical lead, statistician) records a review: `reviewed` (needs an **external decision reference** and an **external signature reference** — recorded, never verified) or `changes_requested`. Refused: self-review (by the submitter or by whoever saved that version), review of a **stale** version (the policy moved on since submission), **replay** of an already-decided review, and review when the policy's hash chain is tampered. Submissions and decisions are immutable (database triggers) and there is no `approved` state in the schema.
- **Readiness report (`…/policy/readiness`):** always `eligibleForActivation: false`; lists missing fields, missing source references, missing external decision/review references and the unavailable infrastructure gates (approved-protocol gate, external authorization record, production storage, SSO/MFA, penetration test, ethics/DPAs), each linked to the clinician worksheet, the OCR protocol packet or a governance decision. It recommends nothing.
- **secondReaderRule, mechanical only:** `all_values` requires the two assigned annotators to be distinct people and to have both completed every case (checked before `buildTruth`); `flagged_values` is explicitly **unsupported** (`second_reader_rule_unsupported`) because annotation records carry no per-candidate flag to route on; `none` changes nothing. The rule never judges annotation quality or auto-accepts anything, and setting it on the **synthetic** policy chain has no effect on real-data gates, which remain closed regardless.

Tests: `src/ocr-policy/policy.test.ts` (readiness, 13 total), `src/validation/study/study.test.ts` (secondReaderRule, 4 of 31), `study-security-pg.test.ts` (role matrix, review workflow, cross-tenant/tampered-chain, secondReaderRule — 4 of 35). Browser: `scripts/verify-study-ui.ts` (8 new checks, 22/22 passing).
