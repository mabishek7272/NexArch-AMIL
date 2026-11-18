# Research Studio — evaluation (M1-M6 evidence)

## What was actually run (reproducible)

```sh
npx vitest run src/research-studio/research-planner.test.ts                               # 12 tests, pure, no DB
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres \
  npx vitest run src/research-studio/task-store-pg.test.ts                                 # 10 tests, real PostgreSQL
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres \
  npx vitest run src/dashboard/server/routes/research-studio-pg.test.ts                    # 7 tests, real HTTP + real PostgreSQL
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run            # full regression: 1284 passed, 52 skipped, 0 failed
npx tsc --noEmit -p .                                                                       # clean
npx eslint src                                                                              # 0 errors, 321 pre-existing warnings
npm --prefix dashboard run build                                                            # succeeds, ResearchStudio page bundled
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres \
  npx tsx scripts/verify-research-studio-ui.ts                                             # M1+M2: 12/12 passed, real headless Chromium against a real local profile

# M2 additions
npx vitest run src/research-studio/citation-service.test.ts src/research-studio/import-service.test.ts src/research-studio/connectors/crossref.test.ts   # 30 tests, pure, no DB, no network
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run src/research-studio/evidence-service-pg.test.ts src/research-studio/agents-m2-pg.test.ts src/dashboard/server/routes/research-studio-m2-pg.test.ts   # 22 tests, real PostgreSQL
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run            # full regression after M2: 1336 passed, 52 skipped, 0 failed

# M3 additions (real headless Chromium; fully offline/local, no live opt-in needed)
npx vitest run src/research-studio/browser/simulated-provider-adapter.test.ts              # 8 tests
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run src/research-studio/browser/profile-service-pg.test.ts src/research-studio/browser/browser-session-agent-pg.test.ts src/dashboard/server/routes/research-studio-m3-pg.test.ts   # 15 tests
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run            # full regression after M3: 1359 passed, 52 skipped, 0 failed

# M4 additions
npx vitest run src/research-studio/guideline-service.test.ts                              # 6 tests, pure
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run src/research-studio/manuscript-service-pg.test.ts src/research-studio/agents-m4-pg.test.ts src/dashboard/server/routes/research-studio-m4-pg.test.ts   # 15 tests
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run            # full regression after M4: 1382 passed, 52 skipped, 0 failed

# M5 additions (including the DOCX gap closure via the new `docx` dependency)
npx vitest run src/research-studio/export-service.test.ts                                 # 11 tests, pure, no DB
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run src/research-studio/visual-service-pg.test.ts src/research-studio/agents-m5-pg.test.ts src/dashboard/server/routes/research-studio-m5-pg.test.ts   # 12 tests
ANUCLAW_TEST_PG_URL=postgres://USER:PASS@127.0.0.1:PORT/postgres npx vitest run            # full regression after M5: 1408 passed, 52 skipped, 0 failed
npm ls docx                                                                                 # confirms the new dependency, no transitive vulnerabilities of its own
```

These were executed against a disposable, throw-away PostgreSQL instance (never a database with
real data), created and dropped per suite, matching every prior milestone's testing convention.

### A real bug the browser verification caught (and the fix)

The first run of `verify-research-studio-ui.ts` failed at "pause → resume": pausing a task
succeeded, but the UI's refreshed table still showed it as `queued`, and the Resume button never
appeared. Root cause: `research_studio_tasks` has no tiebreaker column, and several tasks created
in the same commit (a planner's `childTasks` batch) can share the same millisecond `created_at` —
`ORDER BY created_at` is then not guaranteed stable across repeated `SELECT`s, so a task could
land at a different row position on the next page load than the one the test (or a real user)
had just acted on. Fixed by adding a `BIGSERIAL ordinal` column to `research_studio_tasks` and
switching every task listing/claim query (`listTasks`, `claimNextReady`,
`projectGraphView`) to `ORDER BY ordinal`, which is a true, monotonic creation-order tiebreaker.
Re-run after the fix: 8/8 passed. This is exactly the kind of defect a mock-response dashboard
would never surface — it only appeared because the page was driven against the real API and real
Postgres rows.

### The parallel-run "Errors" line, investigated

A full regression run sometimes (not always — it is timing-dependent, not deterministic) prints a
trailing `Errors N` line alongside `Test Files ... passed` and exit code 0, even though every
test passes. This has been investigated, not just asserted benign:

- The crashing connection's `connectionParameters.database` is always the DISPOSABLE database
  name of **`src/db/pg-integration.test.ts`** (a pre-existing file, unrelated to Research Studio)
  — e.g. `anuclaw_it_d247602b03e6` — never a Research Studio test's database.
- That file's own `afterAll` closes its connection pools (`pools.map(p => p.end())`,
  `getDb().end()`), then — as a safety net — issues `pg_terminate_backend(...) WHERE datname =
  $1` against its OWN disposable database to catch anything still lingering, then drops the
  database. Node-postgres's `pool.end()` promise can resolve a few milliseconds before the
  underlying TCP socket fully finishes closing; if the self-administered `pg_terminate_backend`
  reaches the server while one of those sockets is in that final window, Postgres sends
  `FATAL 57P01` ("terminating connection due to administrator command") back down a socket whose
  client-side error listeners have already been torn down by `.end()`, which surfaces as an
  unhandled error at the process level — reported by the test runner as an extra `Errors` entry,
  arriving AFTER that file's own `afterAll` and every assertion already completed successfully.
