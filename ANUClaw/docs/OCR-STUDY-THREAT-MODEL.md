# OCR study layer — threat model (DRAFT FOR SECURITY REVIEW)

**Scope:** the authenticated OCR-study workspace layer (`/api/ocr-study`, dashboard page, study engine, synthetic local storage). **Status: implemented for synthetic data only; real studies are blocked.** This is an engineering analysis by the authors of the code, not an independent review or penetration test.
**Rule used throughout:** a risk is never "resolved" because a test exists. Each row states *what is implemented*, *what the tests show*, and the *residual risk and the controls that need infrastructure or human decisions*. Status words: **Mitigated in code (limited)**, **Partly mitigated**, **Open — needs infrastructure**, **Open — needs human decision**. No row is marked closed.
Related: [VALIDATION-TOOLS.md](VALIDATION-TOOLS.md#authenticated-ocr-study-workspace-layer-task-74), [PRODUCTION-READINESS-PLAN.md](PRODUCTION-READINESS-PLAN.md), [GOVERNANCE-DECISION-PACK.md](GOVERNANCE-DECISION-PACK.md) (D17), [openapi-ocr-study.json](openapi-ocr-study.json).

## 1. Assets

| # | Asset | Why it matters | Where it lives now |
|---|---|---|---|
| A1 | Source reports (would be de-identified clinical documents) | confidentiality; re-identification risk | files under `ANUCLAW_STUDY_LOCAL_ROOT` (synthetic only) |
| A2 | Annotations (versioned) | ground-truth integrity, annotator blinding | same, append-only files |
| A3 | Adjudication records | integrity of the truth; preserve both originals | hash-chained JSON lines |
| A4 | Manifests | integrity of what the study contains | `manifest.json` (self-hashed) |
| A5 | Lock digests | the anchor that makes a locked set trustworthy | produced by the lock; must be recorded OUTSIDE the system |
| A6 | Exports / evaluation reports | results; leakage of cases or identities | `outputs/<run>/report.json` |
| A7 | Audit records | accountability | PostgreSQL `audit_events` + per-workspace hash-chained file log |
| A8 | Sessions | impersonation of study roles | dashboard JWT cookie/bearer, `dash_sessions` |
| A9 | Storage credentials | access to every study object | none exist (no object store); future secrets-manager references |
| A10 | Membership and role data | authority for every decision | PostgreSQL `ocr_study_members` |

## 2. Trust boundaries

| Boundary | Between | Notes |
|---|---|---|
| TB1 | Browser ⇄ dashboard/API | untrusted client; cookie auth (SameSite=Lax) or bearer; all identity, tenant, role and lock state derived server-side |
| TB2 | API ⇄ PostgreSQL | membership, unlock records, audit rows; parameterised queries; shared DB credentials with the rest of the dashboard |
| TB3 | API ⇄ local synthetic storage | files under an explicit root; permissions 0600/0700/0444; **no encryption at rest, retention or independent access control** |
| TB4 | API ⇄ future object storage | **not implemented**; contract + harness only ([object-store-contract.ts](../src/validation/study/object-store-contract.ts)) |
| TB5 | API ⇄ container jobs | the study layer starts none; tools in the agent image are separate (CONTAINER-CONTRACT.md) |
| TB6 | API ⇄ external providers | the study layer makes no provider call; any future OCR/model provider receiving study documents needs a signed DPA (D10) |
| TB7 | Operator/host ⇄ everything | anyone with host or database write access is outside what this software can defend against |

## 3. STRIDE by component

| Component | S — spoofing | T — tampering | R — repudiation | I — information disclosure | D — denial of service | E — elevation of privilege |
|---|---|---|---|---|---|---|
| Browser/API (TB1) | stolen session (AC-6); no MFA | CSRF (AC-6b); body-supplied identity/role/lock (refused) | actions audited by session user | export/audit leakage (AC-7/8); cross-tenant (AC-1) | oversized input (AC-12); rate abuse | role escalation (AC-2); two-person bypass |
| Membership (TB2) | impersonating a member | editing membership rows needs DB access (TB7) | member changes audited (hash/length of reason) | member lists limited to owner/lead/auditor | — | removed/suspended access revocation is immediate (checked per request) |
| Manifests/locks (TB3) | — | rewriting manifest and hashes (AC-4); digest substitution (AC-5) | lock/unlock chain + audit | — | — | unlock without two people (refused in code) |
| Annotations (TB3) | annotator identity asserted by session | collusion (AC-3); overwriting versions (refused: `wx`) | versions attributed | reading the other annotator (refused) | — | adjudicator editing originals (no route) |
| Storage (TB3/TB4) | — | path traversal (AC-10) | — | file permissions only; no encryption | disk fill | — |
| Audit (TB2/TB3) | — | DB-level edits possible (TB7); file chain detects edits only if verified | — | content in logs (AC-8) | log growth | — |

## 4. Abuse cases

Notation — **Implemented:** what the code does. **Shown by tests:** what automated tests demonstrate (synthetic data, one host). **Residual / needs:** what remains. A test never closes a row.

| ID | Abuse case | Implemented | Shown by tests | Residual risk and needed controls | Status |
|---|---|---|---|---|---|
| AC-1 | **Cross-tenant access** | Membership + tenant from PostgreSQL; non-members and other tenants get the same 404; each request re-reads membership | `study-api-pg.test.ts` (cross-tenant/non-member on 10 routes), `study-security-pg.test.ts` | "tenant" = the creator's dashboard tenant plus explicit membership; the dashboard has no organisation model; isolation of the shared process/DB is not independently reviewed. **Needs:** independent authorization review/pen test | Partly mitigated |
| AC-2 | **Role escalation** (self-assign roles; combine annotator+adjudicator; approve own unlock/removal; client-supplied role) | One role per user; permission matrix server-side; `forbidden_field` for identity/role/lock fields; requester ≠ authorizer; removal of custodian/lead needs a different approver who is neither requester nor target; last-owner protection | role matrix test, forbidden-field test, two-person tests | a study owner can add another owner (by design); one compromised owner + one compromised lead can approve a removal/unlock together. **Needs:** operational policy on who may hold owner/lead; MFA (below) | Partly mitigated |
| AC-3 | **Annotator collusion / contamination** | Annotators see only their own versions and assigned datasets; queue and aggregates hide identities and item content; both annotators' files are append-only | blinding tests (API) | annotators can talk outside the system; software cannot detect collusion or shared tooling. **Needs:** study procedures, independent adjudicator, agreement-pattern review by the statistician | Open — needs human decision |
| AC-4 | **Manifest rewriting** (edit manifest and recompute hashes) | self-hash, per-file hashes, lock-history chain, lock digest; locked files read-only; verification of a locked set **requires an externally supplied digest** | tamper tests incl. recomputed self-hash | **Anyone with write access to the study directory/host can rewrite everything consistently; the repository-local manifest cannot prove its own authenticity.** **Needs:** lock digest recorded outside (signed preregistration / separate system), immutable object storage with retention lock, restricted host access | Open — needs infrastructure + human decision |
| AC-5 | **Lock-digest substitution** (attacker supplies or records a different digest) | the digest is compared to the dataset's recomputed digest; wrong digest fails verification; locked evaluation requires it | wrong-digest tests (API + browser) | the system cannot know whether the digest you hold is the genuine one. **Needs:** custody procedure (who records it, where, how it is checked), dual control | Open — needs human decision |
| AC-6 | **Stolen session** | JWT with server-side session check and revocation; HttpOnly cookies; password re-entry (or a fresh session) for sensitive actions when the policy requires it (default on in production); rate limits | re-authentication tests | no MFA, no device binding, no IP/anomaly checks; a stolen cookie within the freshness window passes; password re-entry is not a second factor. **Needs:** SSO/MFA, shorter token lifetimes, session binding | Open — needs infrastructure |
| AC-6b | **CSRF / cross-site request** | SameSite=Lax cookies; JSON-only mutations; reject cross-site Origin, `Sec-Fetch-Site: cross-site` and non-JSON bodies; production requires same-origin Origin for cookie mutations | origin/fetch-metadata/content-type tests | review only covers this route family; no per-request CSRF token; relies on browser behaviour. **Needs:** dashboard-wide CSRF review/pen test | Partly mitigated |
| AC-7 | **Export leakage** (report reveals cases, identities or content; wrong recipient) | reports hold ids, hashes, metrics and silent-error item ids (no source text or annotator identities); export restricted to four roles, re-auth policy, rate limited, hash header | export role tests, provenance tests | a report can still carry analyte names and counts; a recipient can redistribute; no watermarking or DLP. **Needs:** data-sharing agreement, review of exports before release | Partly mitigated |
| AC-8 | **Audit-log leakage / pollution** | audit metadata is an allow-list of tokens; reasons stored as SHA-256 + length; no names, emails, passwords or content; refusals logged | content-exclusion tests (API + units) | an allow-listed id can still be sensitive in combination; DB admins can edit rows; the DB audit is not hash-chained (the file log is). **Needs:** append-only/WORM audit storage, retention, access review | Partly mitigated |
| AC-9 | **Removed/suspended member keeps access** | status checked on every request; file-store membership mirrored; history never deleted | suspended/removed tests | tokens remain valid but useless for study routes; membership is per study, the dashboard account is unaffected; no automatic offboarding link to HR/IdP. **Needs:** IdP-driven deprovisioning | Partly mitigated |
| AC-10 | **Storage-path traversal** | ids are server-generated hex; `runId` validated (`[A-Za-z0-9._-]`, no `..`); case ids opaque; paths resolved under the dataset dir; verification refuses paths escaping the directory | run-id traversal test, tamper tests | the file engine writes directly to the filesystem; symlink planting by a host user is not defended. **Needs:** object storage with no filesystem exposure | Partly mitigated |
| AC-11 | **Malicious archives / files** | sources are stored as opaque bytes, never parsed or executed by the study layer; archive, compressed and executable magic bytes are refused whatever the declared type; media-type allow-list; size caps | archive/size tests | content is not scanned for malware or parser exploits in downstream tools (OCR engines, viewers); a user could download a crafted PDF. **Needs:** malware scanning, sandboxed rendering, only de-identified sources | Partly mitigated |
| AC-12 | **Denial of service** | body 4 MB; per-source 1 MiB, 3 MB total, 50 sources; annotation/result item caps; JSON depth cap; pagination ≤200; per-user in-process rate limits (sensitive/expensive/upload/general) | limit and rate-limit tests | counters are **per process** (bypassed by multiple instances or many accounts); no global quotas, no WAF; a valid user can still fill the disk. **Needs:** shared rate-limit store, quotas, infrastructure protection | Open — needs infrastructure |
| AC-13 | **Unlock abuse** (replay, bound to different state, same person on both sides) | two-person, single-use, bound to manifest hash + lock digest + tenant; executed only by the requester; reopened sets labelled in every report | replay/mismatch tests | two colluding authorized users can unlock; the authorization carries a credential reference the software cannot verify. **Needs:** governance of who may authorize; independent record of unlocks | Partly mitigated |
| AC-14 | **Reason/free-text injection** into logs or UI | free text is hashed in audit; UI renders as text (React escaping) | audit tests | free text is not stored at all in the DB for member changes; adjudication reasons live in the file records. Not reviewed against stored-XSS beyond React defaults | Partly mitigated |
| AC-15 | **Insider with DB/host access** | none beyond file permissions and hashes | — | **Out of scope for this software.** Needs: infrastructure separation of duties, restricted admin access, key management, monitoring | Open — needs infrastructure |

## 5. Controls added in this milestone (and their limits)

| Control | Setting / default | Limit |
|---|---|---|
| Membership lifecycle (suspend / remove / reinstate; two-person for custodian and clinical lead; last-owner protection) | always on | rows are kept; no permanent deletion by design; a removed member cannot be re-added to that study |
| Re-authentication for sensitive actions | `ANUCLAW_STUDY_REAUTH=required|off`, `…FRESH_SESSION_SEC` (default 120); default **required in production, off otherwise** | password re-entry only; not MFA; local-development behaviour deliberately unchanged |
| Origin / fetch-metadata / content-type guard | always on; `…REQUIRE_ORIGIN` default true in production | complements, does not replace, dashboard-wide CSRF protection |
| Request limits and pagination | fixed constants in `ocr-study-security.ts` | tuned for synthetic data |
| Rate limits | `ANUCLAW_STUDY_RATE_{SENSITIVE,EXPENSIVE,UPLOAD,GENERAL}` per user per minute | in-process only |
| Security headers | always on for this router | JSON/attachments only; the SPA's own headers are separate |
| Structured security audit events | `security.reauth_required`, `security.reauth_failed`, `security.rate_limited`, `denied` | allow-listed tokens only |
| Object-store contract harness | `object-store-contract.ts` (10 cases) + test-only fake | **not production-storage evidence**; no implementation exists |

## 6. Controls that need infrastructure or human decisions (not implemented)

1. **Production object storage** with customer-managed encryption, retention locks, per-role access policy, signed-access expiry and audit — must pass the full contract harness against the real service, then be reviewed by people.
2. **SSO and MFA** for study users (the layer relies on the existing dashboard login).
3. **Independent penetration test and authorization review** of the routes, the grant model and the storage.
4. **WORM/append-only audit storage**, retention policy and access review.
5. **Shared rate-limit / quota store**, WAF or equivalent, capacity planning.
6. **Custody procedure for lock digests** and for unlock authorizations (who, where, how verified).
7. **Malware scanning / sandboxed rendering** of source documents; de-identification verification process.
8. **Ethics approval, data-use agreements, DPAs, retention and destruction plan** before any real document is registered.
9. **IdP-driven deprovisioning** and periodic access reviews.
10. Decisions D01, D04, D10, D12, D17 in the governance pack.

## 7. What tests do and do not establish

Automated tests (study tooling 18, API 14, security 8, contract harness 15, units 3; browser check) show that the implemented checks behave as written on synthetic data on one host. They do **not** show absence of vulnerabilities, resistance to a determined attacker, correct behaviour under concurrency at scale, or the safety of any real-data deployment. **Every real-study and production status remains blocked.**
