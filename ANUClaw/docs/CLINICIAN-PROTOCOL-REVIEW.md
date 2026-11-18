# Clinician protocol review (DRAFT)

**Written for a clinician reviewing this product before any real study.** The product owner is treated as the self-attested clinical lead for drafting; no credential is verified, no role-holder is assigned, and nothing here approves, releases or validates anything. **Status of the whole product: synthetic-only, clinically unvalidated, production-blocked.** Decisions awaiting you: [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md). Evidence table: [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md).

## 1. Workflows in plain terms

| Workflow | What it does | Implemented | Synthetic-only | Unvalidated | Blocked | Awaiting clinician decision |
|---|---|---|---|---|---|---|
| **Report upload → OCR → confirmation → draft report → review → export** | turns a lab report into candidate values that a person confirms or corrects, then drafts a structured and a plain-language summary that a licensed clinician reviews | yes (local, real OCR on synthetic pages) | yes — no real report has been processed | OCR accuracy, summary faithfulness | real reports, real review users, production | severity categories, unit policy, flag threshold, intended use (CL-01–CL-04) |
| **Clinical rules** | applies only rules a clinician has released, to confirmed values | engine and release register | no rule exists | all | releasing any rule | source selection and release criteria (CL-05) |
| **Posture analysis** | estimates posture metrics from a recording with uncertainty and refuses poor recordings | tooling for synthetic drawn fixtures; product pipeline exists | yes — no real person or video | all accuracy | any human recording | metric definitions, exclusions, reference method (CL-06) |
| **Physiological monitoring** | shows device readings with separate "when measured" and "when received" ages; simulation-only alerts | model and synthetic scenarios | yes — no real device | all | real devices, real alerts | freshness windows, escalation boundaries (CL-07) |
| **AIKosh data** | local evaluation sets and reference data | inventory, registry, local benchmarks | unknown provenance — treated as unverified | all | every external use (RAG, embeddings, prompts, fine-tuning, clinical evidence) | permitted uses and sensitivity (CL-08) |
| **Report generation** | structured draft + plain-language summary from confirmed data | yes | synthetic data only | all | release to patients | wording standards, prohibited-claim list (CL-01) |

## 2. What must stay draft-only, and what needs cited source review
- **Model output is always a draft.** Anything a model or OCR engine produces (extracted values, summaries, explanations, retrieved text) is a candidate for human confirmation. It is never a result, a threshold, an interpretation or advice until a person confirms it against the source document.
- **Numbers in a report come only from confirmed observations.** The product enforces this; the study checks it on real reports.
- **Deterministic rules need cited source review.** A rule's criteria must come from a named primary source verified by the clinical owner, never from model output or memory; each rule has an owner, population, exclusions, boundary cases, versioning and rollback ([CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md)). None is released. Template: [14-rule-dossier-draft.template.md](../validation/templates/14-rule-dossier-draft.template.md).
- **Safety rules outrank model output.** A symptom report or contraindication pauses the session regardless of model confidence.
- **Unmeasurable means unsupported, not guessed.** If quality, scale or identity is insufficient the system must say so and withhold corrective cues.
- **Monitoring values are shown as "current" only if both measurement and receipt are fresh;** delayed, stale or untrusted values are never presented as live. Alerts are simulation-only.
- **Reviewer sign-off exists only in the dashboard for a provisioned clinician account;** the API cannot sign off, and no function accepts or releases a study.

## 3. Checklist: reviewing the validation protocols before a real study begins
Tick only with a linked document. This checklist is for the reviewer; it is not a control in the software.

**Common**
- [ ] Signed intended-use / non-intended-use statement exists (CL-01) and the protocols match it
- [ ] Population, setting and exclusions defined (CL-02); consent text and recruitment strata follow from them
- [ ] Ethics/IRB approval reference, data-use agreements and DPAs on file; no real data before they exist
- [ ] Acceptance criteria, tolerances, stopping rules and sample size set by you and an independent statistician BEFORE data collection (CL-09)
- [ ] Roles named by the organisation (not by this software); independent reviewer has no conflict
- [ ] Frozen system manifest (image ID, model/config/environment hashes) recorded; changes go through change control
- [ ] Locked-set custodian named; lock digest recorded somewhere outside the study system
- [ ] Production storage, authentication and security review exist (the synthetic adapter must not hold real data)

**OCR** — categories and report types representative; two independent blinded annotators plus adjudicator; severity labels fixed in advance; unit table and flag policy decided (CL-03/04); silent-error reporting understood; locked-set looks counted.
**Posture** — metrics precisely defined; independent reference method with its own uncertainty; acquisition SOP and demographic strata; quality-gate and fabricated-measurement criteria stated; adverse-event and symptom handling defined; no inference from drawn or mannequin results.
**Monitoring** — freshness window per parameter justified (CL-07); delayed-data presentation reviewed; escalation owners and fallback defined with the operational team; real alerts remain disabled; device reliability scenarios agreed.
**AIKosh** — provenance, licence, consent and de-identification evidence recorded by a data steward; sensitivity classes chosen; second-person registry approval; no external provider without a DPA; narrative fields released only by name.
**Reports** — wording standards and prohibited-claims list approved; plain-language summary comprehension testing planned; draft/reviewed labelling confirmed in exports.

## 4. What this review does NOT establish
Nothing here shows that any component is accurate or safe on real people, reports or devices. Passing a checklist item shows a document exists, not that its content is correct.
