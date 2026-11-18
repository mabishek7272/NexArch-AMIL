# Implementation roadmap — next milestones (PLAN, nothing started)

Ordered milestones from the current engineering release candidate to a production go/no-go. **No clinical thresholds or sample sizes are chosen here**; they are set by the protocol owner, clinical lead and independent statistician *before* data collection
([CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md)). Owners are roles; no person is assigned. Decision IDs (D01…) refer to [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md). Gates (G0…) refer to [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md) §7.
Milestones M5/M6 and M2/M3 can overlap where dependencies allow; **M9 requires all earlier exit evidence**. Durations are deliberately not estimated: they depend on funding, ethics approval and data access.

## Overview

| # | Milestone | Depends on | Main blockers |
|---|---|---|---|
| M1 | Governance and intended-use approval | — | no named accountable people; no sponsor decision |
| M2 | Security, privacy and contract readiness | M1 | no DPAs, no legal/regulatory assessment, no pen test |
| M3 | Clinical-rule source and owner onboarding | M1 | no clinical owners, no licensed sources |
| M4 | OCR validation study | M1, M2 (data flow), ethics | no real report corpus, annotators, statistician |
| M5 | Posture/video and device-validation studies | M1, M2, ethics | no participants, reference equipment, devices, sites |
| M6 | Provider spend controls and authenticated-agent test | M1 (D12) | no provider-side cap; explicit human authorisation |
| M7 | Production isolation and operational readiness | M2, M6 | isolation model undecided; no infrastructure/ops owner |
| M8 | Limited pilot | M3–M5, M7 | requires signed validation summaries and usability evidence |
| M9 | Production go/no-go | all | default NO-GO |

## M1 — Governance and intended-use approval
- **Clinician decision materials (task 78):** [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md) collects every clinical-lead decision with blank decision and independent-review sections; [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md) is the pre-study review checklist. Drafts only: nothing is decided, assigned or approved.
- **Entry criteria:** this pack delivered; product owner available for D01, D08, D12.
- **Deliverables:** signed intended-use / non-intended-use statement (D01); named holders of every role in the protocol and plan (D12); funding/programme decision (D08); decision records for the register entries that are independent of later work (D05, D07, D14).
- **Human owners:** Founders/sponsor; Clinical lead; Product owner.
- **Exit evidence (measurable):** D01, D08, D12 records complete and signed; role list with named persons and credential references; gates G0 criteria linked.
- **Blockers:** no person currently named in any source document for these roles.

## M2 — Security, privacy and contract readiness
- **Entry criteria:** M1 exit; intended use fixed.
- **Deliverables:** DPIA; signed data-processing agreements for every provider that may receive personal data, or a signed decision for local-only processing (D10); regulatory pathway assessment (D11); ethics/institutional route (D09); independent threat-model review and penetration-test scope; licence review of public-data terms for the intended use; decision on the upstream signed-export (D06) using the [review checklist](proposals/posturepulse-upstream-review-checklist.md).
- **Human owners:** Privacy officer; Legal/regulatory lead; Security lead; PosturePulse upstream owners (D06).
- **Exit evidence:** executed agreements (or local-only decision) on file; written regulatory assessment; ethics reference; threat-model sign-off; G1–G3 criteria evidenced except the penetration test results, which close in M7.
- **Blockers:** counterparties' signing times; upstream owner availability; choice of jurisdiction.

## M3 — Clinical-rule source and owner onboarding
- **Entry criteria:** M1 exit; at least one clinical owner willing to be accountable for a narrow module (D13).
- **Deliverables:** per module: named clinical owner and independent reviewer with conflict statements; licensed guideline sources; completed [rule dossier](../validation/templates/04-clinical-rule-dossier-signoff.template.md); boundary-case table authored by the owner; evaluation plan with criteria fixed in advance; draft register entries (not released).
- **Human owners:** Clinical lead; named clinical owner(s); independent reviewer(s).
- **Exit evidence:** dossier passes `npm run validate -- rule` for completeness (a completeness check, not an approval); sources and licences confirmed in writing; **no rule is released** until M4–M5 style evaluation results and the approver's own signed record exist.
- **Blockers:** availability of qualified owners; licence terms of guidelines.

