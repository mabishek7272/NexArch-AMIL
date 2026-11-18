# Clinical rule dossier — DRAFT TEMPLATE

> **DRAFT — NOT RELEASED — NO CLINICAL DECISION SUPPORT.** Blank template. It contains no thresholds, ranges, sources, treatment recommendations or approvals, and nothing entered here is read by the software. A rule becomes releasable only through [CLINICAL-CONTENT-RELEASE.md](../../docs/CLINICAL-CONTENT-RELEASE.md): the approver's own signed record, a matching entry in `docs/clinical-release-register.json`, and a second reviewer. Machine-readable completeness check: `npm run validate -- rule` with [rule-dossier.template.json](rule-dossier.template.json) (a completeness check, not an approval).

| Field | Entry |
|---|---|
| Topic (narrow; one measurement or question) | `[SELECT CLINICAL MEASUREMENT]` |
| Rule ID / version | _unassigned_ |
| Status | DRAFT — NOT RELEASED |
| Author (role) / date | |
| Named clinical owner (role holder to be assigned by the organisation; credential reference) | |
| Independent reviewer (credential reference) and conflict-of-interest statement | |

## 1. Intended use and population
- Intended use (one sentence; what a reviewer may do with the output): `[WRITE]`
- Intended population (age band, conditions, languages): `[WRITE]`
- Setting and supervision: `[WRITE]`
- **Exclusions and contraindications** (each with its source): `[WRITE]`
- Behaviour when the case is outside the population: `not_comparable` / `insufficient_data` (never a guess): `[CONFIRM]`

## 2. Source requirements (to be filled by the clinical lead; none supplied here)
| Source | Title | Version / date | Publisher | Licence permits this use? | Section relied on |
|---|---|---|---|---|---|
| 1 | `[CITE]` | | | | |
No threshold may come from model output, memory or an unverified secondary source. Record how each number was verified against the primary text.

## 3. Rule logic placeholders
- Inputs (name, unit, specimen/context, allowed unit conversions): `[WRITE]`
- Threshold(s) / criteria: `[THRESHOLD — FROM CITED SOURCE ONLY]`
- Comparator and rounding rules, boundary inclusivity: `[WRITE]`
- Reference-range handling (lab-specific vs population): `[WRITE]`
- Output categories (descriptive wording only; no diagnosis): `[WRITE]`
- `insufficient_data` / `not_comparable` conditions: `[WRITE]`

## 4. Boundary and adversarial cases (written BEFORE implementation review, expected outputs written by the clinical owner)
| Case | Inputs | Expected output | Why this case |
|---|---|---|---|
| value exactly at each limit (±ε) | | | |
| missing unit / contradictory units | | | |
| duplicated or conflicting observations | | | |
| out-of-population case | | | |
| reviewer-chosen case(s) | | | |

## 5. Explanation wording (reviewer-facing; draft)
Plain, non-diagnostic wording; states uncertainty and what is NOT concluded; includes the source citation; reviewed for prohibited claims. `[WRITE]`

## 6. Monitoring after release (pre-declared)
Review cadence, signals that trigger review (confirmed harmful output, source-guideline change, unexpected failure rate), who reviews, how results are recorded. `[WRITE]`

## 7. Rollback
Rollback trigger(s), the person who may invoke it, how the register marks the version withdrawn, how outputs produced under it are identified. `[WRITE]`

## 8. Release evidence checklist (tick only with a linked document)
- [ ] Source verification record  - [ ] Boundary-case table written by the clinical owner  - [ ] Evaluation plan and acceptance criteria dated before results
- [ ] Evaluation results summary ([template](08-validation-result-summary.template.md))  - [ ] Failures and dispositions  - [ ] Independent review completed
- [ ] Approver's own signed record exists (location): ______  - [ ] Register entry prepared in the same change as the rule  - [ ] Second person confirmed the record exists

## 9. Clinical lead decision, rationale, source, date and signature reference
_(blank)_

## 10. Independent review _(separate; blank)_
_(blank)_
