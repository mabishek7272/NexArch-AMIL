# Device reliability record — template

> **BLANK TEMPLATE.** No results, signatures, approvals or participants. Fill in outside this repository's evidence folders; never commit real personal data. Any example value is marked `EXAMPLE (synthetic)`.


| Field | Entry |
|---|---|
| Device model / firmware / sensor, reference clock | |
| Scenario (outage, delay, backlog flush, out-of-order, duplicate, clock skew, reboot, detachment …) and whether injected or natural | |
| Expected behaviour (written BEFORE the run) for: state (current/stale/untrusted/no data), whether a value may be shown, source age, receipt age | |
| Observed behaviour at each checkpoint | |
| Source-measurement freshness and receipt freshness reported separately? | [ ] |
| Any value shown as current while stale / delayed / untrusted? (critical) | [ ] none  [ ] yes → describe |
| Completeness, gaps, duplicates, delivery latency p50/p95/p99, out-of-order, backlog bursts, clock offset/drift | |
| Alert workflow exercised (simulation or real)? acknowledgement latency, escalation, who/how fast/fallback | |
| Pass / fail against the pre-declared expectation (recorded by the clinical lead; the tool decides nothing) | |

Machine-readable input for `npm run validate -- device`: [device-log.template.json](device-log.template.json).

## Completed by
| Role | Name | Credential / reference | Signature | Date |
|---|---|---|---|---|
| | | | _(blank)_ | |
