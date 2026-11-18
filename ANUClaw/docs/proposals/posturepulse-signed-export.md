# Proposal: signed export bundle for PosturePulse `services/backend-api` (FOR REVIEW — NOT APPLIED)

> **READ FIRST — scope of this fix.** Explicit per-session grants are mandatory for the export route, and signing a report grants nothing (verified again
> 2026-11-17: the access service consults only `ClinicianSessionGrant`; unit + live tests refuse the signing clinician until granted). **This does NOT
> establish upstream-wide patient or session isolation.** About twenty other upstream routes are guarded by the clinician *role* only — any clinician can read
> or act on any session/patient through them, including full reports with withheld rows, raw events, the research export, the decrypted patient register and patient
> erasure. They are listed in the table below and are **unchanged by this proposal**. Treat the export fix as one closed door in a building whose other doors
> are open until the owners decide on a grant model for the rest.

**Status:** revised twice after security/contract review (2026-11-17): round 2 adds per-session authorisation and clearer integrity labelling. The diff is verified **only on an isolated scratch copy**; nothing in the
PosturePulse repository was changed and no signing secret exists anywhere. Apply it yourself from the repository root:
`git apply anuclaw-medbuddy-main/ANUClaw/docs/proposals/posturepulse-signed-export.diff` (`git apply --check` passes against the current tree;
sha256 `da052876…3514`, 12 files, +435 lines, **one additive migration**).

> **What HMAC does and does not give you.** The bundle is signed with a **shared secret**. A valid signature proves the bundle was
> produced by a holder of that secret and was not altered; **anyone who can verify can also forge**, and it provides **no independent
> attribution to a clinician**. `report.signOff.clinicianId` inside the bundle is a claim made by the upstream service, authenticated
> only as strongly as the shared secret. If independent attribution is needed, use an asymmetric signature (Ed25519, public key at ANUClaw)
> — a different design, not part of this change.

## Round 3 correction: the "signer" exception is removed

