# AIKosh data governance and local evaluation (task 76)

**Status: implemented, local-only, synthetic-or-unknown-provenance data, clinically unvalidated.** Nothing here approves any AIKosh file for external processing, trains or fine-tunes any model, calls any provider, or validates any dataset or system clinically. Every file is **"unknown — blocked from external processing"** until a person records evidence and a *different* person approves it. Related: [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md) (D18), [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md), [openapi-aikosh.json](openapi-aikosh.json), [dataset card template](../validation/templates/dataset-card.template.md), [fine-tuning readiness checklist](../validation/templates/finetuning-readiness-checklist.template.md).

## 1. What was done to the data
`scripts/aikosh-inventory.sh` runs `scripts/aikosh-inventory.py` **inside the local agent image with networking disabled, a read-only root filesystem and the data mounted read-only**. It hashes every file, reads schemas and counts, and records heuristic personal-data indicators (column-name hints and aggregate pattern counts on a sample). It prints no record values. Output: [governance/aikosh/inventory.generated.json](../governance/aikosh/inventory.generated.json). The data directory itself was never modified or uploaded.

## 2. Inventory (20 files, 208 MB)

| File | Format | Bytes | Rows / records | SHA-256 | Narrative-like columns (heuristic) | Licence / consent / de-identification / external processing |
|---|---|---|---|---|---|---|
| `clinical_eval/indian_protocols_clinical_qna.csv` | csv | 1,430,253 | 504 | `f54010327d1f…` | query_rubrics, answer_rubrics, patient_case | unknown — blocked |
| `clinical_eval/indian_protocols_clinical_qna.parquet` | parquet | 484,678 | 504 | `5b75b5f6918d…` | query_rubrics, answer_rubrics, patient_case | unknown — blocked |
| `clinical_eval/medical_calculator_eval.csv` | csv | 1,319,982 | 1066 | `c83d5301ae1b…` | question_text, confinement_instruction, expected_output | unknown — blocked |
| `clinical_eval/medical_calculator_eval.parquet` | parquet | 390,427 | 1066 | `56b097b53a66…` | question_text, confinement_instruction, expected_output | unknown — blocked |
| `clinical_eval/medmcqa_indic_en.csv` | csv | 2,126,544 | 4183 | `23b417dbc723…` | exp | unknown — blocked |
| `clinical_eval/medmcqa_indic_en.parquet` | parquet | 1,428,423 | 4183 | `a14a5a81a929…` | exp | unknown — blocked |
| `knowledge_graph/bodhi_m_nl_facts.jsonl` | jsonl | 340,181 | 3566 | `006100efc268…` | — | unknown — blocked |
| `knowledge_graph/bodhi_m_triples.jsonl` | jsonl | 528,595 | 3566 | `5fca934e9d74…` | — | unknown — blocked |
| `knowledge_graph/bodhi_s_nl_facts.jsonl` | jsonl | 1,370,405 | 13204 | `f4c250487e5f…` | — | unknown — blocked |
| `knowledge_graph/bodhi_s_triples.jsonl` | jsonl | 3,174,110 | 13204 | `2f3f78cebac5…` | — | unknown — blocked |
| `lab/nidaankosha_lab_readings_sample.csv` | csv | 1,462,880 | 15000 | `42a013896a78…` | — | unknown — blocked |
| `lab/nidaankosha_lab_readings_sample.json` | json | 260,251 | 1000 | `6cd03aa22e6f…` | — | unknown — blocked |
| `lab/nidaankosha_part1.parquet` | parquet | 87,839,466 | 3422152 | `a55637e03e59…` | — | unknown — blocked |
| `lab/nidaankosha_part2.parquet` | parquet | 87,777,017 | 3422152 | `178bccdcbb56…` | — | unknown — blocked |
| `pathology/icmr_pathology_cohorts.json` | json | 1,573 | — | `7ebf8c4a49e0…` | key_features | unknown — blocked |
| `pathology/sample_pathology_cases.json` | json | 2,257 | 2 | `e51efea84074…` | microscopic_examination | unknown — blocked |
| `pharmacology/eka_nfi_drug_pharmacology.csv` | csv | 517,934 | 925 | `b7658e28c062…` | explanation | unknown — blocked |
| `pharmacology/eka_nfi_drug_pharmacology.parquet` | parquet | 172,047 | 925 | `c26460db8303…` | explanation | unknown — blocked |
| `pharmacology/indian_drug_brand_salts.csv` | csv | 572,386 | 1512 | `49f4fa5fb2ad…` | — | unknown — blocked |
| `pharmacology/indian_drug_brand_salts.parquet` | parquet | 220,199 | 1512 | `a39b94a52f48…` | — | unknown — blocked |

