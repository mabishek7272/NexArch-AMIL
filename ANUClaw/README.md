<div align="center">

# ANUClaw

### An AI research and medical-document assistant — engineering build, not a medical device

**AMGI Research (Abi and Anu)** · MIT licence

</div>

> **Read this first.** ANUClaw is under active engineering. It is **not** a medical device, has **no** clinical
> validation or regulatory clearance, does **not** diagnose, and **no clinical rule or specialty module is approved
> for use**. Outputs are drafts for qualified review. Use **synthetic data only** until the external requirements
> in [docs/ACCEPTANCE-MATRIX.md](docs/ACCEPTANCE-MATRIX.md) are satisfied (provider data-processing terms, clinical
> approvals, container runtime). Earlier versions of this README overstated the product (channel and skill counts,
> compliance badges); those claims have been removed.

## What it is today

A single Node.js/TypeScript process (API on :4000, dashboard on :3722) around three things:

1. **Medical-report workflow** — upload native/scanned/mixed PDFs → page-level extraction (native text + real
   PaddleOCR) → flagged values the user confirms/corrects → hashed snapshot → rules → SOAP + plain-language draft →
   HTML/PDF export → licensed-clinician sign-off → supersession on correction. Also exposed as a tenant-isolated
   REST API with an [OpenAPI contract](docs/openapi-v1.json) (`/v1`).
2. **Guarded model access** — every provider call goes through one transport: hooks, de-identification by data
   class, identity checks, sanitised errors, and a durable **spend ledger** (provider-reported cost only; unknown
   cost is never zero; budgets are admission control, **not** a hard cap on charges).
3. **Adjacent modules** — PosturePulse import with provenance checks, a gated physiological-monitoring model
   (simulation-only alerts), and a governed research workspace (scipy-verified statistics, direct standardisation,
   RDKit descriptors; prediction/biomarker analyses are research-only and gated).
4. **Research Studio** — an autonomous, clinician-independent manuscript/thesis authoring workflow (durable
   task-graph engine, evidence graph with deduplication and claim/support tracking, manuscript authoring with
   bounded critic/revision loops, visuals, and multi-format export). Deterministic and offline-fixture only —
   no model-generated prose, no live AI-provider or browser-account automation. See
   [docs/RESEARCH-STUDIO-RELEASE-HANDOFF.md](docs/RESEARCH-STUDIO-RELEASE-HANDOFF.md) for the exact boundary.

Also in the tree from the original project (not covered by the acceptance matrix): multi-channel messaging
adapters (Telegram, Discord, Slack, Feishu, DingTalk, e-mail, Signal, Matrix, IRC, Nostr and a local web UI —
the WhatsApp, iMessage and QQ modules are **absent** from this checkout), a hook engine, dual-layer memory, and 13
domain skill directories under `container/skills/`. Agents run in containers when Docker is available (the container contract is tested; the full tool image is not yet built/verified);
otherwise runs are labelled `host_text_only` (model text, no tools).

## Documentation

