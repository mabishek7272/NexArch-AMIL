# Research Studio — architecture (M1)

## Data model (implemented)

```
research_studio_projects            — one row per project: mode, status, brief_json, brief_sha256
research_studio_project_revisions   — append-only; every brief change keeps the prior version (immutable)
research_studio_tasks               — the task graph: status, depends_on_json, params_json, result_json,
                                        result_sha256, attempts/max_attempts, next_eligible_at, claimed_at,
                                        claim_token, invalidated_at/reason, budget_json, usage_json,
                                        revision_group, max_revisions_in_group
research_studio_task_events         — append-only, hash-chained (seq, prev_hash, hash); immutable trigger
```

`ProjectRow`/`TaskRow`/`TaskEventRow`/`ResearchBrief` are defined in
[`src/research-studio/types.ts`](../src/research-studio/types.ts). `TASK_STATES` is exactly the
8-state list the brief requires; `TERMINAL_STATES = [failed, cancelled, completed]`.

## Threat boundaries

- **Cross-tenant access**: every project/task operation is gated through
  `permissions.ts#ownProject`/`ownTask`, which answers 404 (not 403) for a non-owned id. There is
  no admin override route in M1 — an admin dashboard role can use the feature but still only sees
  their own projects, matching the existing `/api/research` convention.
- **Duplicate/replayed commits**: a commit is keyed to the exact `claim_token` issued at claim
  time. A repeated commit of the *same* result after it already landed is a no-op (idempotent); a
  repeated commit carrying a *different* result is refused with `commit_conflict`, never silently
  overwritten. This is the mechanism a future browser-based agent reuses to survive an uncertain
  network response after submitting a browser action.
- **Process crash / restart**: nothing is held only in memory. `sweepStale` finds any task whose
  claim is older than `STALE_CLAIM_MS` (15 min) and treats it as a failed attempt of that run —
  retried if attempts remain, else terminally failed. Calling `tick()` again from a new process
  after a restart continues correctly.
- **Tamper detection**: `research_studio_task_events` is hash-chained
  (`sha256(canonical({seq, projectId, taskId, event, detail, at, prevHash}))`) and a Postgres
  trigger function refuses UPDATE/DELETE/TRUNCATE on both the event and project tables
  independent of the application layer. `verifyEventChain` re-derives the chain on read and
  reports the exact broken `seq` rather than trusting stored order.
- **Budget overrun**: `recordUsage` fails a task **closed** (terminates it) the moment a recorded
  increment would cross `maxActions`/`maxTokens` — it never lets a handler keep running past its
  declared budget. This is the primitive a browser/model-calling agent will use; "unknown cost is
  unknown, not zero" (plan §4) still has to be satisfied by whatever records the cost, which is
  not built yet (M3/M4).
- **Fabricated progress**: the agent registry (`agent-registry.ts`) is the single source of truth
  for which task types can run. `claimNextReady` only ever considers `runnableTypes()`, and
  `projectGraphView` reports `agentAvailable: false` for everything else. There is no code path
  that marks a task `completed` without a registered handler actually returning
  `{kind:'completed', ...}`.
- **Revision-loop non-termination**: `createTask` checks the `revisionGroup` member count against
  `maxRevisionsInGroup` *before* insertion and refuses the (N+1)th member outright
  (`TaskStoreError('revision_limit_reached', ...)`). A future critic/revision loop (M4) creates
  each new draft as a member of the same group and this cap is the hard stop — no agent-side
  "please stop now" logic is trusted for termination.

## Orchestrator (`orchestrator.ts`)

`tick(projectId)` is the single step function: sweep stale → requeue eligible retries → claim one
ready task of a registered type → run its handler → commit the outcome (or convert a thrown
exception into a `retryable_failure`, never a silent success). It does not loop internally — the
API, a test, or (not yet built) a scheduler calls it repeatedly. `runToQuiescence` is a bounded
convenience that calls `tick` until nothing advances or a step cap is hit; it is what
`POST /projects` and `POST /projects/:id/advance` use.

This is intentionally the same shape as `src/task-scheduler.ts`'s claim pattern
(`UPDATE ... WHERE status='queued' ... RETURNING`), so a future cron-driven background tick can
reuse the scheduler rather than inventing a second execution model.

## M2: evidence graph (built on top of the above, unchanged)

- **New data model** (`src/db/connection.ts`): `research_studio_{search_strategies,search_runs,
  sources,source_versions,source_links,artifacts,excerpts,claims,claim_evidence_links,
  screening_decisions,evidence_matrices}`. Every table that can receive several rows in one commit
  carries `ordinal BIGSERIAL` from the start (the M1 `ORDER BY created_at` tie lesson, applied
  up front this time rather than discovered by a browser test again).