Licence, consent, de-identification and external-processing status are **unknown for every file** (no licence text, consent record or provenance document exists in the directory). "Domain" and "likely purpose" in the registry are inferred only from file and column names ([catalog.ts](../src/aikosh/catalog.ts)); they are not provenance.

### Findings a reviewer should know
- **Personal-data indicators are heuristics.** Column-name hints (e.g. `test_name`, `medication_name`) and number patterns that resemble phone/Aadhaar/PIN codes appear in clinical numbers; many are false positives. Absence of an indicator proves nothing. The lab files carry `document_id`, `age` and `gender` (quasi-identifiers) and the pathology sample carries narrative text (`clinical_history`, `gross_description`, `microscopic_examination`) with an age/sex/habit history: **treated as restricted by default**, blocked from external providers, and registered with an egress taint guard when read.
- **CSV and parquet copies:** five CSV/parquet pairs have equal row counts and column lists; byte-level equivalence is **not** verified.
- **Lab:** `part1` and `part2` each report 3,422,152 rows; overlap between them is unchecked; the 15,000-row CSV sample and the 1,000-row JSON sample relate to the full set in unknown ways. The TypeScript adapters read only the CSV sample.
- **Calculator benchmark:** `tolerance` is not documented as absolute or relative (treated as absolute, flagged as an unverified assumption); `expected_output` is a JSON object whose key is named by `primary_field`.
- **MedMCQA:** the file is named "indic" but only `language = en` rows were observed.
- **Pathology cohorts JSON** is a catalogue of cohorts held elsewhere (metadata), not patient records; **sample cases** hold only 2 records.
- **Knowledge graph:** the NL-facts files align by count with the triples files, but the alignment is unverified, so triples are not used.

## 3. Registry and approval workflow
- **Tables (PostgreSQL):** `aikosh_files` (inventory snapshots keyed by path + SHA-256), `aikosh_approval_records` (immutable proposals with a content hash), `aikosh_approval_decisions` (append-only, hash-chained approve/revoke). Database triggers refuse UPDATE, DELETE and TRUNCATE on all three.
- **Workflow:** an admin or compliance user records provenance, licence (name + reference + the uses it permits), permitted uses, sensitivity (`unknown` cannot be approved), and for external uses the DPA reference, `externalProcessing = approved`, a non-identifiable sensitivity, and consent/de-identification references (fine-tuning also needs a dataset-card hash; clinical evidence needs a named clinical owner). **A different** admin/compliance user must approve. Approval applies only to the exact SHA-256 it names; changed bytes, a revoked or unapproved record, or a tampered record all fail closed. Revocation is permanent.
- **Narrative and identifier-like fields** stay blocked from external uses even under an approval unless the approval releases them by name.
- **Local deterministic tests and local-only evaluation need no approval** (they call nothing external and claim nothing); they still verify the file hash on every read.
- **Egress safety net:** values read from restricted columns of files not approved for external use are registered in a process-local taint registry; `prepareForEgress` and `modelCall` refuse any outgoing text containing them (all data classes). This is a safety net, not de-identification: paraphrases and short fragments are not caught.
- **API / UI:** `/api/aikosh` ([OpenAPI](openapi-aikosh.json), 6 operations) and the dashboard page `/aikosh`. Roles come from the session; bodies carrying identity or role are refused; audit rows hold paths, hashes and counts only.
- **Not implemented:** reading parquet in TypeScript, automatic licence detection, any external RAG/embedding/fine-tuning pipeline (none exists, by design).