| Need | Read |
|---|---|
| Install and run locally in minutes | [docs/QUICKSTART.md](docs/QUICKSTART.md) |
| How it fits together | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Operate it (config, startup checks, budgets, live checks) | [docs/RUNBOOK-local.md](docs/RUNBOOK-local.md) |
| Run every check | [docs/TESTING.md](docs/TESTING.md) |
| HTTP API | [docs/API.md](docs/API.md) and [docs/openapi-v1.json](docs/openapi-v1.json) |
| Release-candidate handoff: what works, boundaries, commands, human decisions | [docs/RELEASE-CANDIDATE-HANDOFF.md](docs/RELEASE-CANDIDATE-HANDOFF.md) |
| Validation protocol and production-readiness plan (drafts; nothing approved) | [docs/CLINICAL-VALIDATION-PROTOCOL.md](docs/CLINICAL-VALIDATION-PROTOCOL.md), [docs/PRODUCTION-READINESS-PLAN.md](docs/PRODUCTION-READINESS-PLAN.md) |
| OCR study-policy layer (all real fields unconfigured; activation blocked) | [docs/OCR-STUDY-POLICY.md](docs/OCR-STUDY-POLICY.md) |
| OCR protocol review packet (blank; clinician-completable) | [docs/OCR-PROTOCOL-REVIEW-PACKET.md](docs/OCR-PROTOCOL-REVIEW-PACKET.md) |
| Clinician decision workspace (worksheet, protocol review, draft-only dossier template) | [docs/CLINICAL-LEAD-WORKSHEET.md](docs/CLINICAL-LEAD-WORKSHEET.md), [docs/CLINICIAN-PROTOCOL-REVIEW.md](docs/CLINICIAN-PROTOCOL-REVIEW.md) |
| Posture and monitoring validation (synthetic-only tooling and protocols) | [docs/POSTURE-VALIDATION-PROTOCOL.md](docs/POSTURE-VALIDATION-PROTOCOL.md), [docs/MONITORING-VALIDATION-PROTOCOL.md](docs/MONITORING-VALIDATION-PROTOCOL.md) |
| AIKosh data governance (all files blocked from external use by default) | [docs/AIKOSH-DATA-GOVERNANCE.md](docs/AIKOSH-DATA-GOVERNANCE.md), [docs/openapi-aikosh.json](docs/openapi-aikosh.json) |
| OCR study threat model (draft; no risk marked resolved) | [docs/OCR-STUDY-THREAT-MODEL.md](docs/OCR-STUDY-THREAT-MODEL.md) |
| OCR study workspace API contract (authenticated; synthetic-only) | [docs/openapi-ocr-study.json](docs/openapi-ocr-study.json) |
| Governance review: decision register, roadmap, stakeholder brief (all unapproved; default no-go) | [docs/GOVERNANCE-DECISION-PACK.md](docs/GOVERNANCE-DECISION-PACK.md), [docs/IMPLEMENTATION-ROADMAP-NEXT.md](docs/IMPLEMENTATION-ROADMAP-NEXT.md), [docs/PRODUCT-STATUS-BRIEF.md](docs/PRODUCT-STATUS-BRIEF.md) |
| What is real vs mocked vs gated, by evidence level and phase | [docs/ACCEPTANCE-MATRIX.md](docs/ACCEPTANCE-MATRIX.md) |
| Public scientific-data connectors (AlphaFold DB, RCSB PDB, NCBI Datasets, GEO; research-only) | [docs/SCIENCE-DATA.md](docs/SCIENCE-DATA.md) |
| Agent container contract | [docs/CONTAINER-CONTRACT.md](docs/CONTAINER-CONTRACT.md) |
| Validation tools and templates (OCR, pose, device, rule approval) | [docs/VALIDATION-TOOLS.md](docs/VALIDATION-TOOLS.md) |
| Proposed change for the PosturePulse repo (signed export; not applied) | [docs/proposals/posturepulse-signed-export.md](docs/proposals/posturepulse-signed-export.md) |
| Releasing clinical content (rules, reference documents, modules) | [docs/CLINICAL-CONTENT-RELEASE.md](docs/CLINICAL-CONTENT-RELEASE.md) |
| Detailed task log and open items | [docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md), [docs/INTEGRATION-STATUS.md](docs/INTEGRATION-STATUS.md) |
| Research Studio (autonomous manuscript/thesis authoring): plan, architecture, browser-connector boundary | [docs/RESEARCH-STUDIO-PLAN.md](docs/RESEARCH-STUDIO-PLAN.md), [docs/RESEARCH-STUDIO-ARCHITECTURE.md](docs/RESEARCH-STUDIO-ARCHITECTURE.md), [docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md](docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md) |
| Research Studio release handoff: what's implemented, exact test results, known boundary (M1–M6, locally complete, synthetic/offline only) | [docs/RESEARCH-STUDIO-RELEASE-HANDOFF.md](docs/RESEARCH-STUDIO-RELEASE-HANDOFF.md) |
| The product plan | [plan.md](plan.md) |

## Safety posture (enforced in code, tested)

- Secrets fail closed; no default admin; server-side sessions; scrypt passwords; hashed tenant API keys.
- Production refuses default/weak database passwords and `CORS_ORIGINS=*`; CORS is same-origin unless exact origins are listed.
- Patient retrieval is authorised in SQL before similarity scoring; tenants are isolated at every `/v1` step.
- Clinical sign-off is dashboard-only and requires a provisioned licensed clinician; the API cannot sign off.
- No measurement, extraction or model output is fabricated: missing/unsupported/stale/untrusted data is stated explicitly.

## License

MIT — see [LICENSE](LICENSE). © 2026 AMGI Research.
