# Architecture (what exists in this checkout)

```
                 ┌───────────────────────────────────────────────────────────┐
 browser ───────▶│ Dashboard (React/Vite, served under /dashboard by Express)│
                 └──────────────┬────────────────────────────────────────────┘
                                │ cookie session (HS256, server-side session row)
 API clients ──x-api-key/JWT──▶ │
                                ▼
                 ┌──────────────────────────────┐        ┌──────────────────┐
                 │ Express app (src/api, src/   │───────▶│ PostgreSQL       │
                 │ dashboard/server)            │        │ (all state)      │
                 └───┬───────────┬──────────────┘        └──────────────────┘
        documents    │           │ model transport (src/ai/openrouter.ts)
        workflow     │           ▼
   (src/documents)   │   hooks → egress (de-identify by data class) → spend reservation
                     │   → bounded HTTP → identity check → settle cost → re-identify → after-hooks
                     ▼                                   │
   OCR service (ocr_server.py, PaddleOCR) ◀──────────────┘ provider (OpenRouter)
```

## Components

| Area | Where | Notes |
|---|---|---|
| Document workflow | `src/documents/*` | extraction → candidates (uncertainty flags) → confirmation/correction → hashed snapshot → rules → report → export. Server-owned `engine_runs`; clinical sign-off is dashboard-only. |
| Rules | `src/documents/rules.ts` | Only the report-presentation rule (compare with the *printed* interval) is released. `CLINICAL_RULES` is empty by design; see [CLINICAL-CONTENT-RELEASE.md](CLINICAL-CONTENT-RELEASE.md). |
| Model transport | `src/ai/openrouter.ts`, `adapters.ts`, `spend.ts` | one guarded path for OCR/embedding/Decision/review calls; spend ledger enabled on first use unless `ANUCLAW_SPEND_TRACKING=off` (tests only). |
| Evidence retrieval | `src/ai/reference-corpus.ts` | authorised in SQL before similarity; approval requires a provisioned licensed clinician; explicit `no_evidence`. |
| AI review | `src/ai/engine-review-service.ts` | reviews a *verified stored* engine run; numeric/citation fidelity; deterministic block precedence. |
| `/v1` BaaS API | `src/api/routes/baas-v1.ts`, `openapi-v1.ts` | hashed API keys, shared-store rate/concurrency/quota, tenant isolation, idempotency keys. |
| PosturePulse | `src/integrations/posturepulse/*` | trusted upstream fetch (origin-only config, no redirects) or HMAC-signed bundle; upstream canonical-JSON hash check. |
| Monitoring | `src/monitoring/*` | two-clock freshness model; labelled simulator; simulation-only alerts. |
| Research | `src/research/*` | registered analyses only; governed datasets; reproducible runs. |
| Specialties | `src/specialties/registry.ts` | what exists per department; no "approved" state. |
| Startup checks | `src/startup-checks.ts` | default-credential and CORS policy. |
| Channels/hooks/memory | `src/channels/*`, `src/hooks.ts`, `src/memory.ts` | original project parts; hooks also gate model calls. |

## Data flow rules that hold everywhere

- A value is either present with provenance, or explicitly absent/unsupported/stale/untrusted — never guessed.
- A model output never overrides a deterministic block; a model failure yields an explicit non-completed status.
- Cost is the provider-reported number or *unknown*; unknown is never zero.
- Records carry the engine/model/rule version that produced them.

## Persistence

PostgreSQL only (schema created by `ensureDbReady()` in `src/db/connection.ts`; additive migrations). Files for uploaded
documents live under `ANUCLAW_DOCUMENT_DIR`. Nothing is stored in the browser except UI preferences.