## 4. Local evaluation adapters (`npm run aikosh:eval -- <name> --split dev`)
All run offline with trivial deterministic baselines to exercise the harness; **none computes or implies a clinical score** (every report states `clinicalScore: not_computed_and_not_claimed`).

| Adapter | Source | Split group | Notes |
|---|---|---|---|
| `calculator` | medical_calculator_eval.csv | calculator family | numeric answer within tolerance; baseline = train median |
| `medmcqa` | medmcqa_indic_en.csv | question text | rows with integrity flags excluded; explanation never an input |
| `pharmacology_mcq` | eka_nfi_drug_pharmacology.csv | question text | single-letter answers only |
| `drug_brand` | indian_drug_brand_salts.csv | generic name | generic/brand metadata never an input |
| `lab` | nidaankosha sample CSV | document_id | test-name → LOINC normalization; abstains on unseen names; duplicate inputs across splits are counted, and label regularity inflates a lookup baseline |
| `kg_s` / `kg_m` | bodhi NL-facts | query text | retrieval of supporting facts (BM25); the supporting fact is the retrieval target by design; no generation prompt is built |
| `pathology` | **synthetic** seeded generator | case | the 2 real sample cases are used only for a descriptive coverage check; no real record is scored |
| `protocols` | indian_protocols_clinical_qna.csv | — | rubric-graded; loaded and structurally checked only; no judge is called |

**Separation and contamination controls:** deterministic salted-hash group splits (70/10/20 are engineering placeholders); `assertNoSplitLeakage` (groups, ids, identical inputs); predictors receive only train data in `fit` and frozen, gold-free inputs in `predict`; the runner refuses train evaluation, requires `final: true` for the held-out test split and counts every final look; a benchmark whose input contains its gold answer is refused; `buildContext` admits only train items and rejects any context containing a held-out gold answer or input.

## 5. How to run
```bash
scripts/aikosh-inventory.sh                        # offline inventory via the local image (network disabled)
npm run aikosh:eval -- lab --split dev             # local benchmark (no approval needed)
npm run openapi:aikosh                             # regenerate docs/openapi-aikosh.json
npx vitest run src/aikosh                          # unit tests; add ANUCLAW_TEST_PG_URL=… for registry/route tests
```

## 6. Human evidence required before ANY AIKosh component may be used for external RAG, embeddings, prompts or fine-tuning
For each file (by exact SHA-256), recorded by one authorized person and approved by a different one:
1. **Provenance** — who produced the data, when, how, under which programme (for the pathology and lab files, the ICMR/IndiaAI or institutional source and its data-use terms), and whether the copies here are complete and unmodified.
2. **Licence** — the actual licence text from the publisher, with the uses it permits (RAG, external embedding, prompting external models, fine-tuning, redistribution, commercial use). Absence of a licence means no external use.
3. **Consent / lawful basis** and **de-identification evidence** (method, reviewer, residual-risk assessment), covering narrative fields, `document_id`, age and gender in the lab files, and all pathology narratives.
4. **Sensitivity classification** by a person (`public_reference` or `deidentified` for any external use; narrative/identifier fields released only by explicit name).
5. **A signed data-processing agreement** with every external provider that would receive the content (purpose limitation, no training on data, retention/deletion, location, sub-processors, breach notice).
6. **Permitted uses** chosen explicitly (one approval per use set); for **fine-tuning** additionally a completed dataset card and [readiness checklist](../validation/templates/finetuning-readiness-checklist.template.md) (rights, consent, split and contamination evidence, bias/language/regional review, clinical-owner and privacy approval, provider approval, model-change control, rollback, post-training evaluation) — **passing the checklist does not itself authorize fine-tuning or clinical use**; for **clinical evidence** a named clinical owner and the clinical release process in [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md).
7. **Duplicates and contamination assessment** against public benchmarks and the target model's likely pre-training data, and a held-out split assigned by someone independent of the trainers.
