# Clinical-rule dossier and sign-off — template

> **BLANK TEMPLATE.** Contains no results, signatures, approvals or participants. Fill in outside this repository's evidence folders; never commit real personal data. Any example value is marked `EXAMPLE (synthetic)`.


Machine-readable input for `npm run validate -- rule`: [rule-dossier.template.json](rule-dossier.template.json). Release procedure: [CLINICAL-CONTENT-RELEASE.md](../../docs/CLINICAL-CONTENT-RELEASE.md). The release register lives in `docs/clinical-release-register.json` and must match exactly.

| Field | Entry |
|---|---|
| Rule ID / version | |
| Named clinical owner (credential reference) | |
| Independent reviewer (credential reference) and conflict-of-interest statement | |
| Intended use | |
| Source (guideline/standard, version, publisher) and licence confirmation | |
| Intended population | |
| Exclusions and contraindications | |
| Inputs (units, specimen/context) | |
| Thresholds (each with source citation; none from model output) | |
| Behaviour for `insufficient_data` / `not_comparable` | |
| Boundary / adversarial case table (written before implementation review) | |
| Evaluation plan, acceptance criteria and their date (before results) | |
| Evaluation results summary (link to the validation-result summary) | |
| Failures and dispositions | |
| Pilot and monitoring plan | |
| Rollback trigger and who may invoke it | |
| Change-control reference | |

## Sign-off (the approver's own signed record is the authority; the register entry only references it)
| Role | Name | Credential / reference | Signature | Date |
|---|---|---|---|---|
| | | | _(blank)_ | |

- [ ] Second person confirmed the signed record exists  - [ ] Register entry added in the same change as the rule
