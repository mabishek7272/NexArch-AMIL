# ANUClaw API — Developer Reference

> **Status of this document.** The authoritative, tested contract for the versioned API is [openapi-v1.json](openapi-v1.json)
> (`/v1/...`, validated and route-checked in CI). Sections below that describe the older `/api/v1` skill-runner,
> webhooks and SDK examples were written for a hosted offering: the hostname `api.anuclaw.amgi-research.com` is **not a
> deployed service**, claims such as "1100+ skills" and regulatory compliance are **not** supported by this checkout
> (13 skill directories; no certification), and nothing here is clinical advice or a validated medical device. Use the
> local base URL `http://127.0.0.1:4000` with synthetic data.


**Built by AMGI Research (Abi and Anu)**  
**Base URL:** `https://api.anuclaw.amgi-research.com/api/v1`  
**Local dev:** `http://localhost:4000/api/v1`

---

## Overview

The ANUClaw API lets any company integrate ANUClaw's 1100+ domain skills — genomics, drug discovery, clinical decision support, EHR/patient records, lab automation, protein design, and regulatory compliance — directly into their own application (see the status note above for what is actually implemented).

Your application calls our API. ANUClaw runs the agent, executes the skill in an isolated container, and returns the result. You never need to host a model or manage infrastructure.

---

## Quick Start (3 steps)

### Step 1 — Get your tenant and API key

Tenants are **created by an administrator** (`POST /api/v1/admin/tenants`, see below); you receive your
`tenant_id` and first `api_key` from them. Public self-service registration is closed unless the operator sets
`ANUCLAW_SELF_REGISTRATION=open` (for example in a local sandbox). When it is open:

```bash
curl -X POST https://api.anuclaw.amgi-research.com/api/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Acme Pharma",
    "email": "dev@acmepharma.com"
  }'
```

Self-registered tenants are always on the `free` plan (sending any other `plan` is refused with
`plan_requires_admin`); when registration is closed the call returns `403 registration_closed`.

Response:
```json
{
  "message": "Registration successful. Store your API key securely — it will not be shown again.",
  "tenant_id": "3f2a1b4c-...",
  "company_name": "Acme Pharma",
  "plan": "free",
  "api_key": "amgi_live_a1b2c3d4e5f6..."
}
```

> Store `api_key` immediately. It is shown only once; if it is lost an administrator rotates it.

---

### Step 2 — Call a skill

```bash
curl -X POST https://api.anuclaw.amgi-research.com/api/v1/skills/anuclaw-drug-discovery/run \
  -H "X-API-Key: amgi_live_a1b2c3d4e5f6..." \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Predict ADMET properties for the compound SMILES: CC(=O)Oc1ccccc1C(=O)O"
  }'
```

Response:
```json
{
  "skill": "anuclaw-drug-discovery",
  "group_id": "api-3f2a1b4c-...-1717000000",
  "result": "...",
  "tenant_id": "3f2a1b4c-..."
}
```

---

### Step 3 — Register a patient (EHR)

```bash
curl -X POST https://api.anuclaw.amgi-research.com/api/v1/ehr/patients \
  -H "X-API-Key: amgi_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jane",
    "last_name": "Smith",
    "date_of_birth": "1985-04-12",
    "gender": "female",
    "country_code": "US"
  }'
```

Response includes the issued UID:
```json
{
  "result": {
    "uid": "AMGI-US-2026-0000001",
    "uid_status": "issued",
    "country_code": "US",
    ...
  }
}
```

---

## Public scientific data (research-only)

`/v1/science/*` (API key) and the dashboard's `/api/science/*` expose connectors for AlphaFold DB, RCSB PDB, NCBI Datasets and GEO:
describe an accession, retrieve selected files with full provenance (URL, version, SHA-256, licence, attribution, classification),
inspect structured parser summaries, pin sources to a tenant-scoped workspace and export a manifest. Responses are labelled `researchOnly: true`;
downloaded data is **not** clinical evidence and is never added to the approved evidence corpus. Details, limits and error codes:
[SCIENCE-DATA.md](SCIENCE-DATA.md); the machine-readable contract is [openapi-v1.json](openapi-v1.json).

## Authentication

All endpoints except `/health` and `/register` require authentication.

### Method 1 — API Key (simplest)