## M4 — OCR validation study
- **Policy dashboard + review (task 81):** draft editing, two-person review and a readiness report exist (all references recorded, never verified; no activation surface). M4 entry additionally requires the approved-protocol gate and external authorization that remain absent.
- **Policy layer (task 80):** [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) — one versioned policy record (all real fields unconfigured, activation blocked); M4 entry additionally requires the joint clinical-lead + statistician values in packet §15 and an approved-protocol gate that does not yet exist.
- **Review packet (task 79):** [OCR-PROTOCOL-REVIEW-PACKET.md](OCR-PROTOCOL-REVIEW-PACKET.md) — blank clinician-completable sections, decision-to-implementation traceability and a blank evidence register. Draft only: nothing approved, no data, no thresholds.
- **AIKosh (task 76):** local inventory, registry/approval workflow and offline benchmark adapters exist; all data is blocked from external use pending human provenance/licence/consent evidence ([AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md) §6). Any benchmark use for validation claims still needs the protocol, owners and statistician above.
- **Security readiness (task 75):** threat model, membership lifecycle, re-authentication/CSRF/limits/rate-limit controls and an object-store contract harness exist (synthetic-only). Still required before any real study: object-store implementation passing the harness against the real service, SSO/MFA, independent penetration test, ethics approval — all external.
- **Authenticated layer (task 74):** an authenticated API and dashboard page (seven study roles, blind annotation, two-person unlock, audit allow-list) exist and are tested with synthetic data; **a real study additionally needs** a production `StudyObjectStore` implementation with customer-managed encryption, retention locks and access policy, a decision on identity/MFA for study users, and removal of the synthetic-only restriction under an approved protocol (see [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md) §1).
- **Tooling status (task 73):** locked test-set manifests, annotation agreement/adjudication, workflow CLI and the locked evaluation report are **implemented, synthetic-only, clinically unvalidated**; the [preregistration draft](../validation/protocols/ocr-study-preregistration.md) has blank approvals. What remains for M4 is entirely human/data: approved protocol with numeric criteria, ethics and data agreements, real corpus, annotators, adjudicator, statistician.
- **Entry criteria:** M1–M2 exit for the data flow used; approved protocol with numeric criteria and sample size set by the statistician; de-identified corpus sourced under consent or data-use agreement; two annotators and an adjudicator trained; locked test set custodian named.
- **Deliverables:** locked ground-truth set (hash recorded); inter-annotator agreement report; system results on the locked set per `npm run validate -- ocr`; failure and silent-error analysis; calibration analysis; [validation-result summary](../validation/templates/08-validation-result-summary.template.md); extraction/SOAP/plain-language evaluation (protocol §5).
- **Human owners:** Protocol owner; Annotation lead; Independent statistician; Clinical lead.
- **Exit evidence:** result summary signed by the clinical lead recording, against the pre-declared criteria, whether each bound was met; all failures dispositioned; frozen-system manifest attached.
- **Blockers:** real report corpus, annotators and statistician; none exists today.

## M5 — Posture/video and device-validation studies
- **Tooling status (task 77):** synthetic-only posture and monitoring validation tooling, protocols and blank templates exist ([POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md), [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md)); the preregistration has blank approvals. Everything this milestone needs remains human, device and data work (list at the end of the monitoring protocol); drawn/simulated fixtures prove nothing about people or devices.
- **Entry criteria:** ethics approval and consent forms; reference measurement method chosen with its own uncertainty; devices/sites; protocol with criteria and sample sizes set by the statistician; operators trained.
- **Deliverables:** acquisition records and annotations ([templates 05, 06](../validation/templates/README.md)); agreement, repeatability and quality-gate results (`npm run validate -- pose`); device reliability and escalation scenario results (`npm run validate -- device`); adverse-event log; result summaries.
- **Human owners:** Protocol owner; Clinical lead; Independent statistician; Engineering lead (device bench).
- **Exit evidence:** signed summaries; every fabricated measurement or missed escalation count reported with its disposition; stress-condition results reported separately.
- **Blockers:** participants, reference equipment, devices, site agreements.

## M6 — Provider spend controls and authenticated-agent test
- **Entry criteria:** D03 decided; provider-side cap configured; a person authorises the run and its maximum spend (D02).
- **Deliverables:** documented provider limits and alerts (no key values in the repository); one human-enabled run of the authenticated test `L-c` and, if desired, a bounded tool-driven task; updated container and acceptance evidence recording exactly what ran.
- **Human owners:** Finance owner; Engineering lead.
- **Exit evidence:** provider-side limit export; test output with measured spend within the authorised maximum; docs updated with the exact result (pass or concrete failure).
- **Blockers:** no provider-side cap exists; no authorisation exists. Until then the test stays skipped.

## M7 — Production isolation and operational readiness
- **Entry criteria:** M2 exit; D04 (container isolation model) and D12 (secrets) decided.
- **Deliverables:** staging environment; infrastructure as code; secrets manager in use; production container-isolation implementation; backups with a restore drill; DR drill against declared RPO/RTO; observability and alerting; penetration test and fixes; dependency/image scanning with SLAs; rollback rehearsal; support, training and incident runbooks.
- **Human owners:** Operations lead; Security lead; Engineering lead; Support lead.
- **Exit evidence:** drill records and timings; pen-test report with no open critical/high findings; alert tests; rollback rehearsal record; G3–G5 criteria signed.
- **Blockers:** infrastructure and operations ownership and budget.

## M8 — Limited pilot
- **Entry criteria:** M3–M5 summaries signed for exactly the scope piloted; usability study (protocol §9) meeting its pre-declared criteria; M7 exit; users trained; stopping criteria and interim-review owner defined.
- **Deliverables:** supervised pilot with the released scope only; incident and deviation logs; interim review reports; user feedback.
- **Human owners:** Clinical lead; Support lead; Protocol owner.
- **Exit evidence:** pilot report against pre-declared stop and success criteria; no unresolved critical incident; decision recorded by the clinical lead.
- **Blockers:** every item above; any released rule must be in the signed [release register](clinical-release-register.json).

## M9 — Production go/no-go
- **Entry criteria:** M1–M8 exit evidence assembled; residual-risk statement drafted.
- **Deliverables:** evidence index mapped to gates G0–G9; residual-risk statement; signed go/no-go (D15 clinical use, D16 production deployment) — separate decisions.
- **Human owners:** Accountable executive; Clinical lead; Security lead; Operations lead.
- **Exit evidence:** signed records for D15 and D16. **Default outcome: NO-GO.**
- **Blockers:** everything not yet evidenced.

## What the engineering team can do safely after M1 decisions

Only items that need no clinical judgement: apply the decision on PyMOL (D05), prepare the pre-registration packet and locked-set tooling, regenerate the reproducibility manifest after any change, extend documentation checks, and prepare data-handling procedures and test environments. Nothing here releases clinical content or enables paid or production use.
