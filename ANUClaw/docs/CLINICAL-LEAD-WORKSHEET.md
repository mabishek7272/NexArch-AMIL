# Clinical lead worksheet — decisions awaiting the clinical lead (DRAFT)
> **DRAFT FOR DECISION PREPARATION.** The product owner is treated as the **self-attested** clinical lead for drafting only: no credential is verified, no role-holder is assigned, nothing here is an approval, signature, release or validation. No option is preselected and no clinical threshold, range, source or recommendation is supplied. Product status is unchanged: **synthetic-only, clinically unvalidated, production-blocked.**
Each decision has: context, safe options (none preselected), evidence/source fields, risks and product effects, a blank clinical-lead decision section and a separate blank independent-review section. Companion: [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md). OCR-specific packet: [OCR-PROTOCOL-REVIEW-PACKET.md](OCR-PROTOCOL-REVIEW-PACKET.md); policy fields and the draft-review workflow: [OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) §7. Governance IDs refer to [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md).

**How to use this document:** fill the decision sections in your own controlled record (this file is a worksheet, not the record of authority). Nothing you write here is read by the software. A decision takes effect in the product only through the registry, the release register or the study approvals described in the linked documents.

---

## CL-01 · D01 — Intended use and non-intended use

**Where it sits:** D01 in [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md); [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §1–2

**Plain-language context.** This statement fixes what the software is allowed to be used for. Every study, rule and claim is bounded by it; anything outside it is non-intended use. It decides whether the product is positioned as decision support for qualified review, research/education tooling, or something narrower.

**Safe options (none preselected; you may propose another):**
- [ ] Adopt the proposed 'draft support for qualified review' wording after your edits (record the final text yourself)
- [ ] Narrow to research/education only (no clinical use)
- [ ] Defer (all downstream milestones stay blocked)

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Statement version and who authored it: ______
- Regulatory classification advice reference (D11): ______
- Institutional policy or professional-practice rule relied on: ______

**Risks and downstream product effects.** A wider statement widens every validation obligation and the regulatory pathway; a narrower one limits claims and uses. Marketing, training and UI wording must match it.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-02 · Target population, setting and exclusions

**Where it sits:** [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §1; per-rule populations in each dossier

**Plain-language context.** Defines who the outputs may be used for (age range, conditions, languages), where (clinic, supervised, home), and who is excluded (e.g. emergencies, pregnancy, paediatric, people unable to consent). The product-level population can never be wider than the narrowest enabled module.

**Safe options (none preselected; you may propose another):**
- [ ] State population and exclusions per module and let the product population be their intersection
- [ ] State one product-wide population first and add modules later
- [ ] Defer until the first module is chosen

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Source for each exclusion (guideline, policy, local protocol): ______
- Languages and report formats in scope: ______
- Settings and supervision model: ______

**Risks and downstream product effects.** Exclusions drive quality-gate and `not_comparable` behaviour in rules, consent text, recruitment strata and what the UI must refuse.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-03 · OCR: error-severity categories

**Where it sits:** [ocr-study-preregistration.md](../validation/protocols/ocr-study-preregistration.md) §7; [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md) (severity map)

**Plain-language context.** The tool counts errors by type (value, comparator, unit, reference low/high, page, missed item, extraction failure, extraneous candidate) and leaves severity `unassigned`. Severity labels are yours to define before any results are seen; they are descriptive and cannot accept a study.

**Safe options (none preselected; you may propose another):**
- [ ] Define a small ordered set of severity labels and map each error type to one
- [ ] Map by error type and by analyte class (needs a list of analyte classes)
- [ ] Leave unassigned for the pilot and report counts only

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Rationale for each mapping (what harm a reader could suffer if the error went unnoticed): ______
- Source or local incident-classification scheme used: ______

**Risks and downstream product effects.** Severity labels appear in reports and shape what 'silent error' reporting emphasises; they must be fixed before data are examined to avoid post-hoc adjustment.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-04 · OCR: unit normalization and confidence-review policy

**Where it sits:** [ocr-study-preregistration.md](../validation/protocols/ocr-study-preregistration.md) §6; `normalizeUnit` in the AIKosh lab adapter

**Plain-language context.** Decides which unit spellings count as the same unit (case, micro sign, equivalent expressions) and when a value must be flagged for human review (confidence cut-off, missing unit, comparator, out-of-range). The software's default 0.8 flag threshold is an engineering placeholder.

**Safe options (none preselected; you may propose another):**
- [ ] Maintain an explicit, reviewed unit-equivalence table and treat anything outside it as 'needs review'
- [ ] Treat unit differences as always needing review (no normalization)
- [ ] Defer normalization; keep original units only

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Authoritative unit conventions relied on (e.g. a lab-reporting standard) with version: ______
- Review burden you accept (items flagged per document): ______

**Risks and downstream product effects.** A permissive table risks silently merging different quantities; a strict one raises review load. The flagging threshold changes how many errors are 'silent'.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-05 · Clinical-rule source selection and release criteria

**Where it sits:** [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md); [rule dossier draft template](../validation/templates/14-rule-dossier-draft.template.md)

**Plain-language context.** Before any rule is released you choose the guideline/standard it comes from, who owns it, what evidence is needed to release it, and what makes it roll back. No rule is released today; the engine reports `no_released_rules`.

**Safe options (none preselected; you may propose another):**
- [ ] Start with ONE narrow measurement and its dossier
- [ ] Release no rules; extraction and draft-report tooling only
- [ ] Several modules in parallel (higher review load)

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Named source, version, publisher, licence for each threshold: ______
- Independent reviewer and conflict statement: ______
- Release evidence you require, written before results: ______

**Risks and downstream product effects.** Released rules change outputs shown to reviewers; thresholds are never taken from model output. Each threshold change is a new version and a new approval.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-06 · Posture: metric definitions, acquisition exclusions, reference measurement

**Where it sits:** [posture-validation-preregistration.md](../validation/protocols/posture-validation-preregistration.md) §3–4; [POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md)

**Plain-language context.** Defines exactly what each posture metric means (landmarks, sign convention, units), which recordings are unusable (blur, occlusion, rotation, framing, lighting, multiple people, unknown scale), and which independent reference method the system will be compared against.

**Safe options (none preselected; you may propose another):**
- [ ] Define one or two static metrics precisely before any recording
- [ ] Defer metric definitions until a reference method is chosen
- [ ] Choose the reference method first (equipment, raters), then the metrics it can measure

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Source for each metric definition and for the reference method's own uncertainty: ______
- Acquisition SOP (camera, distance, clothing, lighting): ______

**Risks and downstream product effects.** Definitions decide the quality gate, the failure taxonomy and what a 'measurement' is; vague definitions make agreement results uninterpretable.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-07 · Monitoring: physiological freshness windows, delayed-data handling, simulation alert expectations, escalation boundaries

**Where it sits:** [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md); `src/monitoring/model.ts` (engineering defaults)

**Plain-language context.** Decides how old a reading may be before it stops counting as current, how backlog or delayed data is shown, and what the simulation alert workflow should do (acknowledgement deadline, escalation target). The code's windows are engineering defaults, not clinical choices, and alerts are simulation-only.

**Safe options (none preselected; you may propose another):**
- [ ] Set a freshness window per parameter, with rationale and source
- [ ] Keep engineering defaults for synthetic testing only and decide before any real device
- [ ] Treat all non-current data as 'not current' with no window beyond that

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Source or local policy for each window: ______
- Who must be told, how fast, with what fallback if unacknowledged (operational owner): ______

**Risks and downstream product effects.** Windows change when a value is shown as current; too long can display stale data as live. Escalation boundaries define future real-alert behaviour; none is enabled.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-08 · AIKosh: permitted uses, data sensitivity, external-processing decisions

**Where it sits:** [AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md) §6; D18

**Plain-language context.** Every AIKosh file is blocked from external processing. You may decide, per file and per use, whether local RAG, external embeddings, prompts, fine-tuning or clinical evidence is acceptable once evidence exists. Narrative and identifier fields need explicit release.

**Safe options (none preselected; you may propose another):**
- [ ] Permit local-only use of non-narrative reference data first
- [ ] Keep AIKosh evaluation-only (no product use)
- [ ] Remove AIKosh data

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Provenance and licence documents obtained by the data steward: ______
- Consent and de-identification evidence: ______
- Sensitivity class chosen and why: ______

**Risks and downstream product effects.** Approval needs a second, different person in the registry; external uses also need a signed DPA. Fine-tuning readiness does not itself authorize training.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## CL-09 · Study acceptance criteria, tolerances, stopping criteria, independent review

**Where it sits:** [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §12–13; the three study preregistrations

**Plain-language context.** These numbers and rules are written down BEFORE data are looked at, by the clinical lead with an independent statistician: what level of agreement or error would be acceptable, which failures stop a study immediately, and who reviews independently. The tools never decide acceptance.

**Safe options (none preselected; you may propose another):**
- [ ] Define per-metric acceptance bounds and zero-tolerance safety criteria with the statistician
- [ ] Define stopping rules only (observational study without acceptance claims)
- [ ] Defer until the first protocol is approved

**Evidence / guideline / source fields (to be completed by the clinical lead):**
- Clinical rationale and source for each bound: ______
- Independent reviewer identity/role and conflict statement: ______
- Interim-review plan: ______

**Risks and downstream product effects.** These choices determine sample size, what a result can claim and when a study stops; changing them after seeing data invalidates the result.

### Clinical lead decision, rationale, source, date and signature reference
_(blank — to be completed by the clinical lead in their own controlled record)_

| Item | Entry |
|---|---|
| Decision | |
| Rationale | |
| Source(s) cited (title, version, publisher) | |
| Date | |
| Signature reference (location of the signed record) | |

### Independent review _(separate; blank)_

| Item | Entry |
|---|---|
| Independent reviewer (role) and conflict-of-interest statement | |
| Findings / concerns | |
| Outcome | |
| Date | |
| Signature reference | |

---

## Index of what each decision unlocks

| ID | Unlocks (once YOU decide and the linked process records it) |
|---|---|
| CL-01, CL-02 | all protocols, rule dossiers, consent text, UI wording |
| CL-03, CL-04 | OCR study preregistration §6–§7 and the OCR study configuration (`severityMap`, flag threshold) |
| CL-05 | first rule dossier and the release register entry |
| CL-06 | posture metrics, acquisition SOP, reference method, ethics submission |
| CL-07 | monitoring windows, device scenarios, future alert design |
| CL-08 | AIKosh registry approvals |
| CL-09 | acceptance, tolerances and stopping rules in every study |