Round 2 also accepted "this clinician signed the session's released report" as authorisation. That was wrong: `POST /reports/:id/sign-off` (and `POST /sessions/:id/report`, `rows/exclude`, `assessment`)
are guarded by **role only**, so any clinician could build and sign a report for **any** session and thereby award themselves export access to a session they were never given.
Authorisation must not depend on a role-only action, so the exception is gone: **only an explicit operator-created grant authorises an export.** Consequence for operations: after the
migration the normal flow needs one `grant-session.ts` run per (clinician, session) — heavier, but it cannot be self-granted. Tests: `session-access.service.spec.ts` ("SIGNING IS NOT
AUTHORISATION": released, draft and rejected reports signed by the caller confer nothing) and the live HTTP test (the clinician who signed the report is refused 403 until granted).
The remainder of this section describes round 2; read every mention of "or the clinician signed" as superseded by this correction.

## Authorisation: the clinician role alone is NOT enough (round 2)

**Finding.** The upstream has no clinician↔session/patient ownership model at all. Inspected: `Clinician` is just `{id, username, passwordHash, role}`;
`RolesGuard` only checks `role === "clinician"` (its own comment: "no per-tenant scoping"); `Session` has no clinician column;
`PatientSubjectLink` links patients to subjects but no clinician to either; `SessionOwnershipGuard` covers only the *subject* token.
Round 1 therefore let **any clinician export any session** — "existing routes behave this way" is not a justification for a route that hands out a
signed, portable copy. Round 2 fixes it for the export with the smallest explicit access-control change, and records the same exposure on the other routes.

**Change (all additive; no behaviour of any existing route changes).**
| Piece | Behaviour |
|---|---|
| `ClinicianSessionGrant` table (+ migration `20261117120000_clinician_session_grant`) | `clinicianId, sessionId, grantedBy, grantedAt, revokedAt`. No row = no access. |
| `SessionAccessService.assertClinicianMayAccess(clinicianId, sessionId)` | Authorised iff **(1)** the clinician account exists in the database (a still-valid token of a deleted account fails) **and (2)** there is a non-revoked, operator-created grant for exactly (clinician, session). **Nothing else.** Missing/malformed identity → 403. Nothing is inferred from tenant ids, patient names, request bodies, model output — or from anything a role-only route lets a clinician do to themselves (see round 3). |
| Controller | Authorisation runs **first** (before the session, report or consent is read); unknown session and unauthorised session return the **same** 403 (no existence oracle); then consent/release checks; then signing. |
| `scripts/grant-session.ts <user> <sessionId> [--revoke] --by <operator>` | The only way to create/revoke a grant (needs database access). There is **deliberately no API to grant**, so a compromised clinician token cannot widen its own access. Each change writes an `AuditLogEntry`. |
| **Migration / backfill** | **No backfill.** After migration every existing session has zero grants, so nothing becomes exportable by assumption. **Nobody** — including the clinician who signed a report — can export an existing session until an operator grants access; a grant for an unreleased session still yields nothing until the report is released. |
| **Rollback** | `git apply -R` the diff, then `DROP TABLE "ClinicianSessionGrant"` (or leave the unused table). No existing data is touched. |

**Same exposure on other upstream routes (recorded, NOT changed by this proposal).** Every route below is guarded by role only, so any clinician can read
or act on any session/patient. They are the same class of problem and should be covered by the same grant model in a follow-up decision by the owners:

| Route(s) | Exposure |
|---|---|
| `GET /sessions`, `GET /sessions/:id` | any clinician lists/reads every session (subject pseudonym, state) |
| `GET /reports`, `GET /reports/:reportId`, `POST /reports/:id/rows/exclude`, `/assessment`, `/sign-off`, `/reject`, `POST /sessions/:id/report`, `GET /sessions/:id/report-preview` | read the **full** report (including withheld rows) and edit/sign/reject any draft |
| `GET /sessions/:sessionId/events`, `…/exposure/*`, `…/research-export` | raw event log / exposure data / research export for any session |
| `GET/POST /consent-records/:id/signatures` | consent signatures (sealed data) |
| `GET /patients`, `GET /patients/:id`, `/:id/sessions`, `/subject-names`, `DELETE /patients/:id` | decrypted patient register entries and **erasure** for any patient |
| `POST …/steps/:stepId/spotter-confirmation` (+GET), `GET /pilot-metrics`, `GET /audit-log`, adverse-events routes | trial/ops data |
| `GET /consent-records/:id`, `POST /consent-records`, `POST /sessions` | unauthenticated by design (subject app) — noted only |

**ANUClaw's own authorisation is separate and unchanged.** Importing or reading posture data in ANUClaw needs ANUClaw's patient access grant (`access('write'|'read', R.patient)`)
*and* an explicit admin-created subject link (`posture_subject_links`); a valid signed bundle or upstream token never substitutes for either.
`posturepulse-routes-pg.test.ts` (real PostgreSQL) proves a **valid** signed bundle is refused for a user with no grant (404), a read-only user (403) and an anonymous caller (401),
that nothing is stored by refused calls, that the other import routes enforce the same grants, and that a patient not linked to the bundle's subject cannot receive it.

## Review findings and how the revised proposal resolves them

| # | Finding in the first draft | Resolution |
|---|---|---|
| 1 | **It exported the FULL stored report body**, including rows a clinician had withdrawn and their free-text `excluded.reason` (which can contain identifiers). A valid signature is not permission to disclose them. | The bundle now carries **only the subject-authorised view** (the same rows `GET /sessions/:id/released-report` serves); withheld rows and reasons never leave. New method `ReportsService.latestReleasedView()` (+12 lines) returns the view and a count. |
| 2 | The sign-off digest `signOff.contentSha256` covers the withheld rows, so it cannot be recomputed from the authorised view. | **Explicit contract:** the bundle states `view: { kind: "subject_authorized", rowsWithheld: n, viewSha256 }`. With `n = 0` the digest is recomputable and ANUClaw requires it to match. With `n > 0` the digest is carried as a **signed claim**; ANUClaw requires it to be a well-formed SHA-256 and refuses any bundle whose rows contain a withheld (`excluded`) row (`bundle_contains_withheld_row`). Cost: for `n > 0` the digest cannot be independently re-verified at ANUClaw — only the bundle signature protects it. (The separate verified-upstream path still re-verifies the full digest because it fetches the full body with the clinician's own token.) |
| 3 | Export did not check consent state. | Refuses **403** if `revokedAt` or `withdrawalRequestedAt` is set or the `derived_events` scope is missing; refuses **404 `pending_review`** for drafts/rejected reports. ANUClaw re-checks the same on import (`consent_revoked`, `consent_withdrawal_requested`, expiry, future sign-off). |
| 4 | No key identifier, so no rotation; no bundle identity. | Payload carries `keyId` (from `EXPORT_SIGNING_KEY_ID`, default `v1`) and a random `bundleId`, both covered by the signature. ANUClaw accepts a **keyring** (`ANUCLAW_POSTUREPULSE_IMPORT_KEYS`) and records `signed:<issuer>:<keyId>:<bundleId>` as the import origin. |
| 5 | Replay. | `issuedAt` (ANUClaw accepts ±1 h), the unique constraint on (report, version, verification level) and `bundleId` recorded for audit. **Not** a nonce store: a captured bundle can be re-presented inside the hour, but re-importing is refused as `already_imported`. |
| 6 | Caching. | `Cache-Control: no-store` on the response. |
| 7 | Authorisation of the route. | `@UseGuards(JwtAuthGuard, RolesGuard) @Roles("clinician")` + `AuditLogInterceptor` (action `export_signed_bundle`; the bundle is not logged). A subject/report-access token is refused (checked by `signed-export.controller.spec.ts` and live). |
| 8 | Canonical serialisation. | Same `canonicalJson` as the report digest and ANUClaw's `canonicalJson`; ISO-string dates; the unit test re-computes the HMAC after a `JSON.parse(JSON.stringify())` round trip and the live test verifies the bundle after real HTTP transport. |

## Integrity claims — what each check does and does not establish

| Claim | Established by | Label in ANUClaw |
|---|---|---|
| The exported report is exactly what the exporter signed | `viewSha256` = sha256(canonical JSON of the exported report), **recomputed independently** at ANUClaw and compared (`view_digest_mismatch` otherwise), plus the HMAC over the whole payload | `integrity.exportedViewDigest` |
| The clinician sign-off digest (`signOff.contentSha256`) matches the signed body | **Only when `rowsWithheld = 0`**: ANUClaw recomputes it over the full body (`digest_status = recomputed_full_body`) | `integrity.signOffDigest`: "Recomputed here…" |
| …when rows were withheld | **Not re-derivable** (the digest covers rows that were not exported). It is stored as `digest_status = upstream_signed_claim_not_recomputable` and shown as "UPSTREAM SIGNED CLAIM … not an independently verified sign-off; only the bundle signature (shared secret) vouches for it" | same field |
| Who produced the bundle | HMAC with a **shared secret**: authenticates *a holder of the secret*, **not** which clinician signed. `signOff.clinicianId` is the upstream service's claim | `integrity.authentication`: "…NOT which clinician signed" |
| The verified-upstream path | ANUClaw fetches the full body with the clinician's own token and recomputes the digest (`recomputed_full_body`) | — |

## Known limits that remain (decide before applying)

1. **Other upstream routes still have no per-session scoping** (table above). The export no longer shares that gap; the rest is a decision for the owners. The grant mechanism is operator-run (CLI), not self-service — operationally heavier but not escalatable from a token.
2. **Digest for `rowsWithheld > 0` is a signed claim**, see finding 2.
3. **Shared secret** (above). Rotation requires coordinated change of both sides; the keyring lets both keys coexist during the changeover.
4. Revocation after export cannot recall a bundle already imported; ANUClaw has no automatic purge on upstream revocation (a separate feature).
5. The bundle contains pseudonymous subject data; use TLS (or loopback) and keep it out of logs.

## Configuration variable names (no values are set by this change)

| Where | Variable | Meaning |
|---|---|---|
| PosturePulse backend | `EXPORT_SIGNING_SECRET` | ≥ 32 chars (recommended: `openssl rand -hex 32`); unset/short → the route returns 503 |
| PosturePulse backend | `EXPORT_SIGNING_KEY_ID` | optional, `[A-Za-z0-9_.-]{1,64}`, default `v1` |
| ANUClaw | `ANUCLAW_POSTUREPULSE_IMPORT_KEYS` | JSON `{ "<keyId>": "<secret>" }` (preferred; supports rotation) |
| ANUClaw | `ANUCLAW_POSTUREPULSE_IMPORT_SECRET` | single secret (used only for bundles without a `keyId`) |

## Migration and rollback

- **One additive migration** (`ClinicianSessionGrant`, no backfill — see Authorisation); no change to existing routes or stored data. The only touch to existing code is one additive method in `ReportsService`, two lines in `app.module.ts` and the Prisma schema.
- **Enable:** apply the diff, set `EXPORT_SIGNING_SECRET` (and optionally `EXPORT_SIGNING_KEY_ID`) in the backend environment (never in the repo), set the matching key in ANUClaw, restart.
- **Rotate:** add the new key to ANUClaw's keyring, switch the backend to the new secret + new key id, remove the old key after one hour (the replay window) plus any in-flight imports.
- **Disable/rollback:** unset `EXPORT_SIGNING_SECRET` (route → 503) or `git apply -R` the diff and drop the `ClinicianSessionGrant` table; imported records remain valid and labelled `signed_bundle_verified`.
- **Operator runbook:** after `prisma migrate deploy`, grant a clinician access to a session with `npx ts-node scripts/grant-session.ts <username> <sessionId> --by <your-name>` (add `--revoke` to remove).

## Evidence (isolated scratch copy; real chain; synthetic mannequin clip) — scratch-only, not applied

| Check | Result |
|---|---|
| Backend jest, whole suite, with the patch | **50 suites / 544 tests pass** (new: 10 access-service tests, 1 controller-ordering test, 10 service tests, 2 controller-metadata tests) |
| Access tests | clinician A cannot export clinician B's session (granted or signed to B); authorised access (grant or signer) succeeds; revoked grant refused; **no grants + no sign-offs (every pre-migration session) → denied for everyone**; missing/malformed identity and a deleted clinician account → denied; unknown session = same 403 as unauthorised; the export builder is never reached when denied |
| Disclosure tests | revoked or withdrawn consent, missing scope, unreleased/draft report → no bundle object; withheld row and its reason text absent from the bundle; key-id swap and value tamper change the HMAC; rotation: old bundle does not verify under the new key |
| Live HTTP on the scratch backend (real pipeline, real Prisma/PostgreSQL, 2 clinicians) | signer **403 until granted**, then 200 · other clinician 403 with no bundle content · no token 401 · explicit grant → 200 · revoke → 403 · non-existent session 403; bundle has `rowsWithheld`, no withheld metric/reason; ANUClaw verifies via keyring and imports; tamper/wrong secret/subject token refused. Run twice (with and without a withdrawn row): 7/7 each |
| ANUClaw side (real PostgreSQL) | `upstream.test.ts`, `posturepulse-pg.test.ts` (integrity labels, view-digest mismatch refused, digest status per path), `posturepulse-routes-pg.test.ts` (5: patient authorization enforced) |
| `git apply --check` on the real repo | OK; **not applied**; no secret exists anywhere |

Scratch note: running Prisma in the scratch copy regenerates the shared generated client in `node_modules`; it was regenerated from the real, unchanged schema afterwards (outer client has no grant model, verified).