Add your API key as a header:

```
X-API-Key: amgi_live_<your_key>
```

### Method 2 — JWT Bearer Token (recommended for production)

Exchange your API key for a short-lived JWT (valid 1 hour):

```bash
curl -X POST /api/v1/token \
  -H "X-API-Key: amgi_live_..."
```

Then use the JWT in subsequent requests:

```
Authorization: Bearer <jwt>
```

---

## Plans & Limits

All plans are currently **unlimited** — no rate limits, no monthly quotas.
Use as much as you need.

| Plan | Rate limit | Monthly quota |
|---|---|---|
| **free** | Unlimited | Unlimited |
| **pro** | Unlimited | Unlimited |
| **enterprise** | Unlimited | Unlimited |

Usage is still tracked and available via `GET /api/v1/usage` for your own monitoring.

---

## Endpoints

### Authentication & Account

#### `POST /register`
Register a new company.

**Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `company_name` | string | ✅ | Your company name |
| `email` | string | ✅ | Contact email (unique) |
| `plan` | string | — | `free` (default), `pro`, `enterprise` |

---

#### `POST /token`
Exchange API key for JWT.

**Header:** `X-API-Key: amgi_live_...`

**Response:** `{ access_token, token_type, expires_in, tenant_id, plan }`

---

#### `GET /account`
Get your account details, plan, and usage.

---

#### `PUT /account/plan`
**Not available to tenants.** Always returns `403 plan_change_requires_admin`. A tenant cannot change its own plan
or limits; an administrator does it with `PUT /api/v1/admin/tenants/:id/plan`.

---

#### Authentication errors

Authentication failures return `401` with a `code`:

| `code` | Meaning |
|---|---|
| `unauthorized` | Unknown or malformed key (deliberately generic) |
| `key_revoked` | The key was revoked, or the key a token was issued from was revoked |
| `key_expired` | The key's expiry time has passed |
| `tenant_suspended` | The tenant is suspended |
| `api_key_required` | `POST /token` must be called with an API key, not with another token |

A token is bound to the API key that minted it: revoking or expiring that key ends its tokens too.

---

#### Administrator API (`X-Admin-Key`)

Fail-closed: returns `503` unless the operator has set `ADMIN_API_KEY`. Errors are `{ "error": { "code", "message", "requestId" } }`.
An optional `X-Admin-Actor` header is recorded in the audit entry as an unverified label.

| Method & path | Purpose |
|---|---|
| `POST /api/v1/admin/tenants` | Create a tenant and its first key (`company_name`, `email`, `plan?`). The key is shown once. |
| `GET /api/v1/admin/tenants?limit&offset` | List tenants with their active-key count |
| `POST /api/v1/admin/tenants/:id/suspend` · `/reactivate` | Block or restore a tenant's keys and tokens |
| `PUT /api/v1/admin/tenants/:id/plan` | Change a plan (`free`, `pro`, `enterprise`) |
| `GET /api/v1/admin/tenants/:id/keys` | List keys (prefix, label, scopes, expiry, last use; never the key or its hash) |
| `POST /api/v1/admin/tenants/:id/keys` | Create another key (`label?`, `scopes?`, `expires_at?` epoch ms). At most 10 active keys per tenant. |
| `POST /api/v1/admin/tenants/:id/keys/:keyId/rotate` | New key now; the old key lapses after `grace_seconds` (default 86400, `0` = revoke now, max 30 days) |
| `POST /api/v1/admin/tenants/:id/keys/:keyId/revoke` | Revoke immediately (idempotent); `reason?` |
| `GET /api/v1/admin/tenants/:id/audit` | That tenant's hash-chained audit entries and a chain verification result |
| `GET /api/v1/admin/skills` | Every skill (agent and interpretation) with how many tenants have it |
| `POST /api/v1/admin/skills` | Register an interpretation skill: `{ "manifest": { id, version, title, acceptsAnalysisTypes, adapterId, inputSchema, prompts, riskTier, clinicalDomain?, requiresRelease } }`. Strict validation; the adapter must be a known, code-defined one. |
| `PATCH /api/v1/admin/skills/:skillId` | `{ enabled? }` for any skill; `{ manifest? }` for an interpretation skill — a manifest change needs a **new version** of the same id |
| `GET /api/v1/admin/adapters` | Declared adapters and whether each is implemented (a skill can only be assigned once its adapter is) |
| `GET /api/v1/admin/tenants/:id/skills` | A tenant's assignments |
| `PUT /api/v1/admin/tenants/:id/skills/:skillId` | Assign or update (`enabled?`, `config?` ≤ 4 KB); idempotent. Refused if the skill is disabled, its adapter is unavailable, or it is clinical-tier and the tenant lacks clinical access. |
| `DELETE /api/v1/admin/tenants/:id/skills/:skillId` | Unassign |

