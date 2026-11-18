# OCR annotation and adjudication — template

> **BLANK TEMPLATE.** Contains no results, signatures, approvals or participants. Fill in outside this repository's evidence folders; never commit real personal data. Any example value is marked `EXAMPLE (synthetic)`.


Machine-readable inputs for `npm run validate -- ocr` use [ocr-annotation.template.json](ocr-annotation.template.json); this document records the human process around them.

## Annotation guide version / location: 
Fields to annotate per item: analyte (canonical), value as printed, comparator, unit, reference low, reference high, abnormal flag as printed, **page**. Rules for illegible, ambiguous, handwritten and duplicate items: _(define)_

| Doc ID (de-identified) | Stratum | Annotator A | Annotator B | Blinded to system output? | Status |
|---|---|---|---|---|---|
| | | | | [ ] | |

## Disagreement log (every field disagreement)
| Doc ID | Item | Field | A | B | Adjudicator | Final | Ambiguous? | Reason |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Agreement before adjudication
| Field | n | % agreement | Cohen's κ (categorical) | Interval |
|---|---|---|---|---|
| | | | | |

## Process attestation
- [ ] Annotators worked independently (no shared notes)  - [ ] Adjudicator blinded to annotator identity and system output  - [ ] Locked ground-truth file hash recorded: `<sha256>`

| Role | Name | Credential / reference | Signature | Date |
|---|---|---|---|---|
| | | | _(blank)_ | |
