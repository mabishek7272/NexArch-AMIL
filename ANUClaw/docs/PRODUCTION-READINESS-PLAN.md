# Production readiness plan (DRAFT FOR REVIEW)

**Status: production-NOT-ready. Clinically unvalidated.** This is a plan, not a record of completed work: no item below has been done unless a linked evidence file says so, and the acceptance matrix places nothing at evidence level L5
([ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md)). Owners are **roles to be filled by named humans**; this document assigns nobody. Clinical prerequisites are in [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md); the current build state is in
[RELEASE-CANDIDATE-HANDOFF.md](RELEASE-CANDIDATE-HANDOFF.md).

## 1. Deployment architecture requirements

| Requirement | Today (verified locally) | Needed before production |
|---|---|---|
| Environments | one developer host, disposable PostgreSQL | separate dev / staging / production; production data never in staging; infrastructure as code reviewed and versioned |
| API + dashboard | single Node process, `start:api` / `start:dashboard` | process supervision, TLS termination, horizontal-scale design (confirm the rate-limit/limits store is the shared one, not per-process), health/readiness endpoints, zero-downtime deploy and rollback |
| Database | PostgreSQL 17 (tests), startup refuses weak passwords in production | managed or HA PostgreSQL, private network only, TLS, least-privilege roles, migration process with review and rollback, connection limits |
| Agent containers | hardened `docker run` (non-root host uid, cap-drop, no-new-privileges, pids/memory limits, credentials on stdin) tested on the full image | decide the production runtime/isolation (see below), image registry with pinned digests, vulnerability-scanned images, resource quotas per tenant, no host Docker socket exposure to the app |
| OCR service | local PaddleOCR process | supervised service, capacity plan, version pinned in the manifest, no external egress |
| Study security (OCR validation) | threat model drafted ([OCR-STUDY-THREAT-MODEL.md](OCR-STUDY-THREAT-MODEL.md)); lifecycle, re-auth hook, CSRF/limits/rate limits implemented for synthetic data; no MFA/SSO, no pen test, in-process rate limits | SSO/MFA, independent pen test and authorization review, shared rate-limit store, WORM audit; all still **not started** |
| Study storage (OCR validation) | synthetic-only local adapter; `StudyObjectStore` contract defined with a 10-case contract harness (fake-backed, **not evidence**), **no implementation**; fails closed (503) when unconfigured | implement the object-store adapter (immutable put, retention lock, customer-managed encryption, per-role access policy, audit), port the study engine's file I/O onto it, then lift the synthetic-only restriction only under an approved protocol |
| Storage | owner-only local files for documents/science data | encrypted object storage or volume, integrity checks (content hashes already stored), lifecycle/retention enforcement |
| Network | loopback | ingress allow-list, egress allow-list (providers only), no inbound to workers, CORS exact origins |
| Isolation of tenants | per-tenant/ per-patient grants enforced in code and tested | independent security review of isolation; load-test with concurrent tenants |

**Decision needed:** production container-isolation model. Running agents through a host Docker socket is a privileged design; options include a dedicated worker host/VM, rootless runtime, or a managed sandbox. The current tests establish the contract, not production isolation.

## 2. Secrets, backups, disaster recovery, audit retention

- **Secret management:** a secrets manager (not `.env` files) for the database password, JWT secrets, provider keys, signing keys; rotation schedule and procedure per secret; break-glass access logged; no secret in images, logs, argv or `docker inspect` (already tested for the agent path). The development default database password in `src/config.ts` must be removed or made impossible in production builds.
- **Backups:** automated encrypted backups of PostgreSQL and the document/science stores; backup retention aligned to the data-retention policy; **restore drills** on a schedule with measured restore time; backup access separated from production admin.
- **Disaster recovery:** declared RPO/RTO **[SET BY OWNER]**, runbook, secondary-region or recovery environment, tested failover; dependency map (providers, DNS, registry).
- **Audit retention:** audit log (clinical decisions, access, sign-offs, exports, grants, erasure) retained for the period required by the legal review, write-once or tamper-evident storage, access-reviewed; erasure and retention rules reconciled (an erasure must not break audit integrity — decide what is retained and how it is pseudonymised).
- **Data lifecycle:** retention schedules, deletion certificates, handling of withdrawal and backups.

## 3. Provider spend cap, quotas, incidents and outages

- **Spend cap:** the in-app spend ledger is **admission control by reservation, not a hard cap** (documented). Production needs a **provider-side** key limit/budget per environment and per tenant key, plus alerts at fixed thresholds. Authenticated Claude-agent execution stays **disabled** until this exists.
- **Quotas:** per-tenant request/size/concurrency limits (exist; values to be set from capacity tests), per-user limits, protection against runaway agent loops (max turns/timeouts exist; set production values).
- **Incident handling:** severity definitions, on-call rota, runbooks (provider outage, credential leak, runaway spend, data exposure, wrong-result report, safety event), communication templates, post-incident review with tracked actions.
- **Outage behaviour:** verified fail-safe states — OCR down → explicit `ocr_unavailable`, never silent omission; model/provider down → labelled text-only fallback or explicit error, never an unlabelled answer; database down → read-only/clear error; stale monitoring data shown as stale. Provider fallback changes go through [change control](../validation/templates/07-model-provider-change-control.template.md).

## 4. Security testing, dependency updates, observability and alerting