Skill assignments are audited on the tenant's chain; registry changes on the platform chain. Configuration **values**
are never written to the audit chain, only the key names.

Every change above is written to the tenant's audit chain in the same database transaction as the change itself.

---

#### `PUT /account/webhook`
Register (or change) the HTTPS endpoint that receives signed **interpretation events** (see [Webhooks](#webhooks)). Body: `{ "url": "https://your-app.com/webhook" }`.

The URL must be `https`, carry no credentials, use port 443 or 1024-65535, and resolve only to public addresses (private, loopback, link-local and cloud-metadata ranges are refused with `400 webhook_url_rejected`). The first registration returns `signing_secret` **once**; later changes keep the secret. A server without `ANUCLAW_WEBHOOK_SECRET_KEY` answers `503 webhook_signing_unavailable`. Related: `GET /account/webhook`, `DELETE /account/webhook`, `POST /account/webhook/secret/rotate`, `GET /account/webhook/deliveries`.

> Earlier versions of this document said a skill run would POST its result to this URL. That was never implemented; skill runs are synchronous and return their result in the response.

---

### Skills

A tenant can use only the skills **assigned to it by an administrator** (see the administrator API below). An
unassigned, unknown or malformed skill id is refused identically, so the catalogue cannot be probed:

| Status | `code` | Meaning |
|---|---|---|
| 403 | `skill_not_assigned` | Not assigned (or no such skill, or the assignment is switched off) |
| 403 | `skill_disabled` | An administrator has disabled the skill |
| 403 | `skill_not_released` | The skill requires a release that has not been granted |
| 403 | `clinical_access_required` | A clinical-tier skill needs the clinical scope, an active BAA and the enabled domain |
| 400 | `not_an_agent_skill` | The skill belongs to the interpretation API, not the agent runner |
| 404 | `skill_unavailable` | Assigned, but its file is missing on this server |
| 503 | `skill_unavailable` | An interpretation skill whose adapter is not implemented yet |

A refused request is not counted against the monthly quota and does not hold an agent slot. Tenants that existed
when the registry was introduced were assigned every agent skill once, so their access did not change; new tenants
start with none.

#### `GET /skills`
List the skills **assigned to your account** (assigned, enabled and permitted).

**Response:**
```json
{
  "skills": [
    { "name": "anuclaw-genomics", "description": "..." },
    { "name": "anuclaw-drug-discovery", "description": "..." },
    { "name": "anuclaw-clinical", "description": "..." },
    ...
  ]
}
```

---

#### `POST /skills/:skill/run`
Execute a skill with a natural-language prompt.

**Path param:** `:skill` — one of the skill names from `GET /skills`

**Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | ✅ | The task or question |
| `group_id` | string | — | Session ID. Reuse across calls to share memory. |
| `max_turns` | number | — | Max agent reasoning steps. Default: 5 |
| `stream` | boolean | — | Stream chunks as NDJSON. Default: false |

**Example — genomics:**
```bash
curl -X POST /api/v1/skills/anuclaw-genomics/run \
  -H "X-API-Key: ..." \
  -d '{
    "prompt": "Run a BLAST search for this sequence: ATGCGATCGATCG and identify the organism",
    "group_id": "my-research-session-1"
  }'
```

**Example — drug discovery:**
```bash
curl -X POST /api/v1/skills/anuclaw-drug-discovery/run \
  -d '{ "prompt": "What are the drug-drug interactions between warfarin and aspirin?" }'
```

**Example — clinical:**
```bash
curl -X POST /api/v1/skills/anuclaw-clinical/run \
  -d '{ "prompt": "Summarise the latest clinical trials for PD-1 inhibitors in NSCLC" }'
```

**Streaming response (NDJSON):**
```json
{"type":"chunk","text":"Running ADMET analysis..."}
{"type":"chunk","text":"Lipophilicity (LogP): 1.2..."}
{"type":"done","result":"...","skill":"anuclaw-drug-discovery","group_id":"..."}
```

---

#### `POST /skills/run`
Same as above but `skill` is in the request body (useful if the skill name is dynamic).

**Body:** `{ "skill": "anuclaw-genomics", "prompt": "..." }`

---

### EHR / Patient Records

> All EHR endpoints enforce the UID authority rule.
> UIDs must be issued by the EHR system — they cannot be invented or submitted externally.

---

#### `POST /ehr/patients`
Register a new patient and receive a country-scoped UID.

**Body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `first_name` | string | ✅ | |
| `last_name` | string | ✅ | |
| `date_of_birth` | string | ✅ | ISO 8601: `YYYY-MM-DD` |
| `gender` | string | ✅ | `male`, `female`, `other` |
| `country_code` | string | ✅ | ISO 3166-1 alpha-2: `US`, `IN`, `GB`, `AU`… |
| `blood_group` | string | — | e.g. `A+` |
| `allergies` | array | — | List of allergy strings |
| `phone` | string | — | |
| `email` | string | — | |
| `insurance_provider` | string | — | |

**UID format returned:** `AMGI-{CC}-{YYYY}-{NNNNNNN}`

---

#### `GET /ehr/patients/:uid`
Look up a patient by their UID.

```bash
GET /api/v1/ehr/patients/AMGI-US-2026-0000001
```

---

#### `GET /ehr/patients/search`
Find all UIDs for a patient across countries.

```
GET /api/v1/ehr/patients/search?first_name=Jane&last_name=Smith&date_of_birth=1985-04-12&gender=female
```

---

#### `POST /ehr/patients/:uid/diagnoses`
Add a diagnosis to a patient record.

**Body:**
| Field | Type | Required |
|---|---|---|
| `description` | string | ✅ |
| `icd10_code` | string | — |
| `snomed_code` | string | — |
| `severity` | string | — |
| `diagnosed_by` | string | — |

---

#### `POST /ehr/patients/:uid/prescriptions`
Add a prescription.

**Body:** `medication_name`, `dosage`, `frequency`, `start_date` (required) + `route`, `prescribed_by`, `indication` (optional)

---

#### `POST /ehr/patients/:uid/lab-reports`
Add a lab report.

**Body:** `test_name`, `value` (required) + `unit`, `loinc_code`, `reference_range`, `flag`, `ordered_by` (optional)

---

#### `POST /ehr/patients/:uid/hl7`
Generate an HL7 ADT A01 admission message.

**Body:** `{ "ward": "WARD^001^01^HOSPITAL" }` (optional)

---

#### `POST /ehr/patients/:uid/fhir`
Convert patient profile to a FHIR R4 Patient resource.

---

### Usage

#### `GET /usage`
Get your usage stats, daily breakdown, and top skills.

```json
{
  "plan": "pro",
  "usage_this_month": 142,
  "monthly_quota": 5000,
  "usage_total": 1034,
  "daily_breakdown": [
    { "day": "2026-06-12", "calls": 23 },
    ...
  ],
  "top_skills": [
    { "skill": "anuclaw-drug-discovery", "calls": 58 },
    ...
  ]
}
```

---

## SDKs & Code Examples

### Python

```python
import requests

API_KEY = "amgi_live_..."
BASE    = "https://api.anuclaw.amgi-research.com/api/v1"
HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

# Run a drug discovery skill
resp = requests.post(
    f"{BASE}/skills/anuclaw-drug-discovery/run",
    headers=HEADERS,
    json={"prompt": "Dock aspirin against COX-2 (PDB: 5KIR) and report the binding score"}
)
print(resp.json()["result"])

# Register a patient
resp = requests.post(
    f"{BASE}/ehr/patients",
    headers=HEADERS,
    json={
        "first_name": "Alice", "last_name": "Patel",
        "date_of_birth": "1990-03-22", "gender": "female",
        "country_code": "IN"
    }
)
uid = resp.json()["result"]["uid"]   # AMGI-IN-2026-0000001
print(f"Patient UID: {uid}")
```

### JavaScript / TypeScript

```typescript
const BASE    = 'https://api.anuclaw.amgi-research.com/api/v1';
const API_KEY = 'amgi_live_...';

async function runSkill(skill: string, prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/skills/${skill}/run`, {
    method:  'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ prompt }),
  });
  const data = await res.json();
  return data.result;
}