- **Budget enforcement actually wired through**: M1 defined `recordUsage` but no handler could
  call it (`AgentContext` had no claim token). M2 adds `token` to `AgentContext` and threads it
  from `orchestrator.tick()`; `recordUsage`'s internal `failTask` call and `commitOutcome`'s
  idempotent handling of an already-failed task compose correctly without any special-casing —
  see `source-verifier.ts`/`literature-scout.ts` for the pattern any future agent should copy.
- **Outbound network calls are allow-listed, not open**: `connectors/crossref.ts` reuses
  `src/sciencedata/fetcher.ts`'s `SafeFetcher`, whose `originAllowed` check restricts every
  request (and every redirect hop) to `https://api.crossref.org`. A source's own `url` field is
  stored as data and is **never fetched** by any Research Studio code — there is no code path
  that could SSRF through it.
- **Untrusted content stays data**: an excerpt's `text`, an imported record's `title`, and a
  connector's JSON response are stored/compared as plain strings. Nothing in evidence-service.ts,
  the agents, or the dashboard interprets this content as an instruction, a permission grant, or a
  tool call. `evidence-extractor.ts` additionally screens supplied excerpt text through
  `src/aikosh/taint.ts#assertNoRestrictedContent` before it is ever persisted.
- **Dedup is a proposal, not a merge**: `citation-service.ts#proposedRelation` is intentionally
  conservative (close title + compatible year) and `evidence-service.ts#createSource` only ever
  *creates* a `source_links` row (`status: 'proposed'`) for a near match; `decideSourceLink`
  requires a human `confirmed`/`rejected` decision and refuses to act twice on the same link.
- **Evidence invalidation reuses the M1 task graph, not a second scheme**: see
  `evidence-service.ts#reviseSourceMetadata` — it flags the excerpt rows directly (cheap, local)
  and then calls `task-store.invalidateDownstream` on each originating task id, which is the exact
  M1 primitive already used for the planner's own graph.

## M3: browser research transport (local harness; real providers disabled)

- **Contract-first, not transport-first**: `browser/contract.ts`'s `BrowserResearchAdapter` is the
  only thing a caller (`browser-session-agent.ts`) depends on. The simulated adapter and any
  future MCP/real-provider adapter are interchangeable implementations of the same five methods —
  nothing about the task-engine integration needs to change when a real adapter arrives.
- **Two independent self-healing layers, not one coordinated system**: a crashed task is
  recovered by M1's existing `sweepStale` (task-level); a crashed task's browser-session lock is
  recovered by `profile-service.ts`'s own stale-lock sweep (session-level). Neither needs to know
  about the other — each layer's existing mechanism just keeps working.
- **Credentials never enter the application's trust boundary**: `research_studio_browser_profiles`
  stores metadata only; the actual authenticated session is an OS-level file-permission-protected
  directory (`mode 0700`) that this process creates and deletes but whose *contents* (cookies,
  local storage) it never reads, parses, or logs. This is a stronger guarantee than "redact before
  logging" — the sensitive data simply never passes through any code path that could log it.
- **Error classification happens at the adapter boundary, not downstream**: `SubmissionErrorCode`
  is assigned once, in the adapter, by reading an explicit `data-status` page attribute (never
  free text). `browser-session-agent.ts`'s `ERROR_TO_OUTCOME` map is the single place that turns
  those codes into task outcomes — a future real-provider adapter that returns the same codes
  gets the same handling for free.

## M4: manuscript/thesis authoring

- **Sections are append-only by the same discipline as excerpts, not a new pattern**: every
  draft/revision/proposal is a new row under a stable `section_key`; `status` is fixed at
  creation (`accepted` direct writes vs. `proposed` editorial edits); whether a proposal became
  current lives in `research_studio_author_decisions`, never as a mutation of the section row.
  `currentSections()` computes "current" in application code (latest row that is either directly
  `accepted` or a `proposed` row with an `accepted` decision) rather than via a DB view, kept
  simple on purpose — the correctness-critical property (a rejected proposal never becomes
  current, even after later edits) is what the tests pin down, not the implementation strategy.
- **The bounded revision loop reuses M1's revision-group cap exactly — no second bound was
  invented.** The one new piece of plumbing: because `export.manuscript`'s dependency list is
  fixed at creation and cannot be amended, `scientific-critic.ts` cancels the stale
  `export.manuscript` task and recreates the ENTIRE downstream tail
  (writing → citation.audit → critique.review → export.manuscript) as one childTasks batch when
  it requests a revision — otherwise export could race ahead of the new round. This is the only
  place in the codebase that cancels-and-replaces a task rather than just creating new ones
  alongside existing tasks; see `scientific-critic.ts`'s inline comment for why it's necessary.
