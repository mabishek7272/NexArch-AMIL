# Posture-analysis validation — preregistration (DRAFT, UNAPPROVED)

**Status: draft for review. No study has started, no human participant, recording or device exists, and nothing here is a result or a claim.** Items marked **[TO BE SET]** must be decided by the named human role and recorded **before any evaluation data is looked at**; this draft chooses no threshold, sample size or accuracy target. Parent documents: [POSTURE-VALIDATION-PROTOCOL.md](../../docs/POSTURE-VALIDATION-PROTOCOL.md), [CLINICAL-VALIDATION-PROTOCOL.md](../../docs/CLINICAL-VALIDATION-PROTOCOL.md) §7. Tooling (synthetic-only): `src/validation/pv/`.

> **A response to mannequin, drawn or parametric fixtures does not prove accuracy on humans.** Fixtures lack real anatomy, clothing, skin tones, hair, motion, camera and lighting variety, occlusion patterns and posture diversity. They test that the tooling and the quality gate behave as designed, nothing more.

| Document control | |
|---|---|
| Version / date | 0.1-draft / _blank_ |
| System under test (image ID, model, calibration, config hashes) | _blank — freeze before the locked set is first evaluated_ |
| Linked approved protocol / ethics reference | _blank — none exists_ |

## 1. Intended and non-intended use
- **Proposed intended use (clinical lead to confirm):** supervised measurement of static posture metrics (e.g. shoulder-line tilt, trunk lean) with explicit uncertainty and quality flags, as input to review by a qualified clinician.
- **Non-intended:** diagnosis; screening; treatment decisions; unsupervised or home use; any claim of clinical accuracy; use on populations, devices or conditions outside those validated; replacing clinician review.

## 2. Scope of THIS stage: synthetic / mannequin / reference-fixture only
Drawn stick-figure fixtures and parametric stand-ins, hashed and registered through the synthetic-only workspace (real media are refused). Purpose: verify tooling, manifests, locks, repeated-run capture, quality-gate accounting and failure taxonomy. **No human-accuracy conclusion may be drawn.**

## 3. Future human-study requirements (not started; all [TO BE SET] by named people)
- **Consent and ethics:** written informed consent covering video/pose data, retention, sharing and withdrawal; ethics approval; minors/vulnerable adults per approval.
- **Demographics and coverage:** age, sex, body habitus, clothing, mobility limits, skin tone/hair/lighting interactions, handedness, relevant conditions; target numbers per stratum; recruitment bias reporting.
- **Privacy:** de-identification of video and derived data, retention/destruction, access control, no external provider without a signed DPA, withdrawal handling honoured end to end.
- **Acquisition:** device models/OS, camera height/distance/angle, framing guidance, lighting range, background, scale/calibration method, supervised vs self-acquired, operator training; each recording stores these as metadata ([capture-conditions template](../templates/09-capture-conditions.template.md)); out-of-range conditions are included deliberately as stress conditions and reported separately.

## 4. Reference measurement, repeatability, agreement
- **Reference:** a method independent of the system with its own stated uncertainty (e.g. marker-based motion capture, calibrated inclinometer, expert landmark annotation by ≥ 2 independent raters) **[TO BE SET]**; reference raters blind to system output ([reference-measurement template](../templates/10-reference-measurement.template.md)).
- **Repeatability / reproducibility:** repeated acquisitions (same session, day, operator, device) and repeated processing of the same recording (determinism); within-subject SD, repeatability coefficient and ICC with intervals.
- **Agreement:** Bland–Altman bias and limits of agreement with intervals, per metric and per stratum; stated-uncertainty coverage; clinically meaningful tolerances **[SET BY CLINICAL LEAD before analysis]**.
- **Quality gate:** the system must emit an explicit `unsupported` flag with a reason code and suppress corrective cues when pose quality, scale or identity is insufficient. Measure: gate sensitivity for unusable recordings, false-rejection rate, and measurements delivered from recordings that should have been rejected (**any fabricated measurement is a critical failure**; zero-tolerance criterion and upper bound **[TO BE SET]**).
- **Uncertainty and failure modes:** every metric with intervals and n; failure taxonomy (capture failure, no pose, low confidence, occlusion, calibration, disagreement, unsupported condition) reported per stratum, never dropped from denominators.

## 5. Blinded evaluators and adjudication
Reference annotators work independently of the system and its output; the system is run by someone who cannot see references (the tooling enforces role separation). Disagreement between reference raters is adjudicated by a third rater blind to both; both originals are preserved. Evaluator agreement is reported before adjudication ([evaluator-agreement template](../templates/11-evaluator-agreement.template.md)). Adverse events and symptom reports during acquisition are logged ([adverse-event template](../templates/13-adverse-events.template.md)).

## 6. Statistical placeholders (independent statistician)
Estimands, analysis population, interval methods (clustering by subject), sample-size derivation, acceptance bounds, multiplicity and subgroup plan, missing/failed-item handling, interim looks and stopping rules, handling of repeated looks at a locked set: **[ALL TO BE SET]**. The tools' built-in minimums (35 pairs per metric, 30 subjects) are placeholders and are flagged `underpowered`. **No threshold, sample size or accuracy claim appears here.**

## 7. Approvals (all blank; none exist)
| Role | Name | Credential / reference | Decision | Signature | Date |
|---|---|---|---|---|---|
| Protocol owner | | | | _(blank)_ | |
| Independent statistician | | | | _(blank)_ | |
| Privacy / data-protection officer | | | | _(blank)_ | |
| Clinical lead | | | | _(blank)_ | |
| Ethics / IRB reference | | | | _(blank)_ | |