// Example
const result = await runSkill('anuclaw-clinical', 'Explain the mechanism of metformin in T2DM');
console.log(result);
```

### cURL (shell scripts)

```bash
# One-liner skill run
curl -s -X POST "$BASE/skills/anuclaw-genomics/run" \
  -H "X-API-Key: $ANUCLAW_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Align these two sequences and report identity: ATGCGA and ATGCTA"}' \
  | jq .result
```

---

## Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | Bad Request | Missing or invalid fields |
| 401 | Unauthorized | Invalid or missing API key / JWT |
| 404 | Not Found | Skill or resource not found |
| 409 | Conflict | Email already registered |
| 429 | Too Many Requests | Rate limit or monthly quota exceeded |
| 500 | Internal Server Error | Skill execution or server error |

---

## Webhooks

ANUClaw notifies your endpoint when an interpretation job (`POST /v1/interpretations`) finishes. Events are `interpretation.completed` and `interpretation.failed`. They carry ids, status and hashes only, never a subject reference, a value or an identifier; fetch the findings with the link in the event.

```bash
curl -X PUT $BASE/api/v1/account/webhook -H "X-API-Key: ..." -H "Content-Type: application/json" \
  -d '{ "url": "https://your-app.com/anuclaw-webhook" }'
# -> { "message": "Webhook registered.", "url": "...", "signing_secret": "whsec_..." }   (shown once)
```

Delivery body:

```json
{ "id": "evt_...", "type": "interpretation.completed", "createdAt": "2026-11-23T08:31:00.000Z",
  "data": { "jobId": "job_...", "skillId": "physiological-signal-interpretation", "status": "completed",
            "findingsSha256": "...", "links": { "self": "/v1/interpretations/job_...", "findings": "/v1/interpretations/job_.../findings" } } }
