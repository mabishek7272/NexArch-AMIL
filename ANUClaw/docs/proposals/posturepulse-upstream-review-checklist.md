# Upstream review checklist — PosturePulse signed export (NOT APPLIED)

Purpose: the exact approvals needed from the **PosturePulse repository owners** before [posturepulse-signed-export.diff](posturepulse-signed-export.diff) is applied. Scope here is *readiness dependencies only*; the technical design is reviewed in
[posturepulse-signed-export.md](posturepulse-signed-export.md). **Nothing was applied, no upstream file was changed, no secret exists.** The diff is verified only on an isolated scratch copy (12 files, +435 lines, one additive migration, `git apply --check` OK, sha256 `da052876…3514`).

> Reminder from the proposal: explicit per-session grants make **the export route** safe from self-granting; they do **not** establish upstream-wide patient or session isolation. About twenty other routes are role-only and unchanged.

Each line must be answered **Approved / Rejected / Needs change** by the named owner, with date and reference. Leave unsigned boxes unchecked.

## A. Decisions the upstream owners must make (all required)

| # | Decision | Why it blocks application | Owner (role) | Decision / ref |
|---|---|---|---|---|
| A1 | **Authorisation model:** accept operator-created `ClinicianSessionGrant` as the only authorisation for export (no signer exception, no self-service grant API) | defines who may export a portable signed copy | Upstream security/product owner | |
| A2 | **Operations burden:** accept one `grant-session.ts` run per (clinician, session) after migration, no backfill (nobody can export existing sessions until granted) | changes day-to-day operations | Operations owner | |
| A3 | **Other role-only routes:** decide whether/when to apply a grant model to the ~20 routes listed in the proposal (reports with withheld rows, raw events, research export, patient register, **patient erasure**) — or accept the exposure in writing | the export fix leaves these open | Upstream security owner + clinical lead | |
| A4 | **Signature scheme:** accept HMAC with a shared secret (no independent attribution to a clinician; verifier can forge), **or** require an asymmetric design (Ed25519) instead | determines what the signature means | Security owner | |
| A5 | **Disclosure scope:** confirm the bundle carries only the subject-authorised view; confirm the contract for `rowsWithheld > 0` (the sign-off digest is an upstream signed *claim*, not recomputable) | privacy / integrity semantics | Privacy officer + clinical lead | |
| A6 | **Consent rules:** confirm refusal on revoked / withdrawal-requested consent or missing `derived_events` scope, and `pending_review` for unreleased reports | consent law and policy | Privacy officer | |
| A7 | **Replay window and bundle identity:** accept ±1 h, `bundleId` recorded, no nonce store | residual replay risk | Security owner | |
| A8 | **Revocation limits:** accept that a bundle already imported cannot be recalled and ANUClaw has no automatic purge | data-subject rights process | Privacy officer | |

## B. Secrets and configuration (variable names only; no values exist)

- [ ] Process for generating, storing and rotating `EXPORT_SIGNING_SECRET` (≥ 32 chars) and `EXPORT_SIGNING_KEY_ID` in the upstream secrets manager — owner: security lead
- [ ] Matching `ANUCLAW_POSTUREPULSE_IMPORT_KEYS` (keyring) provisioning on the ANUClaw side — owner: engineering lead
- [ ] Rotation drill defined (add new key at ANUClaw → switch backend → remove old key after the replay window) — owner: operations
- [ ] Transport requirement: TLS (or loopback) only; bundles kept out of logs — owner: security lead

## C. Technical approvals before application

- [ ] Upstream code review of the 12-file diff by someone who did not write it (including the Prisma migration `20261117120000_clinician_session_grant`)
- [ ] Migration reviewed against the production schema and data volume; rollback (`git apply -R` + drop table) accepted
- [ ] Upstream CI (whole backend suite) passes with the patch **on the upstream's own infrastructure** — the scratch result (50 suites / 544 tests) is evidence from a copy, not from the upstream pipeline
- [ ] Audit-log handling accepted (`export_signed_bundle` action; bundle not logged; grant changes audited)
- [ ] Penetration-test scope updated to include the new route and the grant CLI
- [ ] Re-verify on the real tree that the diff still applies (`git apply --check`) at the time of application — file hashes may have moved

## D. ANUClaw-side prerequisites (this repository)

- [ ] Decision recorded on whether ANUClaw will accept `signed_bundle_verified` records in production before a signature-scheme decision (A4)
- [ ] ANUClaw patient-access grants and `posture_subject_links` remain mandatory (verified by `posturepulse-routes-pg.test.ts`); no change proposed
- [ ] Production DPA/legal review covers pseudonymous subject data crossing between the two systems (see [PRODUCTION-READINESS-PLAN.md](../PRODUCTION-READINESS-PLAN.md) §5)

## E. Application record (to be completed by the upstream applier — blank)

| Field | Entry |
|---|---|
| Applied by / date | |
| Upstream commit / PR reference | |
| Diff sha256 verified | |
| Migration run on (environment, date) | |
| Post-apply live test reference | |

**Default: do not apply.** Application requires every row in A answered by its owner and every box in B–C checked with evidence.
