# Releasing clinical content

**This build releases no clinical content.** `CLINICAL_RULES` is empty, the seed oncology/neurology decision modules are blocked, no reference document is approved, and every
specialty module is `not_approved`. This document says how that may change — and what the software can and cannot
guarantee about it.

## What the software enforces

| Control | Where | Effect |
|---|---|---|
| A clinical rule is "released" only with `source` + `approval{approverRole, approvedAt, evidence, population}` | `src/documents/rules.ts` `isReleased` | an incomplete rule is silently excluded; with none released the engine reports `no_released_rules` instead of inventing thresholds |
| Rule code and the release register must match exactly | `docs/clinical-release-register.json` + `src/documents/clinical-release-register.test.ts` | adding a rule without a complete register entry (named approver, credential reference, date, evidence, population, intended use, signed-record reference) fails CI; so does a register entry with no rule |
| **Seed CDS rule sets (oncology, neurology) are blocked.** `runClinicalDecision` returns 409 `clinical_content_not_released` unless the register has `cds.<domain>` at exactly that rules version (or a non-production developer override, which labels every response `seed_unvalidated`) | `src/cds/clinical/release.ts`, `src/api/elab/service.ts` | the dashboard and API clinical-combination routes serve no verdict and write no audit record for unreleased content |
| Reference documents start `draft`; only a provisioned **licensed clinician** can approve; only approved documents are retrievable | `src/ai/reference-corpus.ts`, `/api/clinical/references/:id/approve` | unapproved content cannot reach retrieval |
| Specialty modules cannot claim approval | `src/specialties/registry.ts` validator | no "approved/complete" state exists |
| Reports are drafts until a licensed clinician signs them off in the dashboard | clinician-only route; API returns 403 | no automated path produces a reviewed report |

**What it cannot do:** verify a person's identity, licence or authority, or judge clinical correctness. The register is a
traceability aid; the authority is the approver's own signed record, referenced from the entry and reviewed by a second
person.

## Procedure to release one rule (all steps are human decisions)

1. **Owner and intended use.** Name the clinical owner and write the intended use, population and exclusions.
2. **Source.** Cite the guideline/standard with version and licence; confirm the licence permits this use.
3. **Specification.** Define inputs (units, specimen/context), the exact thresholds, boundary behaviour and the
   `insufficient_data` / `not_comparable` cases. No threshold may be taken from model output.
4. **Evaluation.** Build representative cases including boundaries and failure cases; record numeric acceptance targets
   *before* looking at results; document every failure and its disposition (plan §16.2).
5. **Implement** as a `RuleDefinition` with `category: 'clinical'`, version it, and add boundary tests.
6. **Approval record.** The approver signs a record (their own system) stating scope, population, evidence and date.
7. **Register.** Add the entry to `docs/clinical-release-register.json` (`ruleId`, `ruleVersion`, `approverName`,
   `approverRole`, `licenseOrCredentialRef`, `approvedAt` (YYYY-MM-DD), `evidence`, `population`, `intendedUse`,
   `recordRef`) in the same pull request as the rule; a second reviewer confirms the signed record exists.
8. **Pilot and monitor** per the module's gate in plan §15 before widening use; define the rollback trigger.
9. **Change control.** Any threshold change is a new rule version with a new approval; old versions stay in the register.

## Releasing reference documents (retrieval corpus)

1. An admin registers the document with publisher, https source URL, licence, version and scope (`POST /api/clinical/references`).
2. A provisioned licensed clinician approves it (`…/approve`); it is then indexed (`…/index`, uses the embedding model on
   public reference text only — `reference_public` data class).
3. Retrieval stays tenant-scoped; answers cite retrieved chunks and numbers are verified against the cited text.

## Releasing a specialty module or any clinical claim

Needs the "Module ready", "Workflow ready" and, for claims, "Clinical claim ready" gates in plan §16.3, evidenced by
people outside this codebase. Until then the registry entry keeps `approval.status = 'not_approved'` and its
`prohibitedClaims` apply to all copy, exports and API text.