- **No model, anywhere, by construction**: `SectionContentSource` includes `'model'` as a
  reserved enum value, and `createSection` explicitly REFUSES it
  (`WorkflowError('model_unavailable', ...)`) — a future model-backed writer has a typed slot to
  fill, but nothing in this pass can accidentally claim model authorship it didn't earn.
- **The Editorial Agent's "never claim detector evasion" rule is enforced, not just documented**:
  `FORBIDDEN_PARAM_PATTERN` is checked against every string-valued param (not just
  `writingSampleText`) before any work happens, so the constraint can't be bypassed by putting the
  forbidden text in a field nobody thought to sanitise.
- **Methods/Statistics Agent deliberately has zero computation of its own**: it is a thin,
  read-only wrapper around `src/research/service.ts#getRun` (an existing, independently-built and
  independently-tested artifact store with its own hash-verified integrity). This is the same
  "reuse an existing verified mechanism" discipline the original M1-M4 brief asked for across the
  whole feature, applied literally.

## M5: visuals and exports

- **A closed renderer registry is the security boundary, not a convention**: `visual-service.ts`'s
  three render functions (`renderBarChart`, `renderTable`, `renderFlow`) are the ONLY code that
  ever produces SVG. There is no code path from a visual spec to `eval`, a template string
  interpreted as markup-with-logic, or any other form of code execution — a spec is DATA consumed
  by a fixed function, exactly the same shape as the M3 browser adapter's fixed-registry argument
  against "implement the first provider before adding others" risk.
- **Three categories of visual, three different number-provenance guarantees, enforced at
  creation time, not at render time**: `data_derived` must name a real run + field (verified
  against `getRun`'s hash-checked output); `conceptual` is scanned and refused if it contains
  anything that looks like a measured quantity; `prisma_flow` bypasses both paths entirely —
  `createVisual` refuses it outright, forcing every caller through `buildPrismaFlow`, which is the
  only function that reads `research_studio_search_runs`/`screening_decisions` and is therefore
  the only place a PRISMA count can originate.
- **Export reuses the hash-chaining pattern a fourth time**: `buildProvenanceManifest` calls the
  exact same `canonical()`/`sha256Hex()` pair from `src/validation/study/manifest.ts` that M1's
  task events, M2's dedup identity, and every other evidence table in this feature already use —
  no new hashing scheme was invented for exports.
- **DOCX closes the M5 format gap through the same "verify, don't assume" discipline as
  everything else**: `inspectDocxStructure` doesn't trust that `docx`'s `Packer.toBuffer` worked —
  it re-opens the resulting bytes as a ZIP (checking the `PK` signature) and confirms a literal
  `word/document.xml` entry name is present, and the Export Agent refuses to publish a DOCX that
  fails this check rather than silently shipping a corrupt file.

## M6: integrated acceptance and hardening

M6 added an integrated, end-to-end acceptance rehearsal across one mode and every milestone in one
pass (`acceptance-m6-pg.test.ts`) plus a dedicated adversarial test set (`security-m6-pg.test.ts`:
prompt-injection text staying inert, path traversal in export downloads, SVG/script injection in
visual specs, tampered hashes, concurrent task claims). No new agent or data model was needed — as
expected, M6 was about proving the existing mechanisms compose correctly under one continuous
scenario and under deliberate attack. It did, however, surface two real defects that no
milestone's own piecemeal tests had caught: `visual-service.ts`'s `data_derived` field lookup
could never resolve a field against any real analysis output (fixed with `resolveRunField`,
supporting `"<column>.<metric>"` against the real per-column `results` rows), and
`invalidateVisualsForTasks` was written and unit-tested in M5 but never wired into the
`PATCH /sources/:sourceId` route. Also added real export-integrity verification
(`readVerifiedExport`, 409 on a tampered file) and a real reviewer-comments UI
(`ManuscriptWorkspace.tsx`) for a backend capability that had existed since M4 with no UI. Full
detail: [RESEARCH-STUDIO-RELEASE-HANDOFF.md](RESEARCH-STUDIO-RELEASE-HANDOFF.md).

A real provider adapter and MCP transport remain out of scope for every milestone above — see
[RESEARCH-STUDIO-BROWSER-CONNECTOR.md](RESEARCH-STUDIO-BROWSER-CONNECTOR.md).
