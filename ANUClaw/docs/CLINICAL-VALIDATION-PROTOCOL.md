# Clinical validation protocol (DRAFT FOR REVIEW)

**Status: unapproved draft. Nothing in this document, and nothing in this repository, is a clinical validation, an approval, a result or a claim.** It is a planning
package for people outside this codebase to review, amend and approve. Every number marked **[SET BY PROTOCOL OWNER]** must be fixed and recorded *before* any
evaluation data is looked at; this document deliberately does not choose clinical acceptance thresholds. Related: [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md),
[CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md), [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md), [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md),
[RELEASE-CANDIDATE-HANDOFF.md](RELEASE-CANDIDATE-HANDOFF.md). Blank templates: [validation/templates/](../validation/templates/README.md).

| Document control | |
|---|---|
| Version | 0.1-draft (no approved version exists) |
| Protocol owner / sponsor | _blank — to be named_ |
| Clinical lead (accountable for acceptability decisions) | _blank — to be named_ |
| Independent statistician | _blank — to be named_ |
| Ethics / IRB (or equivalent) reference | _blank — none obtained_ |
| Approval signatures | _blank — see [protocol-approval template](../validation/templates/01-study-protocol-approval.template.md)_ |

## 1. Intended use, users, settings, population, exclusions

The following is a **proposed** statement for the clinical lead to confirm or replace. Until a signed intended-use statement exists, no clinical use is permitted.

- **Proposed intended use.** Decision *support for qualified review*: (a) extracting values from supplied laboratory/clinical reports into a structured draft that a
  person confirms; (b) producing a draft report (structured summary, plain-language summary) that a licensed clinician reviews before any use; (c) recording posture/movement
  measurements and device-monitoring data with explicit quality and provenance flags; (d) applying **only clinician-released** rules to confirmed data.
- **Intended users.** Licensed clinicians and supervised clinical staff (reviewers/operators) in a supervised setting. Patients/subjects are data subjects and may see
  only content a clinician has released.
- **Intended settings (to be confirmed).** Outpatient or research clinic with a named responsible clinician, supervised acquisition and a defined escalation path.
  Home or unsupervised use is **not** in scope.
- **Target population (to be defined by the clinical lead):** age range, conditions, languages and report formats. Each rule and each measurement has its own
  population statement in its dossier; the product-level population cannot be wider than the narrowest enabled module.
- **Exclusions (proposed starting list):** emergencies and acute symptoms (the safety state machine pauses on symptom reports; it is not an emergency service); pregnancy,
  paediatric and other groups unless a module's dossier covers them; people unable to consent; scans/recordings that fail the quality gate; report types/languages outside the validated set.

## 2. Explicit non-intended uses

Diagnosis; treatment selection or dosing; triage or emergency detection; autonomous release of any result to a patient; screening of asymptomatic people; any use that
replaces clinician review; use outside the validated report types, languages, devices or populations; use of model output as a threshold source; any claim of accuracy,
sensitivity, specificity or clinical benefit not backed by a signed, completed validation record; marketing as a medical device before the regulatory pathway is decided
([PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md) §7).

## 3. General design rules (apply to every study below)

1. **Pre-registration inside the protocol.** Hypotheses, sample sizes, metrics, acceptance criteria and stopping rules are written, dated and approved before data collection; changes are amendments with rationale.
2. **Frozen system under test.** Record image ID/digest ([repro-manifest.json](evidence/repro-manifest.json)), model/OCR/provider versions, rule versions and configuration hashes; any change after freeze triggers the [change-control record](../validation/templates/07-model-provider-change-control.template.md).
3. **Separation of development and test data.** Test data is never used to tune thresholds, prompts or parsers; a locked test set is held by someone other than the developers.
4. **Real data only for validation.** The synthetic fixtures in this repository prove tool mechanics; they never count towards a validation sample.
5. **Report failures.** Every failed item, excluded item and protocol deviation is listed with its disposition. No post-hoc subset selection.
6. **Humans decide.** The tools in [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md) emit measurements and a structural-minimums check; `clinicalAcceptance` is always `not_assessed_by_this_tool`.
   The tools' default minimums are placeholders; the protocol's numbers replace them and are passed explicitly.

## 4. OCR and extraction evaluation

