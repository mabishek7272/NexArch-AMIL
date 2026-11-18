# ANUClaw — release-candidate handoff (2026-11-17)

**Status: a local engineering release candidate. It is NOT clinically validated, NOT approved for clinical use and NOT production-ready.** Evidence level L5 (production readiness) was not reached anywhere; see [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md) for the level of every capability. All testing used synthetic data (public records for the science connectors).

## 1. What works locally, and the evidence

| Capability | Evidence |
|---|---|
| Document → OCR → confirmation/correction → snapshot → stored engine run → draft report → clinician review → HTML/PDF export with content hashes | [acceptance-rehearsal-latest.json](evidence/acceptance-rehearsal-latest.json) (5/5; `src/acceptance-rehearsal-pg.test.ts`) |
| Real local OCR (PaddleOCR 3.7) on a scanned page, confidence kept per page | same rehearsal, step 1 |
| BaaS `/v1` API, tenant isolation, OpenAPI contract (29 paths, validates) | `src/api/routes/baas-v1-pg.test.ts`; [openapi-v1.json](openapi-v1.json) |
| Public scientific data (AlphaFold DB, RCSB, NCBI Datasets, GEO): provenance, immutable cache, workspaces, manifests, offline replay | [SCIENCE-DATA.md](SCIENCE-DATA.md); `docs/evidence/science-*.json` |
| Full agent container image and tool tests | [CONTAINER-CONTRACT.md](CONTAINER-CONTRACT.md); [repro-manifest.json](evidence/repro-manifest.json) |
| Safety state machine, claims lint, spend ledger, monitoring, validation tools | [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md), [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md) |

Latest regression (task 72): `tsc --noEmit` rc 0; PostgreSQL suite 89 files / 1128 passed / 52 skipped (opt-in); container suite + rehearsal with the image and OCR service 38 passed / 1 skipped; `eslint src` 0 errors (303 warnings); dashboard build OK. Older counts in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) are history and marked superseded.

## 2. What kind of evidence each result is

| Kind | Items |
|---|---|
| **Real services, synthetic data** | PostgreSQL 17 (disposable); PaddleOCR service; Docker with the full image; real `claude` CLI **startup** and real CLI with a **fake key** against a local capture server (no model reached); bounded live fetches from the four public providers |
| **Test doubles** | Agent CLI double (`container/contract/fake-claude.js`) for the contract suite and the `runAgent` application-path job; provider mocks for connector logic; PosturePulse client mocks |
| **Replayed artifacts** | RCSB 4HHB, AlphaFold P69905, NCBI GCF_000819615.1 — offline, hash-verified, stored as `replay_of_live_artifact`; not fresh live retrievals |
| **Synthetic fixtures** | Lab-report PDFs, tool fixtures (SAM, BED, FASTA, FASTQ, VCF, SMILES), synthetic GEO series matrix, fixture clinician account |

## 3. Core image (`anuclaw-agent:latest`, id `96ce5ee9afe3`, linux/arm64, 12.3 GB)

Ubuntu 24.04, Python 3.12 hash-locked wheels (362 distributions, CPU torch). Tool versions and hashes: [repro-manifest.json](evidence/repro-manifest.json).
- **Executed on fixtures:** samtools, blastn, bedtools, Python (RDKit, SciPy, pandas), obabel, node, claude (startup only), GATK 4.5.0.0, vina, fastqc, bcftools, minimap2, snakemake 9.27.2 (dry-run), nextflow 26.10.6 (one-process workflow).
- **GATK integrity:** the recorded SHA-256 is a **local consistency check**, not publisher-authenticated (GATK publishes no checksum).
- Not hash-locked: the snakemake venv. Base images are tags, not digests. No registry digest (never pushed).

## 4. Known failure

- **PyMOL does not work on Python 3.12** (`No module named 'imp'`). Pinned by a test; not fixed. Nextflow additionally needs a writable working directory (fails from `/workspace`).

## 5. Explicit boundaries

