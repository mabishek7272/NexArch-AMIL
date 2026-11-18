# Quickstart (local, synthetic data only)

Prerequisites: Node ≥ 20 (tested on 24), npm, a PostgreSQL 14+ you can throw away. Optional: Python 3.11+ for the
OCR service. No real patient data, ever, in this setup.

```sh
npm install
npm --prefix dashboard install
cp .env.example .env          # then edit; never commit real values
npm run check:config          # OK/FAIL per check, never prints values
npm run build && npm --prefix dashboard run build
```

Minimum `.env` for a local run (generate each secret separately with
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`):

| Variable | Purpose |
|---|---|
| `ANUCLAW_JWT_SECRET`, `DASHBOARD_JWT_SECRET`, `ANUCLAW_AUDIT_HMAC_SECRET` | startup refuses without them |
| `PG_HOST/PORT/USER/PASSWORD/DATABASE` | database (use a strong password; production refuses defaults) |
| `ANUCLAW_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | first admin on an empty database (remove the password afterwards) |
| `CDS_ENABLED=false` **or** CDS issuer settings **or** local demo mode | see RUNBOOK |
| optional `OPENROUTER_API_KEY`, `ANUCLAW_MODEL_DAILY_BUDGET_USD` | model calls and spend budget |

Run:

```sh
npm run start:dashboard      # http://127.0.0.1:3722  (sign in with the bootstrap admin)
npm run start:api            # http://127.0.0.1:4000  (/health, /v1/openapi.json)
```

## One-command self-contained check (no `.env` needed)

`npm run verify:local` starts a throw-away loopback profile with a random database and synthetic users, drives the
real browser workflow and the `/v1` API, and writes `docs/verification-local-latest.json`. It needs a disposable
PostgreSQL (`ANUCLAW_TEST_PG_URL`) — see [TESTING.md](TESTING.md).

## OCR (optional)

Scanned pages need the OCR service; without it pages are marked `ocr_unavailable` (nothing is invented).

```sh
python3 -m venv .venv-ocr3 && .venv-ocr3/bin/pip install -r requirements-ocr3.txt
.venv-ocr3/bin/python ocr_server.py        # then set OCR_SERVICE_URL
```

## First API call

```sh
curl -s -X POST http://127.0.0.1:4000/api/v1/register -H 'content-type: application/json' \
  -d '{"company_name":"Synthetic Co","email":"dev@synthetic.invalid","plan":"pro"}'   # returns an API key once
curl -s http://127.0.0.1:4000/v1/engines -H "x-api-key: $KEY"
```
