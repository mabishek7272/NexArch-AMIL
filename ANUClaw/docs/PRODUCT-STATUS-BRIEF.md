# Product status brief (stakeholder / investor — 2026-11-17)

**Read this first:** ANUClaw is an engineering release candidate. It has **no clinical validation, no clinical-performance data, no regulatory status, no production deployment and no revenue**, and this brief makes no claim about any of them. Everything described was tested only with synthetic data (plus public records for the science connectors). Evidence detail: [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md); decisions: [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md).

## Vision
A clinician-supervised assistant that turns clinical documents, measurements and monitoring data into traceable, reviewable drafts — with every value tied to its source, every safety rule outranking any model output, and a licensed human deciding what is released. The aim is to reduce transcription and review burden, **not** to diagnose or decide.

## Current technical capabilities and evidence level

Levels: **L1** implemented with automated tests on fakes/disposable database; **L2** exercised against the real component with synthetic data; **L3** quantitative evaluation on synthetic fixtures; **L4** clinical/measurement validation; **L5** production readiness. Nothing is at L4 or L5.

| Capability | Level | Note |
|---|---|---|
| Report upload → OCR → human confirmation → engine run → draft report → clinician-account review → hashed export | **L2** | real local OCR; "clinician" is a test-fixture account |
| OCR/extraction accuracy | **L3 (tool only)** | evaluation tooling exists; no real annotated data |
| Tenant-isolated API (`/v1`), OpenAPI contract | **L1–L2** | |
| Public scientific data (AlphaFold DB, RCSB, NCBI, GEO): provenance, versioning, manifests | **L1 + L2 (bounded live, replay)** | research-only; one GEO artifact pending |
| Agent container with analysis tools | **L2** | tools run on small fixtures; PyMOL fails; `claude` CLI startup only |
| Authenticated AI-agent execution | **not run** | disabled pending spend controls and authorisation |
| Safety state machine; "no fabricated measurement" quality gate | **L1** | software rules, not clinical evidence |
| Posture analysis; device monitoring | **L1 (+L2 synthetic pipeline)** | no real-device or agreement study |
| Clinical decision rules | **none released** | engine reports `no_released_rules` |
| Reproducibility | **L2** | [manifest](evidence/repro-manifest.json): image ID, tool versions, lock hashes |

## Why clinical validation is still required
Software tests show the code does what it was written to do; they do not show that its outputs are accurate or safe on real patients' documents, bodies and devices. OCR can misread a unit or a value; posture estimates can drift with lighting, clothing and angle;
device data arrives late, missing or out of order; and a clinical rule is only as good as its source and owner. Each needs independent ground truth, pre-declared acceptance criteria, uncertainty reporting, ethics approval and clinician sign-off before any statement about
performance or use ([CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md)). Regulatory classification of the intended use also has to be assessed by qualified advisers.

## What is needed next
- **Funding:** for a staged validation programme and production hardening — amount to be determined by the protocol owner and statistician, not estimated here.
- **Partnerships:** clinical sites with ethics approval; clinical owners for rule modules; a data partner for de-identified report corpora; device and reference-measurement partners for posture/monitoring studies.
- **Data:** real, consented or lawfully de-identified reports, recordings and device streams (none held today); provider data-processing agreements.
- **Expertise:** clinical lead, independent biostatistician, regulatory/quality specialist, privacy officer, security/operations engineers, usability researcher.
- **Governance decisions:** the 17 decisions in the decision pack, starting with the intended-use statement.

## Roadmap
Ordered milestones with entry criteria and exit evidence: [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md). The default outcome of the final milestone is **no-go** until evidence exists.