- **Security testing:** independent penetration test (authN/authZ, tenant isolation, file upload, SSRF in the science fetcher, prompt injection, container escape paths); threat model reviewed; secure-SDLC checks in CI (SAST, secret scanning, license check); findings tracked to closure; re-test after major changes.
- **Dependencies and images:** automated dependency and base-image update PRs; the hash-locked Python lock ([repro-manifest.json](evidence/repro-manifest.json)) regenerated and re-tested on a cadence; vulnerability scanning of the image and npm tree with severity-based SLAs; known gaps to close: base images referenced by tag not digest, snakemake venv not hash-locked, GATK has no publisher checksum (local consistency check only).
- **Observability:** structured logs without personal data or secrets, metrics (latency, error rates, queue/job states, OCR failure rates, spend, provider errors), tracing across API → worker → provider, dashboards.
- **Alerting:** actionable alerts with owners and runbooks — error-rate and latency SLOs, spend thresholds, certificate/secret expiry, backup failure, audit-log failure, monitoring-data freshness failures, container/job failures, security events.

## 5. Data-processing agreements, regulatory and legal review

- **Data-processing agreements** with every provider that could receive personal data (model, OCR, hosting, email/notification, logging): purpose limitation, no training on data, retention/deletion, location and sub-processors, breach notification, audit rights. Until signed: synthetic or locally processed data only; `ELAB_DEID_REQUIRED` stays on.
- **Posture / monitoring validation:** synthetic-only tooling exists; real video, device and participant studies need the human inputs in [MONITORING-VALIDATION-PROTOCOL.md](MONITORING-VALIDATION-PROTOCOL.md) §7 and production storage, authentication and security review before any real data is registered.
- **AIKosh data:** provenance, licence, consent and de-identification evidence per file are required before any external RAG, embedding, prompt or fine-tuning use ([AIKOSH-DATA-GOVERNANCE.md](AIKOSH-DATA-GOVERNANCE.md) §6); all files are blocked until then.
- **Public data licences:** confirm terms of AlphaFold DB, RCSB, NCBI, GEO per record class for the intended use (the connectors record provider-wide terms and mark record-specific terms as unknown); attribution displayed.
- **Regulatory pathway:** formal assessment by qualified regulatory counsel/consultants of whether the intended use (as eventually approved) is a regulated medical device/software in each target jurisdiction, the classification, quality-management and clinical-evidence obligations, and marketing-claim limits. Until then no medical-device claim.
- **Privacy law:** data-protection impact assessment, lawful basis, cross-border transfer review, patient-rights processes (access, rectification, erasure, restriction), breach notification duties.
- **Clinical governance:** institutional approval, responsible-clinician model, liability/insurance review, professional-practice rules for automated tools.
- **Third-party and open-source licences** reviewed for the shipped image and dependencies.

## 6. Support, training, change management and rollback

- **Support:** support tiers, contact paths, response targets, escalation to clinical lead and engineering, user-facing known-issues list (including the PyMOL defect and unsupported report types).
- **Training:** role-based training (clinician reviewers, operators, administrators), competency check, materials stating limits (draft-only outputs, uncertainty flags, what the tool does not do), refresher after changes.
- **Change management:** release process with changelog, staged rollout (pilot → limited → general) with entry/exit criteria, freeze windows, communication to users, post-release monitoring period, and [change-control records](../validation/templates/07-model-provider-change-control.template.md) for anything validation-relevant.
- **Rollback:** tested rollback of application, database migration and clinical content (rule/reference versions, per the dossier rollback trigger); documented decision rights; rollback rehearsed before go-live.

## 7. Go / no-go gates with accountable human owners

A gate is passed only when every criterion has linked evidence **and** the owner has signed. No gate is passed today.

| Gate | Criteria (all required) | Accountable owner (role) | Status |
|---|---|---|---|
| G0 Scope & intended use | signed intended-use / non-intended-use statement; target population and exclusions | Clinical lead + product owner | **Not started** |
| G1 Governance | ethics/institutional approvals; named roles; DPIA; data-governance approval | Protocol owner + privacy officer | **Not started** |
| G2 Legal & regulatory | DPAs signed; licences reviewed; regulatory pathway decision recorded | Legal/regulatory lead | **Not started** |
| G3 Security | pen test with no open critical/high; secrets in manager; isolation review; dependency/image scan within SLA; **upstream signed-export decision** ([checklist](proposals/posturepulse-upstream-review-checklist.md)) | Security lead | **Not started** |
| G4 Infrastructure & operations | staging parity; backups restored in a drill; DR drill within RPO/RTO; observability and alerts live; rollback rehearsed; production container-isolation model decided | Engineering lead + operations lead | **Not started** |
| G5 Cost & provider controls | provider-side spend caps set; quotas set from load tests; outage behaviour verified; decision on authenticated agent execution | Engineering lead + finance owner | **Not started** (agent execution disabled) |
| G6 Clinical validation | approved protocol executed; OCR, extraction/summary, rules, posture, device studies each with a signed result summary meeting **pre-declared** criteria; rule dossiers signed and in the register | Clinical lead + independent statistician | **Not started** (no real data or approvals exist) |
| G7 Usability & workflow | summative usability study meeting criteria; no unmitigated critical use error; training materials approved | Clinical lead + quality lead | **Not started** |
| G8 Pilot readiness | supervised pilot plan with stop criteria; support model live; users trained; incident process tested | Clinical lead + support lead | **Not started** |
| G9 Release decision | G0–G8 evidence reviewed; residual-risk statement; explicit **go / no-go** signed by the accountable executive and the clinical lead | Accountable executive + clinical lead | **Not started** |

Any gate can be reopened by a change under [change control](../validation/templates/07-model-provider-change-control.template.md). A **no-go** at any gate stops release; the default state of this product is no-go.

## 8. Governance companions

Decisions that open or close these gates are in [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md); the ordered milestones to reach them are in [IMPLEMENTATION-ROADMAP-NEXT.md](IMPLEMENTATION-ROADMAP-NEXT.md); a plain-language status for stakeholders is [PRODUCT-STATUS-BRIEF.md](PRODUCT-STATUS-BRIEF.md). All gates remain **not started**.