> Authenticated workspace layer (roles, blind annotation, server-side lock protections, audit allow-list, fail-closed storage) — synthetic-only: [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#authenticated-ocr-study-workspace-layer-task-74). The production storage contract for a real study (encryption, retention, access control) is **not implemented**.
>
> Study-specific draft: [OCR study preregistration](../validation/protocols/ocr-study-preregistration.md); supporting tooling (synthetic-only): [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#ocr-study-tooling-task-73).

**Question:** how accurately and how *safely* (silent errors) does the system turn a report into candidate values with correct unit, range and page attribution?

- **Report categories (representative, stratified).** Sampling frame to be agreed, covering at least: native-text PDFs; scanned PDFs at several resolutions; phone photographs (skew, shadows, glare);
  multi-page and multi-column layouts; tables with merged cells; handwritten annotations; at least each language and each laboratory/vendor template in scope; abnormal/flagged values, comparators (`<`, `>`),
  mixed units, missing ranges, and low-quality pages. Strata and minimum documents per stratum: **[SET BY PROTOCOL OWNER]**.
- **Ground truth.** Each document is annotated by **two independent annotators** (no shared notes, separate sessions) following a written annotation guide: analyte (canonical name), value (as printed), comparator,
  unit, reference low/high, abnormal flag as printed, and **page** (and optionally region). Annotators are blinded to system output. Template: [OCR annotation & adjudication](../validation/templates/03-ocr-annotation-adjudication.template.md).
- **Agreement and adjudication.** Report inter-annotator agreement per field (percent agreement and Cohen's κ for categorical fields; exact-match rate for numerics) **before** adjudication. A third senior annotator adjudicates every
  disagreement; the adjudicator is blinded to which annotator said what and to system output. Unresolvable items are recorded as `ambiguous` and handled by a pre-declared rule (excluded from the denominator **and** reported).
- **Scoring (per `npm run validate -- ocr`).** Analyte recall/precision; value, comparator, unit, reference-low/high and page-attribution accuracy with Wilson 95% intervals; extraction failures by page status
  (`ocr_unavailable`, `unsupported`, partial); **silent errors** (a wrong value presented without an uncertainty flag) counted separately and treated as the primary safety metric; per-stratum results, not only pooled.
- **Failure analysis.** Every silent error and every failed page gets a root-cause category (image quality, layout, unit parsing, analyte normalisation, engine error) and a disposition (fix + re-test on *new* data, restriction of
  intended use, or accept with mitigation). Fixes made after seeing the test set require a fresh locked set.
- **Confidence calibration.** Compare reported OCR/parser confidence with correctness: reliability table by confidence bin, expected calibration error with intervals, and the **uncertainty-flag operating point** — the
  threshold (`lowConfidenceThreshold`, tool default 0.8 is a placeholder) chosen on development data and *then* evaluated on the locked test set; report the share of errors that were flagged and the review burden (flagged items per document).
- **Human-in-the-loop check.** Because every candidate requires confirmation, also measure end-to-end error *after* human confirmation (residual errors in confirmed observations) and confirmation time — a separate result from raw OCR accuracy.
- **Acceptance criteria:** silent-error rate upper bound, per-field minimum accuracy lower bounds, flagged-error capture rate: **[SET BY PROTOCOL OWNER]**. Sample size: derived from those bounds by the statistician (§12), not from tool defaults.

## 5. Report-extraction, SOAP and plain-language summary evaluation

**Question:** are the generated structured report and lay summary faithful, complete, non-diagnostic and understandable?

- **Faithfulness (automated + human).** Every number in the draft must trace to a confirmed observation (the product enforces numbers-from-confirmed-data; the study verifies it on real reports: count of unsupported numbers, units changed, ranges misapplied).
- **Clinician rating.** Blinded licensed clinicians (≥ 2 per report, independent) rate: factual accuracy, omissions of clinically material items, inappropriate inference/diagnostic language, unsafe reassurance, and
  appropriateness of "missing/insufficient data" statements, using a structured rubric with anchored scales; report inter-rater agreement (weighted κ or ICC) and disagreements.
- **Prohibited-content audit.** All outputs scanned and manually sampled against the prohibited-claims list (the `lint:claims` rules of the outer project and the specialty registry's `prohibitedClaims`); any diagnosis,
  prognosis or treatment recommendation is a protocol failure.
- **Plain-language summaries.** Readability measures (reported with the method and language), plus comprehension testing with lay participants (consented; understanding of what is and is not being said, what to do next, and
  who to contact) and clinician review for harmful simplification. Languages tested = languages claimed.
- **Prompt-injection / adversarial content.** A fixed set of documents with embedded instructions must remain inert (already unit-tested on synthetic data; repeat on real-format samples).
- **Acceptance criteria and sample size:** **[SET BY PROTOCOL OWNER]**; any critical-severity finding stops the study (§13).

## 6. Clinical rules evaluation

Applies to every rule before release; follows [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md) and uses the [rule dossier & sign-off](../validation/templates/04-clinical-rule-dossier-signoff.template.md) and `npm run validate -- rule`.

- **Evidence source.** Guideline/standard with version, publisher, licence confirmed to permit this use; citation recorded; no threshold derived from model output.
- **Named clinical owner** (accountable, credentialed) and an **independent reviewer** (not the author; credential reference; conflict-of-interest statement).
- **Intended population, contraindications and exclusions** stated per rule; what the rule does when the case is outside them (`not_comparable`/`insufficient_data`, never a guess).
- **Specification.** Inputs with units/specimen/context; exact thresholds; boundary behaviour (value exactly at a limit, comparators, rounding, missing units, unit conversions, reference ranges that differ by lab);
  conflicting or duplicated observations.
- **Boundary and adversarial cases.** A case table defined *before* implementation review: each boundary value ±ε, unit variants, missing/contradictory inputs, out-of-population cases, plus cases chosen by the independent reviewer. Expected outputs are written by the clinical owner, not generated by the implementation.
- **Evaluation on real cases.** Representative retrospective cases with clinician-adjudicated expected outputs; report concordance with intervals, every discordance with disposition, and any case where the rule *could have* misled a reader (safety review).
- **Versioning, approval and rollback.** Rule version immutable once approved; any threshold or population change is a new version and a new approval; the register ([clinical-release-register.json](clinical-release-register.json)) and the signed record (in the approver's own system) must match; a
  pre-declared **rollback trigger** (e.g. a confirmed harmful output or a source-guideline change) and the person who may invoke it; old versions remain in the register.
- **Pilot and monitoring** before widening use: supervised pilot with defined stop criteria and review cadence (§13).

## 7. Posture analysis evaluation

**Question:** do posture/movement measurements agree with a reference measurement, repeatably, under the intended acquisition conditions — and does the system refuse when it should?

- **Consent and ethics.** Written informed consent covering video/pose data, retention and sharing; ethics approval; minors/vulnerable adults handled per approval; withdrawal procedure
  (the consent/withdrawal flags in the platform are honoured end to end). Template: [consent & de-identification attestation](../validation/templates/02-consent-deidentification-attestation.template.md).
- **Participants and demographics.** Recruitment plan to cover the intended population: age, sex, body habitus, clothing, mobility limitations, skin tone/hair/lighting interactions, handedness, relevant conditions. Target numbers per
  stratum **[SET BY PROTOCOL OWNER]**; recruitment bias and exclusions reported. (Tool placeholder minimums — 35 pairs per metric / 30 subjects — are not a power calculation.)
- **Acquisition conditions.** Device models and OS versions, camera height/distance/angle, framing guidance, lighting range, background, clothing, scale/calibration method, supervised vs. self-acquired, operator training. Each recording
  stores these as metadata; conditions outside the intended range are included deliberately as stress conditions and reported separately.
- **Reference measurement.** A pre-specified reference with stated own uncertainty (e.g. marker-based motion capture, calibrated goniometer/inclinometer, radiographic measurement where ethically justified, or expert annotation of
  landmarks by ≥ 2 independent raters with agreement reported). The reference rater/system is independent of the software under test and blind to its output.
- **Annotation and evaluator agreement.** Video/landmark annotation by independent evaluators; inter- and intra-evaluator reliability (ICC with intervals); disagreement handling. Template: [posture/video annotation & evaluator agreement](../validation/templates/05-posture-video-annotation-evaluator-agreement.template.md).
- **Repeatability and reproducibility.** Repeated acquisitions (same session, same day, different day, different operator/device) and repeated processing of the same recording (determinism); within-subject SD, repeatability coefficient and ICC with intervals (`npm run validate -- pose`).
- **Agreement.** Bland–Altman bias and 95% limits of agreement with intervals, MAE/RMSE, proportional-bias check, and whether the system's stated uncertainty (±) covers observed error, per metric and per stratum; clinically meaningful
  tolerances per metric **[SET BY CLINICAL LEAD]**, fixed before analysis.
- **Failure criteria and quality gate.** The system must emit an explicit `unsupported` quality flag and suppress corrective cues when pose quality, scale or identity is insufficient (repository rule). Measure: gate sensitivity for
  truly unusable recordings, false-rejection rate, and — critically — measurements delivered from recordings that should have been rejected (target **[SET BY PROTOCOL OWNER]**; any fabricated measurement is a critical failure).
- **Safety.** Observation of adverse events and symptom reports during acquisition; pause behaviour verified in scenarios; adverse-event log ([device reliability & adverse-event log](../validation/templates/06-device-reliability-adverse-event-log.template.md)).
- **No real-device or pose-agreement study exists yet** (matrix L4: none).

## 8. Device-monitoring evaluation

**Question:** is device data reliable enough, and are gaps/delays/disorder handled safely and visibly?

- **Scenarios (each run on real devices and, for fault injection, on the supervised test bench):** missing data and outages of defined length; delayed and bursty delivery (backlog flush); out-of-order and duplicate events; clock skew and drift,
  future-dated timestamps, device clock reset; device reboot/battery-off; connectivity flap; sensor detachment/implausible values; multi-device sessions; time-zone/DST changes.
- **Measures (`npm run validate -- device`).** Completeness, duplicate rate, gap detection (including recovery of known injected outages), delivery latency p50/p95/p99, out-of-order rate, backlog bursts, clock offset/drift — each with intervals and per-device-model breakdown.
- **Freshness and staleness.** Verify the two-clock freshness logic: data never shown as current when stale; thresholds **[SET BY CLINICAL LEAD]** per monitored parameter.
- **Safety escalation scenarios.** Pre-written scenarios (e.g. threshold crossing with delayed data; threshold crossing during outage; symptom report concurrent with high model confidence; duplicate alerts; alert after acknowledgement) with expected behaviour defined by the
  clinical lead; pass/fail recorded per scenario; **safety rules must outrank any model output** in every scenario. Escalation *delivery* to a human (who, how fast, fallback when unacknowledged) is tested with the operational team, not only in software.
- **Reliability over time.** Soak run of defined duration **[SET BY PROTOCOL OWNER]**, including restarts and database failover, with all anomalies logged.
- **No real-device recordings exist yet** (matrix L4: none).

## 9. Prospective usability and workflow study

- **Design.** Prospective, supervised, with the intended users in the intended setting; summative usability evaluation following the applicable human-factors standard chosen at the regulatory review (§7 of the production plan); formative rounds before it.
- **Participants.** Representative clinicians/operators (number, experience mix and training level per protocol); lay participants for patient-facing content.
- **Tasks and use scenarios.** Upload and review a report; correct a wrong OCR value; recognise an uncertainty flag; handle a stale/missing-data state; sign off or reject a draft; respond to a safety pause; export and verify provenance; revoke consent / erase data.
- **Measures.** Task success and critical errors (including "use errors" that could lead to harm), time on task, confirmation behaviour (do users confirm blindly? override rate; **automation-bias check** with seeded deliberately wrong
  extractions), subjective load/usability scales, think-aloud findings, and workflow impact (time per report versus current practice).
- **Operational readiness observations.** Training sufficiency, support requests, handover and downtime procedures.
- **Acceptance and stopping** per §12–13; any use error with potential for serious harm must be mitigated and re-tested.

## 10. Privacy, governance, retention, de-identification and provider conditions

- **Legal basis and approvals** per jurisdiction (consent, ethics, institutional data-governance approval) — recorded before collection.
- **Data minimisation and classes.** Study data classified (identifiable, pseudonymous, de-identified, public); documents containing identifiers are stored encrypted with owner-only access; the research workspace uses only de-identified data.
- **De-identification.** Documented method (rules, review sampling, residual-risk assessment, re-identification risk review), a named attester, and a rule that annotators receive only de-identified material unless the protocol justifies otherwise.
  Free text and images (faces, labels, EXIF, embedded metadata) are explicit checklist items. The `ELAB_DEID_REQUIRED` egress setting must be on for any external call.
- **Retention and destruction.** Retention periods per data class, destruction method and certificate, handling of withdrawal (what can and cannot be removed after analysis), backup purge timing.
- **Provider data-processing conditions.** No identifiable or study data goes to any model/OCR/hosting provider until a signed data-processing agreement covers: purpose limitation, no training on data, retention/deletion, location, sub-processors,
  breach notification and audit rights. Until then only synthetic data or locally processed data is allowed. Provider changes follow the [change-control record](../validation/templates/07-model-provider-change-control.template.md).
- **Access control and audit.** Named study staff only; per-patient grants; audit log retained for the protocol-specified period; periodic access review.
- **Incident handling.** Data-breach and protocol-deviation procedure with named contacts and notification clocks.

## 11. Model, provider and software change control during validation

Any change to model, prompt, OCR engine, parser, rule, threshold, container image, dependency lock or provider setting after the freeze requires the [change-control record](../validation/templates/07-model-provider-change-control.template.md): impact analysis, which validation results it
invalidates, re-test scope, approver, and rollback. A change that can affect results voids the affected validation until re-tested on a locked set.

## 12. Statistical analysis plan (to be finalised by an independent statistician)

- **Estimands and metrics** pre-specified per study (§4–9) with the analysis population (all consented/eligible items, with exclusions listed *a priori*) and handling of missing/failed items (failures counted as failures, not dropped).
- **Intervals, not just point estimates.** Wilson (or exact) 95% intervals for proportions; bootstrap or analytic intervals for agreement statistics, clustered by subject/document/device where observations are not independent (mixed models or cluster bootstrap).
  Report the lower/upper bound that the acceptance criterion refers to.
- **Agreement:** Bland–Altman with LoA intervals; ICC form and model stated (e.g. two-way, absolute agreement); κ weights stated; repeatability coefficient.
- **Sample size.** Derived from the acceptance bounds, expected performance and clustering; documented with assumptions and a sensitivity analysis. Tool default minimums (OCR 300 items / 30 documents; pose 35 pairs / 30 subjects; device 1000 observations) are **placeholders only**.
- **Multiplicity and subgroups.** Primary metrics declared; subgroup/stratum analyses declared; no claim from an unplanned subgroup. A system is not accepted on a pooled metric if a pre-declared stratum fails.
- **Uncertainty reporting.** Every reported metric carries its interval and sample size; underpowered results are labelled; no "validated/passed" wording is produced by the tools — the clinical lead's decision and the criteria it was measured against are recorded in the
  [validation-result summary](../validation/templates/08-validation-result-summary.template.md).
- **Acceptance criteria.** For each metric: the minimum acceptable bound, the comparator (reference/standard of care, if any), who decided, and the date — **fixed before data collection**. Critical-safety metrics (silent OCR errors, fabricated measurements, missed escalation, unsafe
  reassurance) use *zero-tolerance observed* criteria **plus** an upper confidence bound requirement: **[SET BY PROTOCOL OWNER]**.
- **Reproducibility of the analysis.** Analysis code, tool versions, input hashes and the frozen system manifest are archived; results can be regenerated from them.
- **Data-integrity checks:** locked datasets with hashes; audit trail of any data correction.

## 13. Stopping criteria and escalation

Defined per study and approved with the protocol. Minimum content:
- **Immediate stop** (study paused, clinical lead and sponsor notified): any harm or credible near-miss attributable to the system; any breach of privacy; any fabricated measurement or unflagged material error reaching a clinician in a live pilot; discovery that test data leaked into development;
  loss of consent validity; provider or regulator instruction.
- **Interim review** at pre-declared points by someone independent of the developers (futility / unexpected failure-rate / safety signals), with rules fixed in advance.
- **Resumption** only by a documented decision of the clinical lead after root-cause analysis and any needed [change-control](../validation/templates/07-model-provider-change-control.template.md) and re-test.
- **Rollback** of any released content per its dossier trigger.

## 14. Roles (accountable humans; none are assigned by this document)

| Role | Accountable for |
|---|---|
| Protocol owner / sponsor | scope, resources, approval of the protocol and amendments |
| Clinical lead | intended use, clinical acceptance criteria, acceptability decisions, rollback authority |
| Named clinical owner per rule / module | rule dossier, population, evidence |
| Independent rule reviewer | independent review and conflict statement |
| Independent statistician | SAP, sample size, analysis, interval reporting |
| Annotation lead + annotators + adjudicator | ground truth quality and blinding |
| Privacy / data-protection officer | consent, de-identification, DPAs, retention |
| Security lead | security testing, access control ([PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md)) |
| Quality / regulatory lead | change control, documentation, regulatory pathway |
| Engineering lead | frozen build, reproducibility, tool operation |

## 15. Inputs still required before any study can start

Signed intended-use statement; ethics/IRB approval; named roles above; approved protocol with numeric criteria; consent forms; data-sharing and DPAs; sourced real report corpus and annotators; reference-measurement
equipment and operators; devices and sites for posture/monitoring studies; rule sources and clinical owners; sample-size calculation; budget and schedule. None exists in this repository today.
