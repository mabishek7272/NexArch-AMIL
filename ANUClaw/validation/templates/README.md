# Validation templates

Blank, synthetic-only. Nothing here is a result, approval or signature. The protocol they support is [CLINICAL-VALIDATION-PROTOCOL.md](../../docs/CLINICAL-VALIDATION-PROTOCOL.md).

## Document templates (human process records)

| # | Template | Used in protocol § |
|---|---|---|
| 01 | [Study protocol approval](01-study-protocol-approval.template.md) | all |
| 02 | [Participant consent and de-identification attestation](02-consent-deidentification-attestation.template.md) | 10 / 7 |
| 03 | [OCR annotation and adjudication](03-ocr-annotation-adjudication.template.md) | 4 |
| 04 | [Clinical-rule dossier and sign-off](04-clinical-rule-dossier-signoff.template.md) | 6 |
| 05 | [Posture/video annotation and evaluator agreement](05-posture-video-annotation-evaluator-agreement.template.md) | 7 |
| 06 | [Device reliability and adverse-event log](06-device-reliability-adverse-event-log.template.md) | 8 / 9 |
| 07 | [Model/provider change-control record](07-model-provider-change-control.template.md) | 11 |
| 08 | [Validation-result summary](08-validation-result-summary.template.md) | 12 |

## Data-governance templates (AIKosh)

[dataset-card.template.md](dataset-card.template.md) and [finetuning-readiness-checklist.template.md](finetuning-readiness-checklist.template.md) — blank; passing the checklist does **not** authorize fine-tuning or clinical use. See [AIKOSH-DATA-GOVERNANCE.md](../../docs/AIKOSH-DATA-GOVERNANCE.md).

## Clinical rule dossier (draft-only)

[14-rule-dossier-draft.template.md](14-rule-dossier-draft.template.md) and the [unpopulated example](../examples/rule-dossier-UNPOPULATED-example.md): DRAFT — NOT RELEASED — NO CLINICAL DECISION SUPPORT; no thresholds or sources supplied.

## Posture / monitoring validation templates (task 77; blank)

| # | Template |
|---|---|
| 09 | [Capture conditions record (one per recording)](09-capture-conditions.template.md) |
| 10 | [Reference measurement record](10-reference-measurement.template.md) |
| 11 | [Evaluator agreement record](11-evaluator-agreement.template.md) |
| 12 | [Device reliability record](12-device-reliability.template.md) |
| 13 | [Adverse-event and incident log](13-adverse-events.template.md) |

Protocols: [posture preregistration draft](../protocols/posture-validation-preregistration.md), [POSTURE-VALIDATION-PROTOCOL.md](../../docs/POSTURE-VALIDATION-PROTOCOL.md), [MONITORING-VALIDATION-PROTOCOL.md](../../docs/MONITORING-VALIDATION-PROTOCOL.md).

## Machine-readable input templates (for `npm run validate -- …`; rejected as inputs on purpose until filled)

`ocr-annotation.template.json`, `ocr-results.template.json`, `pose-reference.template.json`, `pose-results.template.json`, `device-log.template.json`, `rule-dossier.template.json`, `unlock-authorization.template.json` (blank; the human-written record required to unlock a locked OCR-study dataset — see `docs/VALIDATION-TOOLS.md`). The OCR study preregistration draft is `../protocols/ocr-study-preregistration.md`. Synthetic fixtures: `../fixtures/`. See [VALIDATION-TOOLS.md](../../docs/VALIDATION-TOOLS.md).
