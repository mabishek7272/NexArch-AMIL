# Integration status

Status vocabulary: **implemented** (code + automated tests) · **mocked** (tested only
against fakes) · **live-tested** (exercised against the real external system with
synthetic data, date given) · **blocked** (cannot proceed without the stated action).
Live tests use synthetic data only; none establish clinical performance.

Last updated: 2026-11-17.

## Model providers (OpenRouter, server-side key; never logged)

All calls go through `modelCall` (`src/ai/openrouter.ts`): BeforeLLMCall hooks →
egress policy by declared data class (`patient_derived` de-identified; patient images
blocked unless `LLM_BAA_COVERED=true`; `reference_public`/`synthetic_test` as-is) →
bounded transport (60 s, ≤1 retry) → local re-identification → AfterToolCall hooks.
Provider error bodies are never returned or logged (HTTP status + vetted code only).
Model identity must be exact, a documented alias, or a verified dated version
(`MODEL_IDENTITIES`); anything else is `model_mismatch` and discarded; a missing id is
recorded as `unverified_missing`.

| Role | Requested id | Catalog check (2026-11-17) | Live result (synthetic) | Reasoning | Status |
|---|---|---|---|---|---|
| Vision OCR | `google/gemini-3.8-flash` | listed in `/api/v1/models`; image input; `reasoning_effort` supported | 200, returned exact id; transcribed a rendered synthetic page; parser recovered `Hemoglobin 16.4 g/dL 12.0-15.5` and `<0.5` | `medium` requested; reasoning tokens reported | **live-tested** |
| Embeddings | `google/gemini-embedding-2` | listed in `/api/v1/embeddings/models` (not in `/models`) | 200, returned `gemini-embedding-2` (documented alias); 3072 dims | not applicable (no params) | **live-tested** |
| Structured checks | `google/gemini-decision-1` | **not** in `/models`; served by alpha `/api/alpha/decisions` | 200, returned `google/gemini-decision-1-20261111` (verified dated version); answers per question | not applicable | **live-tested** (alpha API — contract may change) |
| Review | `google/gemma-4-26b-a4b-it` | listed; `reasoning`, `response_format` supported | 200, returned exact id; JSON review | `medium` requested; reasoning tokens reported | **live-tested** |

Higher-level live checks (`src/ai/live-models-pg.test.ts`, 3/3 passed 2026-11-17):
- OCR adapter end-to-end on a synthetic rendered page → candidates flagged
  `ocr_low_confidence` (model gives no calibrated confidence) → confirmation required.
- Reference retrieval: draft and other-tenant documents never became candidates
  (2 of 4 chunks considered); top hit correct; citation checker accepted a faithful
  claim and rejected an altered number and an invented chunk id.
- Decision 1 → Gemma review on a verified stored `engine_runs` record: `completed`,
  0 fidelity problems; stored row bound to the engine output hash.

Reproduce:
```sh
npm run probe:models                           # 4 bounded calls → docs/integration-probe-latest.json
ANUCLAW_LIVE_MODEL_TESTS=1 ANUCLAW_TEST_PG_URL=postgres://…/postgres npx vitest run src/ai/live-models-pg.test.ts
npx vitest run src/ai/openrouter.test.ts       # mocked boundary/identity/validation tests (35)
```

All provider paths now go through the guarded boundary (`completeJson` OpenRouter path
via `modelCall`; Anthropic/OpenAI-compatible SDK paths wrapped in the same hooks + egress).
Retrieval scores in-process (no pgvector); fine for small
corpora only. Reference corpus currently holds no approved real content (approval
requires a provisioned licensed clinician).

## Other integrations