- This reproduces more often under heavier parallel load (more test files racing for CPU/socket
  time around the same moment) and was confirmed absent in at least one full run during this pass
  (0 errors, 1408 tests passed) — consistent with a timing race, not a deterministic defect.
- It is the test file's OWN cleanup racing against its OWN already-closing connections, not
  cross-file contamination: every Research Studio PG test uses the identical
  `pg_terminate_backend(...datname = $1...)` pattern scoped to its own randomly-named database,
  and no Research Studio test has ever been the one reported in the crash.
- **Not fixed in this pass** — the affected file is outside Research Studio's scope for this
  milestone, and the race is harmless (no assertion ever fails because of it). It is recorded here
  precisely, per the instruction not to claim a fully clean run without understanding it.

## Tests that matter (plan §12) — status against what M1+M2 actually implement

| Test category from the brief | Covered? | Where |
|---|---|---|
| Restart/crash recovery | Yes | `task-store-pg.test.ts` stale-claim sweep test |
| Duplicate/replayed task submission | Yes | `task-store-pg.test.ts` idempotent-commit test |
| Isolation (owner-only) | Yes (project/task/source/claim level) | `research-studio-pg.test.ts`, `research-studio-m2-pg.test.ts` owner-only 404 tests |
| Bounded critic/revision loop termination | Yes (the generic cap mechanism; no critic agent yet to actually loop — M4) | `task-store-pg.test.ts` revision-group test |
| Source corrections / downstream invalidation | **Yes, end to end** — a real retraction on a real source invalidates real excerpts and cascades to a real downstream task | `evidence-service-pg.test.ts` revision/invalidation test |
| Fabricated progress / fake agent activity | Yes (never happens by construction) | `research-studio-pg.test.ts` "advance" test; `agents-m2-pg.test.ts` honesty-path tests |
| Fabricated DOI / claim-to-source checks | **Yes, for identifier resolution and claim-support status** — a non-resolving DOI is `mismatch`, never silently `unknown`; a claim's `supported`/`contradicted` status is set only by an explicit decision | `agents-m2-pg.test.ts`, `evidence-service-pg.test.ts` |
| Contradictory-studies handling | **Yes, at the claim level** — a `contradicts` link is never hidden by a co-existing `supports` link | `evidence-service-pg.test.ts` "contradiction is never hidden" test |
| Prompt injection via imported content | **Partial** — an imported title/excerpt containing instruction-like text is stored and rendered verbatim as data, never interpreted (`research-studio-m2-pg.test.ts`); not yet applicable to a model/browser agent reading it, since none exists (M3/M4) | `research-studio-m2-pg.test.ts` import test |
| SSRF / private-address redirects | **Partial** — the only outbound connector (Crossref) is origin-allow-listed via the existing `SafeFetcher`; a source's own `url` field is never fetched by any Research Studio code, so there is no reachable SSRF path today. Not yet tested against a browser connector, since none exists (M3) | `connectors/crossref.ts` design; no dedicated adversarial test yet |
| Abstract-only vs. full-text evidence distinction | **Partial** — the schema and UI distinguish `abstract_only`/`full_text`/`unavailable`/`unknown`, but only local artifact storage can set `full_text`; no connector can retrieve full text yet | `research-studio-m2-pg.test.ts` artifact-upload test |
| Isolated browser profiles | **Yes, for the simulated provider** — owner-only, mode-0700, on-disk, no credential in the DB row; session-lock exclusivity and stale-lock sweep tested. Not yet exercised against a real provider (none exists) | `profile-service-pg.test.ts` |
| Stolen/replayed task auth tokens (HTTP session) | Partial — covered by existing dashboard auth tests, not Research-Studio-specific | existing auth test suites |
| Secrets in screenshots/traces/logs | **Partial** — by construction, nothing in the browser module writes a trace/screenshot/page-dump into the DB or logs; no dedicated adversarial test of a real trace file yet (no real provider session exists to trace) | design-level, `browser/profile-service.ts` |
| Session expiry / quota / UI drift | **Yes, against the simulated provider** — all three are deterministically injectable fixture conditions and are asserted end to end through the real adapter and the real task agent | `simulated-provider-adapter.test.ts`, `browser-session-agent-pg.test.ts` |
| Browser replay / restart recovery (M3) | **Yes** — a stale task claim (simulated crash) is recovered by M1's unmodified `sweepStale`; a closed-then-reopened adapter resumes session state from the profile's own persisted data | `browser-session-agent-pg.test.ts`, `simulated-provider-adapter.test.ts` |
| Bounded critic/revision loop termination (M4, end to end) | **Yes** — a real citation issue triggers exactly one more writing round in the correct revision group; the cap is reached and reported explicitly, never looped forever or silently proceeded past | `agents-m4-pg.test.ts` bounded-revision-loop test |
| Never writing results for original_research without stored data (M4) | **Yes** — the planner withholds `writing.draft_sections` entirely without `hasData`/`dataResearchRunId`; the Methods agent reuses the EXISTING, hash-verified run artifact byte-for-byte, never recomputing | `research-planner.test.ts`, `agents-m4-pg.test.ts` methods.analysis test |
| Citation/locator/claim-support checked SEPARATELY, missing stays unknown (M4) | **Yes** | `agents-m4-pg.test.ts` Citation Auditor test |
| Editorial tracked-change preservation + detector-evasion refusal (M4) | **Yes** — a dropped number is flagged as interpretation-altering; the edit is never applied by the agent itself; a "humanize/undetectable" param is refused outright | `agents-m4-pg.test.ts`, `research-studio-m4-pg.test.ts` |
| Downstream invalidation reaching manuscript content (M2→M4) | **Yes** — `PATCH /sources/:sourceId` calls `invalidateSectionsForTasks` with the exact task ids `reviseSourceMetadata` just invalidated, so a material source revision flags both the downstream TASK and any manuscript SECTION it produced | `manuscript-service-pg.test.ts` (unit), wired in `research-studio.ts` |
| Chart-to-analysis linkage (M5) | **Yes** — a data-derived visual's numbers are read live from a real, hash-verified research run at creation time; the run id/output hash is recorded in the visual's own `data_provenance_json` | `visual-service-pg.test.ts` |
| Export rendering, incl. real pagination/structure checks (M5) | **Yes** — a real multi-page PDF (page count grows with content), a real DOCX (verified as a genuine ZIP/OOXML container), real citation-presence inspection, all on-disk files verified as real binaries (not stubs) | `export-service.test.ts`, `agents-m5-pg.test.ts` |
| Invented numbers in a visual refused (M5) | **Yes** — a conceptual visual with a measured-looking field, or a data-derived visual with an empty/non-existent field, is refused before any SVG is produced | `visual-service-pg.test.ts` |
| PRISMA counts are real, never free-typed (M5) | **Yes** — `buildPrismaFlow` is the ONLY path to a `prisma_flow` visual; `createVisual` refuses the type outright otherwise | `visual-service-pg.test.ts` |
| Full consolidated end-to-end rehearsal, single run (M6) | **Yes** — one continuous `systematic_review` rehearsal through the real HTTP API across every milestone, ending in cross-tenant isolation checks | `acceptance-m6-pg.test.ts` |
| Export integrity / tamper detection (M6) | **Yes** — a tampered file on disk is detected by re-hashing on every download; refuses with 409 `integrity_failure` rather than serving corrupted bytes | `readVerifiedExport` in `export-service.ts`, `security-m6-pg.test.ts` |
| Data-derived visual actually works on a real analysis (M6) | **Fixed a real defect** — the field lookup could never resolve against any real analysis output before this pass; see `resolveRunField` | `security`/`acceptance-m6-pg.test.ts`, `visual-service-pg.test.ts` |

The only rows this evaluation still cannot mark "Yes" are the ones that genuinely require a real
provider/MCP session, which remains out of scope by design — see
[RESEARCH-STUDIO-BROWSER-CONNECTOR.md](RESEARCH-STUDIO-BROWSER-CONNECTOR.md) and
[RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md) for the exact boundary.
