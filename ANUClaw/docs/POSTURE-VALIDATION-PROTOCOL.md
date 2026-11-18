# Posture validation — protocol and synthetic tooling (task 77)

**Status: synthetic-only tooling, implemented; clinically unvalidated; production-blocked.** No real person, recording, device or approval is involved. Preregistration draft (blank approvals): [posture-validation-preregistration.md](../validation/protocols/posture-validation-preregistration.md). Parent: [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §7. Companion: [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md).

> **Mannequin, drawn-figure or parametric response does not prove human accuracy.** Passing anything described here shows that the tooling works as written. It is not evidence of accuracy, safety or benefit on people.

## 1. Intended / non-intended use and scope
Intended use and exclusions are proposed in the preregistration for the clinical lead to confirm or replace; until a signed statement exists no clinical use is permitted. This stage covers **synthetic, mannequin and reference-fixture material only**.

## 2. What was built (`src/validation/pv/`)
| Piece | Behaviour |
|---|---|
| **Synthetic fixtures** (`posture-fixtures.ts`) | seeded **drawn SVG stick figures** for neutral, tilted shoulders, trunk asymmetry, altered posture, and degraded cases: blur, occlusion, rotation, framing, lighting, multi-person, no person, uncalibrated scale. Each carries a `SYNTHETIC-DRAWN-FIXTURE` marker. No photograph or video exists. |
| **Parametric stand-in** | a deterministic *stand-in for a system under test* (NOT a pose model) with a quality gate that returns `unsupported` + a reason code, and injectable defects (emits a value for an unmeasurable case, biased, drops outputs, omits reason codes) used to prove the report notices them |
| **Workspace** (`workspace.ts`) | file-store, tenant/workspace isolation, roles (owner, reference annotator, runner, statistician, auditor), hash-chained audit. **Synthetic-only registration:** provenance must be `synthetic`; media must be a drawn SVG with the marker or a JSON scenario with `"synthetic": true`; JPEG/PNG/MP4/WebM/zip/gzip and embedded rasters are refused by magic bytes whatever the declared type |
| **Manifests and locking** | immutable source hashes and provenance; append-only reference-annotation versions; lock digest over cases + provenance + reference; read-only locked files; **verification of a locked set requires a lock digest recorded OUTSIDE the system** (repository-local write access can rewrite manifest and hashes, so the manifest cannot prove its own authenticity); unlock needs a human-written, bound, single-use authorization from a different person |
| **Repeated-run capture** | each run records the pipeline, model version and **model / configuration / environment hashes (computed by the workspace from the supplied objects)**; runs are write-once; development runs only on the development split; locked runs need the lock and the digest |
| **Reports** | per-run agreement (Bland–Altman etc. via the existing pose evaluator), repeatability across runs (within-subject SD, ICC, MDC), **missing-output** accounting, **quality-gate** report (correct rejections, false rejections, **measurements where the case was unmeasurable = critical**, rejections without a reason code), error taxonomy, mixed-system-identity warning; **acceptance is always `not_assessed_by_this_tool`** |
| **Error taxonomy** (`taxonomy.ts`) | capture failure, no pose, low confidence, occlusion, calibration, disagreement (only when a tolerance is supplied — none is chosen), unsupported condition, gate violation, false rejection, missing output, unclassified |
| **Upstream-report fixtures** (`upstream-fixtures.ts`) | well-formed, malformed, unsigned, bad-signature, withdrawn, revoked, unreleased, tampered, out-of-order (sign-off before session, consent after session, future sign-off) PosturePulse cases, checked against the EXISTING import protections |

## 3. Reference measurement, repeatability, agreement, quality gate, uncertainty
Design for future human studies is in the preregistration §3–§6 (reference method independent of the system with its own uncertainty; repeated acquisitions; Bland–Altman agreement per metric and stratum; gate sensitivity and false-rejection rate; zero tolerance for fabricated measurements; every metric with intervals). In this stage the "reference" is the **parametric truth of a drawn figure**, which is exact by construction and therefore says nothing about real-world reference uncertainty.

## 4. Blinding and adjudication
The runner sees opaque case ids and media only; the reference annotator cannot run the system (the workspace refuses the combination); statisticians evaluate. Adjudication of reference disagreement is a human-study procedure (preregistration §5); this tooling does not adjudicate.

## 5. How to run
```bash
npx vitest run src/validation/pv                 # 19 tests
npm run pv:demo                                   # full synthetic rehearsal → docs/evidence/pv-synthetic-run-latest.json
```
Evidence of the latest rehearsal: [pv-synthetic-run-latest.json](evidence/pv-synthetic-run-latest.json).

## 6. Limits
Data-layer service with an **asserted** user id (no HTTP route, dashboard page or authentication); synthetic media only; one stand-in system; no real camera pipeline; thresholds and sample sizes are placeholders; PosturePulse upstream behaviour is exercised through the existing import functions, not a running upstream.

## 7. Human inputs required before any real video study — see [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md) (D19) and the list at the end of [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md).
Signed intended use; ethics approval; consent forms; participant recruitment plan with demographic strata; reference-measurement equipment and trained raters; devices, sites and acquisition SOPs; independent statistician's plan (sample size, bounds, intervals); privacy approvals, DPAs and a production storage design; a named locked-set custodian and an external place to record lock digests; clinical lead's tolerances and severity categories fixed before data collection.
