# OCR validation study — preregistration (DRAFT, UNAPPROVED)

**Status: draft for review. It is not approved, no study has started, no real data exists, and nothing here is a result or a claim.** Every item marked **[TO BE SET]** must be decided by the named human role and recorded **before any evaluation data is looked at**; this draft deliberately chooses no acceptance threshold, sample size or severity level. Parent documents: [CLINICAL-VALIDATION-PROTOCOL.md](../../docs/CLINICAL-VALIDATION-PROTOCOL.md) §4, [VALIDATION-TOOLS.md](../../docs/VALIDATION-TOOLS.md). Clinician review packet: [OCR-PROTOCOL-REVIEW-PACKET.md](../../docs/OCR-PROTOCOL-REVIEW-PACKET.md). Tooling that supports it: `scripts/ocr-study.ts` ([implemented, synthetic-only, clinically unvalidated](../../docs/VALIDATION-TOOLS.md#ocr-study-tooling-task-73)).

| Document control | |
|---|---|
| Preregistration ID / version | _blank_ / 0.1-draft |
| Linked approved protocol reference | _blank — none exists_ |
| System under test (frozen manifest ref: image ID, OCR engine, parser, config hashes) | _blank — freeze before the locked set is first evaluated_ |
| Date this document is locked | _blank_ |

## 1. Research question
**RQ1 (primary).** For the report categories in §2, what are the value, unit, reference-interval and page-attribution accuracies of the extraction pipeline — and what fraction of its errors reach a reviewer **without an uncertainty flag** (silent errors) — measured against adjudicated human ground truth?
**RQ2.** How well does the pipeline's reported confidence correspond to correctness (calibration), and how many flagged items does a reviewer have to examine per document at the chosen flagging operating point?
**RQ3.** How often are fields missing (dropped) or invented relative to ground truth?
Hypotheses and the numeric bounds they refer to: **[TO BE SET by protocol owner + statistician]**. No hypothesis is stated here to avoid anchoring.

## 2. Report categories, inclusion and exclusions
- **Intended categories (to be confirmed by the clinical lead; strata and minimum counts [TO BE SET]):** native-text PDFs; scanned PDFs at several resolutions; phone photographs (skew, shadow, glare); multi-page and multi-column layouts; tables with merged cells; reports from each laboratory/vendor template in scope; each language in scope; reports with comparators (`<`, `>`), mixed units, missing reference intervals, flagged/abnormal values, handwritten annotations, and low-quality pages.
- **Inclusion:** reports of the in-scope types obtained under the data-source agreement recorded in the manifest (`origin`), de-identified per §9 before they reach annotators or the system.
- **Exclusions (proposed, clinical lead to confirm):** report types or languages outside the stated scope; pages with no analyte values; documents that cannot be de-identified to the standard in §9; duplicates of the same report; documents where consent or the agreement does not cover this use. Exclusions are listed with counts and reasons in the final report (no silent exclusion).

## 3. Units of analysis
| Unit | Definition | Used for |
|---|---|---|
| **Document** | one source file (opaque case ID `c-…`) | sampling, splits, clustering of errors (documents are the independent units for intervals) |
| **Page** | one page of a document | extraction status (`ok`, `ocr_unavailable`, `unsupported`, partial), page attribution |
| **Field (item)** | one analyte result on one page (analyte, value, comparator, unit, reference low/high) | recall, precision, missing/invented fields |
| **Value** | the printed value (and its numeric form) of a field | value accuracy, silent-error counting |
Statistical intervals must account for clustering of items within documents (§10).

## 4. Ground truth
- **Two independent annotators** per document (assigned per dataset in the manifest; they cannot see each other's work or the system output; the tooling enforces that annotators can import only their own file and cannot read the agreement queue). Annotation guide version/location: **[TO BE SET]**; training and qualification of annotators: **[TO BE SET]**.
- **Annotated fields:** analyte (canonical), value as printed, numeric value, comparator, unit, reference low/high, page. Handling of illegible, ambiguous and handwritten items: **[TO BE SET in the guide]**.
- **Agreement before adjudication:** percent agreement and Cohen's κ for categorical fields (comparator, unit, page); percent agreement and differences for numeric fields with the **protocol-configured tolerance** (default in the tool is exact match; any tolerance **[TO BE SET]** before annotation starts); item-presence agreement.
- **Adjudication:** a third person, not one of the two annotators, resolves every disagreement; both original annotations (with version and file hash) are preserved in an append-only, hash-chained record; an item can be marked **ambiguous** and is then excluded **and listed**. The adjudicator is blind to system output. Adjudicator qualifications **[TO BE SET]**.
- **Revision:** annotation files are versioned (v1, v2, …), never overwritten; a revision invalidates adjudications made against earlier versions (kept on record as stale).
- **Locking:** the adjudicated truth is built only when no disagreement is unresolved, then the dataset is locked; the lock digest is recorded **outside** the study directory (here): **[lock digest recorded at lock time]**.

## 5. Data split plan
| Split | Purpose | Rules |
|---|---|---|
| `development` | build and tune the parser, prompts, OCR settings, flagging threshold, calibration | may be evaluated repeatedly (development runs write only to `outputs/`); never reused as validation data |
| `locked_validation` | the primary validation evaluation | documents assigned **before** development begins, by someone independent of the developers; locked with a recorded digest; **no development runs allowed on it** (the tool refuses); every evaluation is counted and reported, with the changes made between looks |
| `external_validation` (future) | a second site / time period / vendor mix | collected under a separate agreement after the system is frozen; locked the same way; not available until a separate approval |
Assignment method, stratification and split proportions: **[TO BE SET]**. Documents from the same patient, report or template batch must not straddle splits **[rule to be confirmed]**. The flagging threshold and all configuration are chosen on `development` only and frozen before the first locked evaluation.

## 6. Metrics (all reported with intervals and n; none is pass/fail in the tooling)
- **Value accuracy** (printed value and numeric value), **comparator accuracy**, **unit accuracy** (after unit normalisation rules **[TO BE SET]**), **reference-interval accuracy** (low and high separately), **page attribution accuracy** — among matched items.
- **Recall** (all, and excluding items on pages that failed extraction) and **precision** (note: unannotated candidates count as false positives, which understates precision if annotation is incomplete).
- **Missing fields:** truth has a value but the candidate is empty (per field); **invented fields:** truth empty but candidate has a value; **false positives:** extraneous candidates; **missed items** and **extraction failures** by page status.
- **Silent errors:** wrong fields on matched items with no uncertainty flag (`flags` empty and confidence above the flag threshold) — the primary safety metric, reported as a count with its upper confidence bound and listed item by item.
- **Confidence calibration:** reliability by confidence bin (bin scheme **[TO BE SET]**), expected calibration error with interval, items without a confidence, and review burden (flagged items per document).
- **End-to-end after human confirmation** (residual errors in confirmed observations) is a separate study arm, **[TO BE SET]**.
- Per-stratum results are reported alongside pooled results; a pooled result may not hide a failing pre-declared stratum.

## 7. Error taxonomy and failure handling
Error **types** are recorded by the tool; **severity levels are assigned by the clinical lead** (the tool reports `unassigned` unless a severity map is supplied) **before** results are seen.
| Error type | Description | Severity [TO BE ASSIGNED by clinical lead] |
|---|---|---|
| value | printed value wrong | |
| comparator | `<`/`>` wrong or missing | |
| unit | unit wrong or missing/invented | |
| refLow / refHigh | reference interval wrong | |
| page | attributed to the wrong page | |
| missed_item | value on a page that extracted ok but not extracted | |
| extraction_failure | page failed OCR/extraction (status recorded) | |
| extraneous_candidate | candidate with no ground-truth item | |
Each **silent** error and each failed page receives a root-cause category (image quality, layout, unit parsing, analyte normalisation, engine error) and a disposition (fix and re-test on **new** data; restrict intended use; accept with mitigation). Fixes made after a locked look require a **new** locked set for confirmation. Protocol deviations and unexpected failures are logged with date and decision-maker.
**Failure handling in analysis:** failures are counted as failures, never dropped; unreadable documents are reported with reasons.

## 8. Statistical-analysis placeholders

> Every value named below is a field of the OCR study-policy record ([OCR-STUDY-POLICY.md](../../docs/OCR-STUDY-POLICY.md)); each is `unconfigured` until the clinical lead and statistician supply it with a source reference. The **OCR confidence threshold is an unresolved clinical/statistical decision, not an engineering default.** The policy version in force is recorded in every run and report.
 (independent statistician to complete before data collection)
Estimands and analysis population **[TO BE SET]**; primary endpoint(s) **[TO BE SET]**; acceptance bound(s) per metric **[TO BE SET by clinical lead]**; interval method and clustering by document (e.g. cluster bootstrap) **[TO BE SET]**; sample-size derivation (assumptions, expected performance, clustering, sensitivity analysis) **[TO BE SET]**; multiplicity and subgroup plan **[TO BE SET]**; missing-data handling **[TO BE SET]**; interim looks and stopping rules **[TO BE SET]**; handling of repeated looks at the locked set **[TO BE SET]**. The tool's built-in minimums (300 truth items / 30 documents) are **placeholders** and must be replaced by the protocol's numbers (`--options` file: `minTruthItems`, `minDocuments`, `lowConfidenceThreshold`, `calibrationBins`, `severityMap`). **No performance claim, threshold or sample size is stated in this document.**

## 9. Privacy, de-identification, retention, access control and audit
- **Lawful basis and approvals** (ethics/institutional approval reference, data-use agreement, consent where required): **[TO BE SET]** — required before any real document is registered. Human-annotated datasets cannot be registered without a protocol reference.
- **De-identification:** method, tool and version, free-text and image checks (names, IDs, dates, addresses, barcodes, faces, labels, metadata, file names), second-person sample review, residual-risk assessment — recorded in the **attestation** (a human-supplied record; the tool records and hashes it but cannot verify it). Annotators and the system receive only de-identified material unless the approved protocol states otherwise. Opaque case IDs carry no original file names.
- **No external provider** receives study documents unless a signed data-processing agreement covers it (see [PRODUCTION-READINESS-PLAN.md](../../docs/PRODUCTION-READINESS-PLAN.md) §5).
- **Storage and access:** study root outside the repository (`--root` is mandatory; no default), encrypted storage, owner-only permissions, scope/workspace isolation (other scopes and non-members get "not found"), role separation (owner / annotator / adjudicator / analyst), annotators blind to each other. Access list and periodic review: **[TO BE SET]**.
- **Audit:** every action is recorded in a hash-chained audit log (ids and hashes only, never document content) and refusals are logged per scope; the log is retained for **[TO BE SET]**. Limitation: the local CLI trusts the asserted user id; a multi-user deployment needs authentication in front.
- **Retention and destruction:** retention period per data class, destruction method and certificate, handling of participant withdrawal and backups: **[TO BE SET]**.
- **Incident/breach procedure and contacts:** **[TO BE SET]**.

## 10. Reporting
The locked evaluation report is exported with its provenance (manifest hash, lock digest, split, annotation and truth versions, adjudication head hash, results hash, system version, options, run counts, whether the lock was ever reopened). It states `clinicalAcceptance: not_assessed_by_this_tool`. Any acceptance statement is written separately by the clinical lead in the [validation-result summary](../templates/08-validation-result-summary.template.md) against the criteria above.

## 11. Approvals (all blank; no approval exists)
| Role | Name | Credential / reference | Decision | Signature | Date |
|---|---|---|---|---|---|
| Protocol owner | | | | _(blank)_ | |
| Independent statistician | | | | _(blank)_ | |
| Privacy / data-protection officer | | | | _(blank)_ | |
| Clinical lead | | | | _(blank)_ | |
