# Dataset card — template

> **BLANK TEMPLATE.** Contains no evidence, approvals or signatures. Complete one card per dataset (file set) before any use beyond local deterministic tests. A completed card is **evidence for review**; it does not approve anything. Record its SHA-256 in the registry approval (`datasetCardSha256`).

| Field | Entry |
|---|---|
| Dataset name and registry path(s) | |
| File SHA-256 values (from the inventory) | |
| Version / retrieval date | |
| Publisher / originating institution | |
| Intended task(s) | |
| Intended population, setting, language(s), region(s) | |
| Out-of-scope uses | |

## 1. Rights and licence
- Licence name and text/reference: ______  · Source of the licence statement (URL or document, not assumed): ______
- Uses the licence permits (tick only if stated): [ ] local evaluation [ ] RAG [ ] embeddings via an external provider [ ] prompts to external models [ ] fine-tuning [ ] redistribution [ ] commercial use
- Attribution / share-alike / non-commercial restrictions: ______  · Reviewed by (role) and date: ______

## 2. Consent, de-identification and sensitivity
- Consent basis and reference: ______  · Does the consent cover model training / external processing? ______
- De-identification method, tool and version, reviewer, residual-risk assessment (reference): ______
- Direct or quasi-identifiers found by the reviewer (name, ids, dates, location, free text, rare conditions): ______
- Sensitivity class chosen (public_reference / deidentified / limited / identifiable): ______ · Narrative fields and whether any may be released externally: ______

## 3. Provenance and quality
- How the data were collected / generated / translated; known label-noise or translation issues: ______
- Known duplicates, overlaps with public benchmarks or with other files in this repository: ______
- Relationship between file copies (e.g. CSV vs parquet): ______

## 4. Splits and contamination
- Train / dev / held-out test construction (group key, salt, proportions, who assigned them, date): ______
- Evidence that groups do not straddle splits (`assertNoSplitLeakage` report) and that no held-out answer appears in any prompt, retrieval corpus or training file: ______
- Overlap with the base model's likely pre-training data (public benchmarks): ______

## 5. Bias, language and regional coverage
- Languages and scripts present; code-mixing; regions and facilities represented; age/sex distribution; conditions under-represented: ______
- Planned subgroup reporting and what would count as a coverage gap: ______

## 6. Limitations and risks
______

## 7. Review and sign-off (all blank; none implied)
| Role | Name | Credential / reference | Decision | Signature | Date |
|---|---|---|---|---|---|
| Data steward | | | | _(blank)_ | |
| Clinical owner | | | | _(blank)_ | |
| Privacy / data-protection officer | | | | _(blank)_ | |