- **Authenticated Claude-agent execution was NOT run.** The test (`L-c`) is disabled; no paid model call was made. Nothing shows that a Claude agent drives the container tools.
- **Optional-tools image NOT built** (`container/Dockerfile.optional`; nine tools incl. `hail`, which the first lock had installed only as an empty placeholder).
- **GEO live replay pending.** The real GSE2 bytes were never retained; a fresh request is recorded in [PENDING.json](evidence/live-artifacts/PENDING.json). The live-download allowance (20 files / 100 MiB) is used up and was not reset.
- **Signed-export proposal is UNAPPLIED** ([proposal](proposals/posturepulse-signed-export.md)). It does not establish upstream-wide patient isolation.
- **No clinical validation, no released clinical rules, no approved modules.** The review in the rehearsal used a **test-fixture clinician**; it approves nothing. Engines report `no_released_rules`.
- No deployment, no credential/.env changes.

## 6. Commands

```bash
# start (details: docs/RUNBOOK-local.md)
npm install && npm run check:config
npm run build && npm --prefix dashboard install && npm --prefix dashboard run build
npm run start:dashboard        # or: npm run start:api   (both need PostgreSQL)
.venv-ocr/bin/python -I ocr_server.py   # OCR service (OCR_PORT=54001)

# regression
export PGURL=postgres://USER:PASS@127.0.0.1:PORT/postgres   # DISPOSABLE server only
npx tsc --noEmit && npx eslint src
ANUCLAW_TEST_PG_URL=$PGURL npx vitest run
npm run openapi:v1

# container suite + acceptance rehearsal (needs the image and the OCR service)
docker build -t anuclaw-agent:contract-test -f container/Dockerfile container && docker tag anuclaw-agent:contract-test anuclaw-agent:latest
docker build -t anuclaw-agent-contract-overlay:latest -f container/Dockerfile.contract-overlay container
ANUCLAW_TEST_PG_URL=$PGURL ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:54001 ANUCLAW_CONTAINER_TESTS=1 \
  ANUCLAW_CONTRACT_IMAGE=anuclaw-agent-contract-overlay:latest ANUCLAW_CLI_IMAGE=anuclaw-agent:latest \
  npx vitest run src/container-contract.test.ts src/acceptance-rehearsal-pg.test.ts
npx tsx scripts/repro-manifest.ts            # regenerates the reproducibility manifest
npx tsx scripts/check-doc-links.ts           # documentation link check
```

## 7. Human decisions required before production use

| # | Decision | Recommended |
|---|---|---|
| 1 | Enable authenticated Claude-agent execution? | **Keep disabled** until provider-side spend controls exist |
| 2 | PyMOL | **Remove from the core image**; keep as a future optional tool |
| 3 | GSE2 live retrieval | **Leave pending** unless an additional download is explicitly approved |
| 4 | Signed export for PosturePulse | **Require upstream review** before applying the diff |
| 5 | Optional-tools image | Build only if a concrete need appears |
| 6 | Clinical use | **Require clinical approval and real validation** (annotated OCR set, agreement study, device validation, released rules) first |
| 7 | Provider spend cap and production hardening (secrets, deployment, support, agreements) | Set a provider-side key limit before any paid run; treat L5 work as not started |

## 8. Next milestone: validation and production planning (drafts, nothing approved)

- [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) — intended / non-intended use and the OCR, extraction/summary, rules, posture, device, usability and privacy study designs, statistical plan, stopping criteria. Acceptance numbers are deliberately left **[SET BY PROTOCOL OWNER]**.
- [validation templates](../validation/templates/README.md) — eight blank templates (protocol approval, consent/de-identification, OCR annotation, rule dossier, posture annotation, device/adverse-event log, change control, result summary).
- [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md) — requirements and go/no-go gates G0–G9, all **not started**.
- [Upstream signed-export review checklist](proposals/posturepulse-upstream-review-checklist.md) — what the PosturePulse owners must approve before the (still unapplied) diff is applied.

Status is unchanged: **clinically unvalidated, production-not-ready.**

## 9. Governance review package (drafts; default no-go)

[GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md) (one-page status and the 17-decision register) · [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md) (milestones M1–M9) · [PRODUCT-STATUS-BRIEF.md](PRODUCT-STATUS-BRIEF.md) (stakeholder brief). The seven decisions in section 7 are a subset of the register (see D02, D03, D05, D06, D07, D08/D15, D14).

## 10. OCR study package (task 73; implemented, synthetic-only, clinically unvalidated)

[Preregistration draft](../validation/protocols/ocr-study-preregistration.md) (approvals blank) and locked-test-set / annotation-quality / workflow tooling (`npm run study:ocr -- …`; [details](VALIDATION-TOOLS.md#ocr-study-tooling-task-73)). No real data, annotators or approvals exist.

## 11. Authenticated OCR-study layer (task 74; implemented, synthetic-only, clinically unvalidated)

API `/api/ocr-study` ([OpenAPI](openapi-ocr-study.json)), dashboard page `/ocr-study`, seven study roles, server-side lock protections, two-person unlock, audit allow-list, fail-closed storage ([details](VALIDATION-TOOLS.md#authenticated-ocr-study-workspace-layer-task-74); [browser evidence](verification-study-ui-latest.json)). Banner on every page and export: "Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval.". Only a synthetic local storage adapter exists; real studies are refused. Commands: `ANUCLAW_TEST_PG_URL=… npx vitest run src/validation/study` and `ANUCLAW_TEST_PG_URL=… npx tsx scripts/verify-study-ui.ts`.

## 12. OCR-study security readiness (task 75; implemented, synthetic-only; real-study and production status BLOCKED)

[Threat model](OCR-STUDY-THREAT-MODEL.md) (no risk marked resolved), member lifecycle with two-person control, re-authentication / CSRF / limits / rate-limit controls, and an object-store contract harness with a test-only fake ([details](VALIDATION-TOOLS.md#security-readiness-controls-for-the-ocr-study-layer-task-75)). Note: report export is now `POST …/export`.

## 13. AIKosh data governance and local evaluation (task 76; implemented, local-only, clinically unvalidated)

[AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md): offline inventory of 20 files, registry with two-person approvals, egress taint guard, six local benchmark adapters, dataset-card and fine-tuning-readiness templates. **All files remain blocked from external processing; no model was fine-tuned, no provider called, nothing approved.**

## 14. Posture and monitoring validation tooling (task 77; implemented, synthetic-only, clinically unvalidated, production-blocked)

[POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md), [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md), blank templates 09–13, preregistration draft with blank approvals. Commands: `npx vitest run src/validation/pv`, `npm run pv:demo` ([evidence](evidence/pv-synthetic-run-latest.json)). Drawn/mannequin/parametric/simulated response does not prove accuracy on humans or devices; no real video, device or participant exists.

## 15. Clinician decision workspace (task 78; documentation only)

[CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md) · [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md) · [DASHBOARD-CLINICIAN-CHECKLIST.md](DASHBOARD-CLINICIAN-CHECKLIST.md) · [rule dossier draft template](../validation/templates/14-rule-dossier-draft.template.md). Self-attested clinical lead for drafting; no credential verified, no approval, no signature, no threshold, no released rule; no dashboard control added. Product status unchanged.

## 16. OCR study-policy layer (task 80; draft / synthetic-only / clinically unvalidated / production-blocked)

[OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md): one versioned policy record; conflicting 0.85/0.8 defaults removed; real fields unconfigured; activation blocked; policy version recorded in every run. The confidence threshold is an unresolved clinical/statistical decision. Note: evaluation `options` are no longer accepted; thresholds come from the policy.

## 17. Draft OCR policy dashboard, two-person review, readiness report (task 81; draft / synthetic-only / clinically unvalidated / production-blocked)

[OCR-STUDY-POLICY.md](OCR-STUDY-POLICY.md) §7. Dashboard panel inside `/ocr-study`; no activate/approve/accept/release control exists anywhere. Review records external decision/signature references only (never verified); readiness report always `eligibleForActivation: false`.