```

Headers: `Anukla-Signature: t=<unix seconds>,v1=<hex>`, `Anukla-Event-Id`, `Anukla-Event-Type`, `Anukla-Delivery-Attempt`.

**Verify every request**, using the RAW body bytes before parsing: compute `HMAC-SHA256(signing_secret, "<t>.<raw body>")` as hex, compare with `v1` in constant time, and reject a `t` more than 5 minutes from your clock. The timestamp is inside the signed text, so a captured request cannot be replayed with a fresh timestamp. Deduplicate on `Anukla-Event-Id`: a retry re-sends the identical body and event id (with a fresh `t`).

```js
const crypto = require('crypto');
function verify(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
  return ok && Math.abs(Date.now() / 1000 - Number(parts.t)) <= toleranceSec;
}
```

**Delivery rules.** Only a `2xx` response counts as delivered; anything else, including a redirect (never followed), is a failure. The first attempt is immediate, then retries after 1 min, 5 min, 30 min, 2 h and 12 h (six attempts at most; nothing is pending past 24 h from the first attempt), after which the delivery is `dead`. `GET /account/webhook/deliveries` shows status, attempts and error codes (never response bodies). Responses are read up to a small cap and discarded. The destination address is re-validated and pinned on every attempt. Rotate the secret with `POST /account/webhook/secret/rotate`.

---

## Data Isolation

Each company's data is fully isolated:

- All agent containers run in separate Linux namespaces
- Memory and session data is scoped to `api-{tenant_id}-{group_id}`
- No tenant can access another tenant's data
- Patient UIDs are stored in the EHR authority store; only the EHR skill can issue them
- No training or learning from tenant API calls

---

## Contact

Built by **AMGI Research — Abi and Anu**  
Enterprise plans, custom skill development, on-premise deployment: contact AMGI.


## AlphaFold DB update — 18 November 2026

`POST /v1/science/alphafold/lookup`, `GET /v1/science/alphafold/lookups/{id}`, `POST /v1/science/alphafold/import`, and `GET /v1/science/alphafold/imports/{id}` use existing tenant authentication/quotas. Dashboard `/api/science/alphafold` adds owner-only project attachment/receptor operations. [Request formats, errors, limits and runbook](ALPHAFOLD-DB-INTEGRATION.md#application-api).

## Interpretation intake (`/v1/interpretations`)

A tenant app posts its own AI output (`interpretation-request/v1`, see `src/interpretation/contracts/`) and polls for the result. The skill in the body must be assigned to the tenant (`403 skill_not_assigned` otherwise). Errors use `{error:{code,message,requestId}}`.

| Method & path | Result |
|---|---|
| `POST /v1/interpretations` | `202` + `Location`; job `queued`. Optional `Idempotency-Key` (8-200 chars): same key and body returns the original job (`200`, `Idempotent-Replayed: true`); same key, different body `409 idempotency_key_reused`. `400 validation_failed` (paths only, never values), `400 analysis_type_not_accepted`, `503 identity_storage_unavailable` if `subject.identity` is sent without a configured vault. |
| `GET /v1/interpretations?limit&offset` | The caller's jobs, newest first. |
| `GET /v1/interpretations/:id` | Status: `queued`, `processing`, `completed`, `failed`. Another tenant's job is `404`. |
| `GET /v1/interpretations/:id/findings` | `normalized-findings/v1` once completed; `409 findings_not_ready` before. |

Submitting counts against the monthly quota; polling is rate-limited but not counted. `subject.identity` is split off into an AES-256-GCM vault (`ANUCLAW_IDENTITY_VAULT_KEY`) and never appears in stored payloads, findings, audit entries or any later model input. Malformed JSON is `400 invalid_json`; an oversized body is `413 payload_too_large`. A worker (`ANUCLAW_INTERPRETATION_WORKER=true`) normalises queued jobs; P3a ships the beAIve adapter (`beaive-v1`).

### Subject erasure (`/v1/subject-erasures`)

`POST /v1/subject-erasures` with `{ "externalRef": "<subject reference>", "confirm": true, "reason"?: "subject_request" | "consent_withdrawn" | "tenant_request" | "other" }` permanently erases everything held about that subject of YOUR tenant, in one transaction. `confirm: true` is required (`400 confirmation_required` otherwise). It is not metered against your quota.

- **Erased:** the sealed identity, the stored source payload, the normalized findings, and the stored bytes of every webhook event about those jobs (events not yet sent are cancelled).
- **Kept as tombstones:** each job row stays, with status `erased`, `subjectRef` and `capturedAt` null, the idempotency key freed (replaying the old request creates a NEW job) and its hashes cleared. `GET /v1/interpretations/:id/findings` answers `410 subject_erased`.
- **In-flight jobs** (queued or being processed) are stopped; a worker cannot write findings back afterwards.
- **Receipt (200):** `{ erasureId, requestedAt, reason, jobsErased, identitiesDeleted, payloadsDeleted, findingsDeleted, deliveriesScrubbed, jobIds }`. Erasing again, or an unknown subject, erases nothing and returns a receipt of zeros. `GET /v1/subject-erasures` lists your receipts (counts and a hash of the erased job ids; never the subject reference).
- **Audit:** one `subject.erased` entry is appended to your tamper-evident audit chain (counts, reason, a hash of the job ids; no subject reference or identifier). The chain is append-only by design, so its earlier entries remain; they hold job ids, skill ids and hashes of the identity-free stored payloads only.
- **Not covered here:** database backups and logs outside the application tables follow the operator's own retention process.

### PosturePulse input (`posture-analysis-interpretation`)

This skill reads PosturePulse's own report in `nativePayload` instead of generic `findings` (a request carries one or the other, never both; the wrong form is `400 input_form_not_accepted`). Set `nativePayload` to `{ "format": "posturepulse-assessment/v0", "bundle": <signed bundle> }` or `{ "format": "posturepulse-assessment/v0", "unsigned": { consentRecord, session, report, symptomReports? } }`.

- `bundle` is verified at intake with the configured shared secret by the same code as the patient importer: signature, contract, withheld-row refusal, view digest, session/subject/consent binding, consent state and timestamps. Refusals are immediate and store nothing: `403 bad_signature`, `409 report_not_released`, `503 import_secret_not_configured`, `422 contract_violation`. The signature itself is not stored.
- `unsigned` is only schema-checked. It is accepted, labelled `sourceVerification.level = "unverified_payload"` and carries a **blocking** `unverified_source` flag. It is never upgraded.
- `subject.externalRef` must equal the session's `subjectPseudoId` (`422 subject_mismatch`).
- The findings keep each row's `side`, `stepId`, `signConvention`, `tier` (a proxy stays a proxy), the source's own `sourcePosition`, the reference's `status` (draft or approved), `unsupportedReasons` and any clinician exclusion, plus the standing `notMeasurable` list. Symptom reports raise a blocking `symptom_reported` flag; their free text is never carried into findings.


### Reports (`/v1/interpretations/:id/report`)

When a skill produces reports, a completed job gets a report that goes governed, narrated, then ready (poll `GET /v1/interpretations/:id/reports`, or use the `interpretation.report_ready` webhook).

```
GET /v1/interpretations/:id/report?layer=clinical|layman&format=json|html|pdf
GET /v1/interpretations/:id/reports
```

- `layer` is required. `clinical` is for a professional; `layman` is plain language. Both layers come from the same findings.
- `json` returns `{ reportId, version, layer, reviewState, statusBanner, contentSha256, report }`; `html` is a self-contained page; `pdf` repeats the status banner on every page.
- `reviewState` is `ai_reviewed` (checked automatically, NOT by a clinician), `awaiting_clinician` (needs a clinician before it should be relied on), `clinician_signed` (a named clinician signed it; the banner names them) or `rejected`. Only a named, provisioned clinician can sign, and no API route signs. A signed report is a NEW version: `GET .../reports` lists both, and `.../report` serves the newest. Nothing here is a diagnosis.
- Errors: 400 bad `layer` or `format`; 404 not found (also another tenant's job); 409 `report_not_ready`; 410 `subject_erased`; 503 `pdf_renderer_unavailable` (use `format=html`).
- Branding (administrator): `PUT /api/v1/admin/tenants/:id/branding` with `{ "productName"?, "logoBase64"? }`. Only a product name and a PNG/JPEG logo (256 KB) can be set; the governance statement, banner and referral advisory cannot be changed.
- Webhook events: `interpretation.report_ready` (sent again when a clinician signs a new version), `interpretation.report_rejected` and `interpretation.report_failed`: ids, hashes and review state only.
- Administrator: `GET /api/v1/admin/review-queue?kind=all|awaiting|follow_up` lists what needs a clinician (identifiers, content hash and reason codes only; read-only).

### Timeline and comparison (`/v1/interpretations/:id/timeline`, `/compare`)

```
GET /v1/interpretations/:id/timeline?skillId=&findingKey=&limit=
GET /v1/interpretations/:id/compare?with=<jobId>
```

- Scans are addressed by job id; the subject reference is never in a URL or a response. The timeline lists the same subject's scans (same skill unless `skillId` is given), oldest first, with each scan's current report state. With `findingKey` it adds that finding's values over time and a step between neighbours.
- `compare` returns `longitudinal-comparison/v1`: per finding `within_uncertainty`, `beyond_uncertainty` or `not_comparable` (with a reason), using only the uncertainty the source reported for both values. It states direction ("the later value is higher or lower") only beyond uncertainty and never says improved or worsened. Two scans less than 30 minutes apart that disagree raise `short_interval_discrepancy` instead of showing a change over time. A different source model, version or calibration makes numeric findings `not_comparable`.
- Errors: 400 validation; 404 not found (also another tenant's job); 409 `findings_not_ready`, `different_subjects`, `different_skills` or `integrity_error`; 410 `subject_erased`.

### Per-tenant narrative setting (administrator)

`PUT /api/v1/admin/tenants/:id/skills/:skillId` accepts `config.narrative = { "enabled": true, "model": "google/gemini-4-hydrogen" }` for an interpretation skill. Narratives are **off** unless enabled; off means fixed-template explanations and no model call. `model` must be on the allow-list (`ANUCLAW_NARRATIVE_MODELS`, default `google/gemini-4-hydrogen,google/gemini-4-argon`); an unknown field, an unlisted model, or `enabled` without a model is `400 validation_failed`. The model's text is used only if it passes every automatic guard (no invented numbers or ranges, no diagnosis, no reassurance, every flagged finding covered); otherwise the fixed template is used and the report carries a review flag.
