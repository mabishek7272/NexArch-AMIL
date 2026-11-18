# Testing and verification commands

All commands run from the ANUClaw directory. **Synthetic data only; disposable PostgreSQL only.**

| Purpose | Command | Notes |
|---|---|---|
| Type-check/build | `npm run build` | `tsc` |
| Unit + mock tests | `npm test` | real-PostgreSQL suites are skipped without `ANUCLAW_TEST_PG_URL` |
| Full regression | `ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npm test` | each suite creates and drops `anuclaw_it_<random>` — never point it at a database with real data |
| Lint | `npx eslint src` | 0 errors required; warnings are tracked, not gating |
| Dashboard build | `npm --prefix dashboard run build` | |
| OpenAPI | `npm run openapi:v1` then validate (below) | a contract test also checks every route ↔ documented operation |
| Claims lint (outer PosturePulse repo) | `npm run lint:claims` there | not part of ANUClaw |
| Local profile + browser workflow | `ANUCLAW_VERIFY_SHOTS=<dir> ANUCLAW_TEST_PG_URL=… [ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:PORT] npm run verify:local` | Playwright `chromium-headless-shell`; writes `docs/verification-local-latest.json`; real OCR if the URL is given; live OpenRouter calls (bounded, synthetic) if a server-side key exists |
| Container contract (real Docker, test-double agent CLI) | `docker build -t anuclaw-contract:thin -f container/Dockerfile.contract container && ANUCLAW_CONTAINER_TESTS=1 npx vitest run src/container-contract.test.ts` | no model call; add `ANUCLAW_CONTRACT_IMAGE=anuclaw-agent:latest` (full image) to include the tool smoke tests — see [CONTAINER-CONTRACT.md](CONTAINER-CONTRACT.md) |
| PosturePulse video → pose → report → release → import (SYNTHETIC mannequin) | `POSE_MODELS=<dir with pose_landmarker_{full,lite}.task> scripts/posturepulse-e2e/run.sh <workdir>` (options `EXCLUDE_ROW=1`, `SIGNED_EXPORT=1`, third arg = shoulder tilt in px) | needs the PosturePulse checkout + its `ml-service/.venv`; models are Google's public MediaPipe files (see `ml-service/scripts/fetch-pose-model.sh`); evidence summary in `docs/evidence/` |
| Validation tools (OCR / pose / device / rule dossier) | `npm run validate -- <ocr|pose|device|rule> …`; tests `npx vitest run src/validation` | [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md); regenerate independent vectors with `npm run validate:vectors` |
| Public-data connectors: deterministic + route + service tests | `npx vitest run src/sciencedata` | synthetic mock providers; real PostgreSQL for the `-pg` files |
| Public-data connectors: BOUNDED LIVE check | `ANUCLAW_TEST_PG_URL=… npx tsx scripts/verify-science-live.ts [--continue --steps=ncbi,geo --gse=GSE2]` | real providers, public records only; ≤ 20 files / 100 MiB enforced by `docs/evidence/science-live-ledger.json`; checks free disk first |
| Live provider probe | `npm run probe:models` (synthetic) | writes `docs/integration-probe-latest.json`; spends a few cents |

Validate the OpenAPI document with an external validator (kept out of the project):

```sh
python3 -m venv /tmp/oasv && /tmp/oasv/bin/pip install openapi-spec-validator
/tmp/oasv/bin/python -I -c "import json;from openapi_spec_validator import validate;validate(json.load(open('docs/openapi-v1.json')))"
```

## Live PosturePulse integration (opt-in)

Runs our importer against the **real** PosturePulse backend (NestJS + Prisma + PostgreSQL, real ml-service catalog).
Everything is process-only configuration against a disposable database; no real `.env`, secret or source is touched.

1. Create a random database on the disposable server; in `services/backend-api` run
   `DATABASE_URL=… npx prisma migrate deploy`.
2. Seed a clinician: `DATABASE_URL=… JWT_SECRET=… PATIENT_DATA_KEY=… npx ts-node scripts/seed-clinician.ts <user> <password ≥12>`.
3. Start `services/ml-service` (`PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m uvicorn app.main:app --port N`) and the
   backend (`ML_SERVICE_URL=… JWT_SECRET=… PORT=M npx ts-node src/main.ts`).
4. Create consent → session → (analysed clip + metric results) → `POST /sessions/:id/report` → clinician login →
   `POST /reports/:id/sign-off` → `POST /sessions/:id/report-access`.
5. `ANUCLAW_POSTUREPULSE_LIVE_*` variables (see header of `src/integrations/posturepulse/posturepulse-live.test.ts`) then
   `npx vitest run src/integrations/posturepulse/posturepulse-live.test.ts`.

There are two separately labelled setups. **`seeded_metrics`** (the first, manual run) seeded two metric results straight into the disposable
database — it covers the backend/report/sign-off/hash path only and is **not** pose-pipeline evidence. **`real_pose_model_on_synthetic_video`**
(`scripts/posturepulse-e2e/run.sh`) uploads a drawn-mannequin clip and lets the real ml-service decode it and run the real pose model; nothing
is seeded. A mannequin is not a person, so this shows the chain operates, not that it is accurate.

## What the checks do and do not prove

Mock tests prove logic and failure handling. Real-PostgreSQL tests prove SQL, concurrency and constraints. Live checks
prove connectivity and observed behaviour. **None proves clinical validity** (plan §16.2).

## OCR study tooling (synthetic only)

| What | Command |
|---|---|
| Tooling + authenticated API tests | `ANUCLAW_TEST_PG_URL=… npx vitest run src/validation/study` (the API file is skipped without PostgreSQL) |
| Dashboard page in a real browser (headless Chromium, seven roles) | `ANUCLAW_TEST_PG_URL=… npx tsx scripts/verify-study-ui.ts` → `docs/verification-study-ui-latest.json` |
| OpenAPI | `npm run openapi:study` then validate `docs/openapi-ocr-study.json` |

