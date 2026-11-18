# Fine-tuning readiness checklist — template

> **BLANK TEMPLATE. PASSING THIS CHECKLIST DOES NOT AUTHORIZE FINE-TUNING, EXTERNAL PROCESSING, OR CLINICAL USE.** It collects the evidence that people must review. Authorization is a separate, signed human decision recorded through the AIKosh registry (two different people) and, for any clinical use, through the clinical release process. No box below may be ticked without a linked document.

Dataset(s) and registry paths: ______ · Target model and provider: ______ · Planned training run owner: ______

| # | Requirement | Evidence (link / reference) | Ticked by (role) | ☐ |
|---|---|---|---|---|
| 1 | **Rights and licence review:** licence text obtained from the publisher; fine-tuning and derivative-model use expressly permitted; attribution/restrictions recorded | | | ☐ |
| 2 | **Consent and de-identification evidence:** consent covers training; de-identification method, reviewer and residual-risk assessment on file; narrative fields reviewed | | | ☐ |
| 3 | **Intended task and population** written and approved; out-of-scope uses listed | | | ☐ |
| 4 | **Completed dataset card** ([template](dataset-card.template.md)); its SHA-256 recorded in the registry approval | | | ☐ |
| 5 | **Split design:** train / validation / held-out test fixed before training, group-wise, assigned by someone independent of the trainers; leakage report attached | | | ☐ |
| 6 | **Contamination checks:** held-out answers absent from training data, prompts and retrieval corpora; overlap with public benchmarks and the base model's likely pre-training data assessed | | | ☐ |
| 7 | **Bias, language and regional-coverage review** with planned subgroup evaluation | | | ☐ |
| 8 | **Clinical-owner approval** of intended use and acceptance criteria (set before results are seen) | | | ☐ |
| 9 | **Privacy approval** (data-protection officer) | | | ☐ |
| 10 | **External-provider data-processing approval:** signed DPA covering purpose limitation, no further training, retention/deletion, location, sub-processors, breach notification | | | ☐ |
| 11 | **Registry approval:** recorded by one authorized person and approved by a DIFFERENT person, for the exact file hashes, with `fine_tuning` permitted | | | ☐ |
| 12 | **Model-change control record** ([template](07-model-provider-change-control.template.md)): base and tuned model identifiers, hashes, data lineage, reproducibility manifest | | | ☐ |
| 13 | **Rollback plan** tested: how to return to the previous model and how to delete the tuned model and training copies | | | ☐ |
| 14 | **Post-training evaluation plan** on the held-out test split and on safety scenarios (silent errors, refusal behaviour, prohibited claims), with criteria fixed in advance; every look at the test set is counted | | | ☐ |
| 15 | **Monitoring and retraining policy:** drift, incident handling, retirement criteria | | | ☐ |

## Statement
Completing this checklist produces evidence for review only. It does **not** grant fine-tuning authority, external-processing authority or any clinical or regulatory status.

## Sign-off (blank)
| Role | Name | Credential / reference | Signature | Date |
|---|---|---|---|---|
| Data steward | | | _(blank)_ | |
| Clinical owner | | | _(blank)_ | |
| Privacy officer | | | _(blank)_ | |
| Security lead | | | _(blank)_ | |
| Accountable executive | | | _(blank)_ | |
