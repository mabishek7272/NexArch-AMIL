# Monitoring / device validation — protocol and synthetic tooling (task 77)

**Status: synthetic-only tooling, implemented; no clinical alert claim; clinically unvalidated; production-blocked.** Every observation here is generated; values are arbitrary smooth numbers with **no physiological meaning**. The alert workflow is **simulation-only** (the product's alert state machine carries `simulation: true` in its type). Companion: [POSTURE-VALIDATION-PROTOCOL.md](POSTURE-VALIDATION-PROTOCOL.md); parent: [CLINICAL-VALIDATION-PROTOCOL.md](CLINICAL-VALIDATION-PROTOCOL.md) §8.

## 1. What is being checked (and what is not)
Checked: that the product's observation validation and **two-clock freshness model** classify recorded synthetic sessions as a human-written expectation says, and never expose a stale, delayed or untrusted value as current. **Not** checked: any real device, sensor accuracy, clinical thresholds, escalation delivery to a human, or patient safety.

## 2. Synthetic scenarios (`src/validation/pv/monitoring.ts`)
normal · impossible values (rejected, never shown) · stale (device goes silent) · duplicated · delayed delivery (latency 400 s) · out-of-order arrival · missing (dropout gap) · **clock skew** (source clock ahead of receipt) · **reconnect backlog** (offline period flushed in one burst) · **backlog of only old measurements** · alert acknowledged · alert escalation. Each scenario has checkpoints ("now") and a human-written expectation: state, whether a value may be exposed, source-age and receipt-age.

## 3. Source freshness vs receipt freshness stay separate
The product reports the age of the **measurement** (source clock) and the age of the **last communication** (receipt clock) independently. A value is `current` only if the source clock is trusted, the measurement is fresh **and** the last communication is recent. Verified scenarios:
| Scenario | Source age | Receipt age | State | Value exposed |
|---|---|---|---|---|
| delayed delivery | old | recent | stale ("NOT CURRENT") | no |
| backlog of only old measurements | old | recent | stale | no |
| reconnect backlog containing a recent measurement | fresh | recent | current | yes (the newest measurement is 65 s old) |
| device silent | old | silent | stale | no |
| source clock ahead of receipt | future | recent | untrusted_time | no |
The report adds **safety invariants** independent of any expectation (a value is never exposed unless state is `current`; `current` requires fresh source AND recent receipt; both ages are reported whenever data exist; delayed/backlog data is labelled NOT CURRENT). A violation is a critical finding.

## 4. Simulation-only alert workflow and reliability reports
The alert state machine (open → acknowledged → closed, or escalated after an explicit acknowledgement deadline) is exercised with synthetic events; the report records final state, escalation and acknowledgement latency, labelled simulation-only. Device-reliability reports (completeness, gaps and recovery of known outages, duplicates, delivery latency, out-of-order, backlog bursts, clock offset/drift, current-value availability) reuse the existing evaluator. **No clinical alert, threshold or safety claim.** Real escalation delivery (who, how fast, fallback) must be tested with the operational team in a future study.

## 5. Workspace, locks and reports
Same workspace as posture validation (`workspace.ts`): synthetic-only registration (JSON scenarios must declare `"synthetic": true`), expectation annotations by a separate annotator role, product code executed by the runner role, locked-set protections with an externally recorded lock digest, run hashes (model/config/environment), and a report that states `acceptance: not_assessed_by_this_tool`. Tests inject a defect that exposes stale values and a lax freshness rule and confirm the report flags both.

## 6. Tests and evidence
`src/validation/pv/pv.test.ts` (19 tests, shared with posture): scenario expectations, freshness separation, rejection/duplication/ordering, reliability reports, alert workflow, defect detection through the full workspace flow, and PosturePulse consent/release/withdrawal protections on malformed, unsigned, withdrawn, revoked, unreleased, tampered and out-of-order upstream cases. Rehearsal evidence: [pv-synthetic-run-latest.json](evidence/pv-synthetic-run-latest.json). Blank templates: [device reliability](../validation/templates/12-device-reliability.template.md), [adverse events](../validation/templates/13-adverse-events.template.md).

## 7. Human inputs required before real video, real devices or a real monitoring study
1. **Governance:** signed intended-use statement (D01) and named roles (D12); ethics/IRB approval and, for devices, any required institutional or regulatory notification (D09, D11); decision D19.
2. **People and consent:** consent forms and information sheets covering video, pose and device data, retention, sharing and withdrawal; a recruitment plan with demographic and condition strata; trained operators; a named clinical lead and independent statistician.
3. **Reference and equipment:** a reference measurement method with stated uncertainty (e.g. motion capture, calibrated inclinometer, expert annotation by ≥ 2 independent raters); real devices with models/firmware, a reference clock, and a supervised test bench for fault injection; sites and acquisition SOPs.
4. **Pre-declared numbers (not chosen here):** tolerances per metric, freshness windows per parameter, acceptance bounds, sample sizes, soak duration, escalation expectations — set by the clinical lead and statistician before data collection.
5. **Privacy and storage:** a production storage design with encryption, retention and access control (the study layer's synthetic adapter must not be used), data-processing agreements for any provider, de-identification procedures for video, a retention and destruction plan.
6. **Custody:** a place outside the system to record lock digests, a named locked-set custodian, and authorization procedures for unlocks.
7. **Security and operations:** authentication/MFA in front of the validation workspace, penetration test, incident procedure for adverse events and privacy breaches.
8. **Upstream:** the PosturePulse owners' decisions on signed export and per-session grants ([review checklist](proposals/posturepulse-upstream-review-checklist.md)) before real upstream reports are imported.
