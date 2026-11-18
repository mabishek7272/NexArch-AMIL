# Local runbook (development only)

Not a production deployment guide. Use synthetic data only.

## 1. Prerequisites

- Node ≥ 20 (checked with 24.x), npm.
- PostgreSQL 14+ reachable locally (a disposable instance is fine — see §5).
- Optional: Docker or Apple `container` for real agent tool execution. Without it,
  agent runs fall back to **text-only** completions (labelled `host_text_only`; no tools run).
- Optional: Python OCR service (`ocr_server.py`) — use the pinned 3.x stack in `requirements-ocr3.txt` (PaddleOCR 3.7.0 / paddlepaddle 3.3.1); the 2.x stack hangs on macOS arm64.

## 2. Configure `.env` (never commit real values)

Generate each secret separately:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

| Variable | Needed for |
|---|---|
| `ANUCLAW_JWT_SECRET` | API tenant tokens (API refuses to start without it) |
| `DASHBOARD_JWT_SECRET` | dashboard sessions (dashboard refuses to start without it) |
| `ANUCLAW_AUDIT_HMAC_SECRET` | signed audit export (503 without it) |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` | database. **Startup refuses default/weak passwords in production and for any non-loopback host**; on loopback in development it warns |
| `CORS_ORIGINS` | exact comma-separated origins (`https://app.example.com`). Unset = same-origin only. `*` is allowed only outside production |
| `ANUCLAW_MODEL_DAILY_BUDGET_USD`, `ANUCLAW_MODEL_DAILY_BUDGET_PER_SCOPE_USD`, `ANUCLAW_MODEL_RESERVE_USD` | optional model-spend admission budgets (see §7) |
| `CDS_JWKS_URI` or `CDS_JWT_PUBLIC_KEY`, plus `CDS_AUDIENCE`, `CDS_TRUSTED_ISSUERS` | CDS routes — **or** `CDS_ENABLED=false` — **or** local demo: `ANUCLAW_DEMO_MODE=true` + `CDS_JWT_SECRET` (non-production `NODE_ENV` only) |
| `ANUCLAW_BOOTSTRAP_ADMIN_EMAIL`, `ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD` | first admin on an empty DB (remove the password afterwards) |
| `MODEL_PROVIDER`, OpenRouter key/config | model calls (de-identification applies unless `LLM_BAA_COVERED=true`) |
| `ELAB_DASHBOARD_BAA_ACTIVE` | only if a BAA is actually in place; required for clinical E-LAB grants |

## 3. Preflight

```sh
npm install
npm run check:config     # prints OK/FAIL per check — never values
```

## 4. Build, test, run

```sh
npm run build && npm test && npm run lint
npm --prefix dashboard install && npm --prefix dashboard run build
npm run start:dashboard  # dashboard only (needs PG)
npm run start:api        # API only
npm run dev              # full process incl. channels
```

Health: `GET http://localhost:4000/health` (API). The dashboard listens on 127.0.0.1:3722.

## 5. Disposable PostgreSQL for integration tests

Any throwaway PostgreSQL works. One option that needs no system install (outside the
project, so it does not change project dependencies):

```sh
mkdir -p /tmp/pgtest && cd /tmp/pgtest && npm init -y && npm i embedded-postgres@17.10.0-beta.17
# start.mjs: initialise + start on a free port with a temp data dir, persistent:false
```

Then run the real-PostgreSQL suites (they create and drop `anuclaw_it_<random>`):

```sh
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npm test
```

Never point `ANUCLAW_TEST_PG_URL` at a database containing real data.

## 6. Live checks (synthetic data, bounded)

- `npm run verify:local` — browser + API workflow on a throw-away loopback profile (needs `ANUCLAW_TEST_PG_URL`).
  Add `ANUCLAW_OCR_SERVICE_URL` for real OCR; a server-side OpenRouter key enables the bounded live model calls.
- Live PosturePulse backend run: [TESTING.md](TESTING.md#live-posturepulse-integration-opt-in).

## 7. Model spend budgets (read before relying on them)

Every model call reserves budget before it is sent and is settled with the **provider-reported** cost.

- Unset/blank budget = tracked but uncapped. `0` = explicit zero budget: **every model call is refused**.
- An **invalid** value (non-numeric, negative, bad `ANUCLAW_MODEL_RESERVE_USD` JSON/role/amount) never means "unlimited":
  all model calls are refused until it is fixed, and startup logs the offending variable name.
- A budget is **admission control by reservation, not a hard cap on provider charges**: a call can cost more than its
  reservation, excesses from concurrent calls add up, and calls with unknown cost (retries, errors, embeddings/decisions
  that report no cost) count only at their reservation. Reports (`/api/clinical/spend`, `/v1/spend`) show unknown-cost
  calls and overruns; totals are lower bounds when any cost is unknown. For a real cap set a spending limit on the
  provider key itself.
- Ledger outage: with a budget configured, calls are refused; without one they proceed and the result says
  `untracked_unavailable`. A call that may have reached the provider is never released from the ledger.
- Reports are UTC-day based (reset at 00:00:00 UTC). No prompts, completions, keys or provider bodies are stored.

## 8. Known gaps

- Container agent contract (F10) unverified: Docker Desktop's helper needs a macOS administrator approval.
- Rate limits/throttles are shared through PostgreSQL but there is no multi-instance deployment test.
- OCR accuracy has not been measured on an annotated set; no accuracy claim is made.
- See [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md) for everything gated or unavailable.