| Integration | Status | Evidence / blocker |
|---|---|---|
| pdf-parse v2 (native text + page rendering) | **implemented**, live locally | `src/documents/*.test.ts` |
| pdf-lib 1.17.1 (PDF export) | **implemented**, live locally | sample rendered and visually inspected; `report-pdf.test.ts` round-trips text |
| PaddleOCR service — 2.x stack (`requirements-ocr.txt`: paddlepaddle 2.6.2, paddleocr 2.7.3, Python 3.12) | **blocked on this machine** | installs and loads, but Paddle 2.6.2 inference **hangs** in `predict_det` on macOS 27 arm64 (default, `OMP_NUM_THREADS=1`, MKLDNN off, `ir_optim=False` all hang >50 s). 2.6.1 has no arm64 cp312 wheel. |
| PaddleOCR service — 3.x stack (`requirements-ocr3.txt`: paddlepaddle 3.3.1, paddleocr 3.7.0) in `.venv-ocr3` | **live-tested** 2026-11-17 | `ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:54001 npx vitest run src/documents/ocr-live.test.ts` → 3/3: 4 synthetic lines read exactly (conf ≈1.0, 4-point boxes), image-only PDF page OCR'd through the pipeline, blank page → no text, non-image/empty upload → 400. Models downloaded from official PaddleOCR/PaddleX sources on first run (slow: ~17 KiB/s). |
| RDKit 2025.09.1 (isolated `.venv-chem`, Python 3.12) | **live-tested** 2026-11-17 | standard descriptors via subprocess worker; `rdkit-crosscheck.test.ts` live tests; unavailable → explicit status, no substitution |
| scipy 1.17.1 / numpy 1.26.4 (reference vectors only) | **used to generate test vectors** | `scripts/gen-stats-vectors.py`; TypeScript stats are tested against them |
| Disposable PostgreSQL 17 (tests) | **live-tested** | embedded-postgres in session scratchpad, port 55432 |
| Docker Desktop (agent container tools) | **blocked — user action (macOS privileged-helper approval; not bypassed)** | installed (`docker` 29.8.1 client); starting it triggers a macOS **administrator privilege prompt** (`docker-desktop-privileged`) to install its helper. Not approved by the agent. User: start Docker Desktop once and approve, then re-run the container contract check. |
| PosturePulse | **implemented; live against the real backend (partial)** | provenance model: configured trusted upstream or HMAC-signed bundle only; caller payloads are labelled `unverified_payload`. Ajv 2020 + ajv-formats validation against `packages/schemas/src`; content hash checked with our copy of the upstream `canonical-json` algorithm. **Live (2026-11-17, synthetic):** real NestJS backend + Prisma migrations on a disposable PostgreSQL + real ml-service catalog → consent, session, report build, clinician sign-off, report-access, released report fetched and its hash verified (`posturepulse-live.test.ts`). **Not live:** real video / pose pipeline (metric results seeded synthetically); signed bundles (upstream does not emit them; verifier mock-tested). Stand-in tests (`upstream.test.ts` 42, `posturepulse-pg.test.ts` 6) remain and are labelled mock. |
| Channels: Nostr, Feishu, DingTalk | **blocked (incomplete code)** | not started by default |
| Channels: WhatsApp, iMessage, QQ | **absent** | modules missing from checkout |

## End-to-end verification on loopback (synthetic data) — 2026-11-17

`npm run verify:local` → **24 passed, 0 failed** (latest run; earlier 22-check run also passed) (`docs/verification-local-latest.json`):
isolated profile (random DB, loopback API+dashboard), real headless Chromium driving the Clinical page, real PaddleOCR 3.7 on a rendered scanned page, live OpenRouter (bounded) for the AI review.
Covered: unauthenticated/unauthorised access (401/404/403, UI shows no patients), upload with per-page native+OCR source display, uncertainty flags, snapshot blocked until confirmation, confirm/correct(reason), snapshot→rules→draft report with explicit "Not provided" sections, AI review over the stored run (live: `completed`, 0 problems; with the provider forwarder down: `decision_http_error`, no review content), draft HTML/PDF export (status + hash headers, PDF text), operator sign-off refused (API 403, UI disabled), clinician sign-off → reviewed v2, reviewed exports, correction → snapshots/reports superseded (HTML+PDF say SUPERSEDED), OCR outage (document `partial`, page `ocr_unavailable`, no invented text), `/v1` workflow with two-tenant isolation and PDF export; monitoring page (simulator stream labelled, real-device alert refused 409, never-received metric shows no value, an hour-old reading received now is NOT shown as current — kept as last-known with measurement and receipt times, device state `delayed`); research page (attestation refused when unchecked, gated analysis refused without acknowledgement, run labelled research-only, re-run reproduces the hash).
Live-model variance: an earlier run returned `review_malformed` for the first live review — the contract (labelled, no content on non-completed) held; a statuses of `completed`/`failed_validation`/`review_malformed` are all accepted evidence.
Environment note: the branded Google Chrome 154 on this macOS exits spontaneously during long runs; Playwright's own `chromium-headless-shell` is used (`npx playwright-core install chromium-headless-shell`).

## Model spend tracking (added 2026-11-17)

Every model call (OCR, embedding, Decision, review) is reserved against a per-UTC-day ledger before it is sent and settled with the provider-reported cost afterwards. Unknown cost is never counted as zero. Budgets are optional and unset by default (set `ANUCLAW_MODEL_DAILY_BUDGET_USD` / `ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD` to enforce; `.env` itself was not modified). Reports: `/api/clinical/spend`, `/v1/spend`. Requires a real provider invoice to reconcile — the ledger is an engineering control, not billing.

## Update 2026-11-17 (tasks 49–53)

- **Spend ledger:** invalid budget configuration now refuses all model calls (never unlimited); `0` is an explicit zero budget; every entry point is accounted unless `ANUCLAW_SPEND_TRACKING=off`; late settlements reconcile once; possibly-billed errors stay on the ledger. It is **not** a hard cap on provider charges.
- **Live PosturePulse:** see the PosturePulse row above and `docs/TESTING.md`.
- **Browser workflow:** 25/25 including `standardised_rates`, spend-report authorization and tenant isolation, and the corrected monitoring freshness (an hour-old reading received now is not a current value; a future-dated device clock is `untrusted_time`).
- **Startup checks:** default/weak DB passwords and `CORS_ORIGINS=*` are refused in production; CORS is same-origin by default.

## Update 2026-11-17 (tasks 54–61)

- **Docker:** daemon available; **full image built** (`anuclaw-agent:latest`, 12.3 GB) and the container suite ran on it: 31 passed at task 71, 33 passed at task 72, 1 skipped (authenticated agent execution, disabled pending authorization). Optional-tools image not built. See CONTAINER-CONTRACT.md.
- **PosturePulse:** two separately labelled live setups — `seeded_metrics` (backend/hash path only) and `real_pose_model_on_synthetic_video` (upload → decode → real MediaPipe model → report → release → import; mannequin, not a person). A real defect (withdrawn rows vs the report digest) was found live and fixed. Signed export is a **proposed, unapplied** diff.
- **Validation tools** for OCR, pose, device reliability and rule dossiers exist and are verified with synthetic fixtures only.
- **Gates:** seed oncology/neurology CDS content is blocked unless released in the register; incomplete channel adapters stay off (now tested).

## Update 2026-11-17 (tasks 62–64)

- **Container evidence kinds (kept separate):** agent double on real Docker (13); real Claude CLI startup (probe image); real CLI context/credential path with a fake key and capture server (no model). **Not run:** authenticated agent execution (human-enabled), tool execution, full image (build in progress).
- **PosturePulse signed export:** revised proposal, scratch-only tests; subject-authorised view only; HMAC shared secret, no independent clinician attribution; not applied.
- **Validation tools:** no combined "adequate" flag; six separate evidence blocks; clinical acceptance always "not assessed by this tool". Human clinical/device validation remains pending.

## Update 2026-11-17 (tasks 68–70)

- **Signed export (proposal, scratch only):** the "signing clinician is authorised" exception was removed (sign-off is a role-only upstream route, so it was self-grantable); only explicit operator grants authorise an export.
- **Public scientific data:** AlphaFold DB, RCSB PDB, NCBI Datasets and GEO connectors with provenance, immutable versioned cache, scoped workspaces and manifests — research-only. **Live (real providers, bounded to 20 files/0.70 MiB):** AlphaFold P69905 ✓, RCSB 4HHB ✓, NCBI GCF_000819615.1 ✓ (after a Zip64 fix found live), GEO search/describe ✓, GEO series matrix fetched and parsed with the fixed fetcher (after an `Accept`-header fix found live) but the full GEO retrieve→store flow was not re-run within the budget. Mock-only: rate limits, outages, oversize, tamper detection. See SCIENCE-DATA.md and the acceptance matrix.

- **Task 72:** nextflow functional; PyMOL non-functional on Python 3.12 (recorded); application-path container job verified with an agent double (no Claude); rehearsal evidence in `evidence/acceptance-rehearsal-latest.json`; reproducibility manifest in `evidence/repro-manifest.json`. GSE2 real-bytes replay impossible (bytes not retained) — fresh request pending.
