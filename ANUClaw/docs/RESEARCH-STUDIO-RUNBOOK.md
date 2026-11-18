# Research Studio — runbook (M1-M6)

## Using it today

1. Log into the dashboard with an admin, operator, or clinician account.
2. Open **Research Studio** in the sidebar.
3. Fill in the project form: mode, title, topic, question, plus whatever mode-specific fields the
   form shows (e.g. a review mode asks for a real search method; `original_research` asks whether
   data already exists; `dissertation` asks for an institution and chapter outline). The form
   will not submit without the fields `validateBrief` requires — this mirrors the API, which
   rejects an incomplete brief with `brief_incomplete` rather than inventing a method or a result.
4. Click **Create project**. The Research Planner runs immediately (it is free and deterministic)
   and the real task graph appears.
5. Every task in the graph shows its real status and, for any type with no registered agent yet,
   an explicit **"no agent yet"** label — that task will sit `queued` until a later milestone adds
   the handler. This is expected, not an error.
6. **Advance now** calls `tick()` repeatedly (bounded) — right now this only ever advances the
   Research Planner task itself (already completed on creation), so for an M1-only project it
   typically reports "nothing more to advance."
7. **Verify event chain** re-derives the project's hash-chained audit log and reports whether it
   is intact.
8. Pause/Resume/Cancel operate on the real task-store state machine via the API.
9. For a review or dissertation project, the graph now includes a literature/evidence chain. In
   the **Evidence Workspace** panel (below the task graph):
   - **Import workflow**: paste RIS or BibTeX text and click Import. Every record that fails to
     parse is reported by name; well-formed records become real sources.
   - **Add a source manually**, or let an exact-DOI duplicate get auto-flagged in **Duplicates
     review** — confirm or reject each proposed match yourself; nothing is auto-merged.
   - **Source library** shows each source's three independent statuses (metadata verification,
     full text, correction/retraction) and lets you record a screening decision (include/exclude
     with a reason).
   - Click a source to open its **detail panel**: upload a permitted local PDF/text artifact
     (text is extracted automatically), or add a human-supplied excerpt with an exact page/section
     locator.
   - **Claims**: add a claim, then link an existing excerpt to it as supporting/contradicting —
     the claim's status badge reflects only what was explicitly linked, never an assumption.
   - **Evidence matrix**: for review/dissertation modes, running `literature.search_strategy` →
     `literature.search_execute` → `literature.verify_sources` → `evidence.extract` →
     `evidence.build_matrix` (via **Advance now**, after supplying what each step needs) produces
     a real, persisted matrix shown here.
10. Live Crossref search execution needs `ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR=1` on the server
    process; without it, `literature.search_execute` asks you to either enable it or import
    sources locally and resolve the task with `{"imported": true}`.
11. **Browser connector status** (top of the page): create a browser profile (only `provider:
    simulated` does anything — an offline Playwright test fixture, never a real site), Connect
    (moves it to `connecting`), Confirm login complete (moves it to `active` — for a real provider
    this would require actually logging in in a visible browser window first; the simulated
    provider needs no real login), then Disconnect (clears local session data, reversible) or
    Revoke (permanent). No password, cookie, or token is ever shown or stored.
12. The `browser.simulated_demo_session` task type (not yet wired into any project's graph —
    exercise it directly via the task-store/orchestrator APIs, or see
    `browser-session-agent-pg.test.ts`) drives one prompt through the simulated provider and
    returns its reply, proving the full M3 stack end to end without touching a real website.
13. **Manuscript Workspace** (below the Evidence Workspace): keep clicking **Advance now** to run
    `outline.draft` (completes immediately) and then `writing.draft_sections`/
    `writing.draft_chapters`, which asks for human-authored text per section/chapter — resolve it
    via the task graph's pause/resume controls are not enough for this; use
    `POST /tasks/:id/resolve` with `{ "answer": { "sections": [{ "sectionKey": "...", "text": "..." }] } }`
    directly (no dedicated UI button exists yet for arbitrary resolve payloads). Any section left
    unsupplied gets an honest `deterministic_digest` placeholder, shown with its own badge.
14. Select a section to propose an **editorial edit**: type your own rewritten text and click
    "Propose edit" — the preservation report flags dropped/added numbers and large wording
    changes as "interpretation-altering." Accept or reject it; accepting queues a real citation
    re-audit automatically.
15. Create a **journal/university guideline** record, confirm checklist items yourself (nothing
    is auto-ticked), and build a **compliance report** — it explicitly states it is not a journal
    acceptance or a checklist certification.
16. `original_research` projects with `hasData: true` and a `dataResearchRunId` get a real
    `methods.analysis` task that reuses the EXISTING, hash-verified run from `/api/research`
    (`src/research/service.ts`) — create that dataset/run first via the existing Research page if
    you want to exercise this path.
17. **Visuals and export** (bottom panel): click "Build PRISMA-style flow (real counts)" to render
    a real SVG from this project's actual search-run and screening-decision rows — it will show
    `n = 0` honestly until a real search run and screening decisions exist. Click "Run export" to
    produce all seven real formats (Markdown, BibTeX, RIS, LaTeX source, PDF, DOCX, provenance
    manifest) via the Export Agent; each is a real rendered/serialised file with a working
    download link and a real SHA-256. Running export again (e.g. after "Advance now" already ran
    it once) adds a fresh, newly-versioned set rather than overwriting — this is correct,
    versioned behaviour, not a bug.
18. A data-derived visual can be created via `POST /projects/:id/visuals` with `{ kind:
    "data_derived", spec: { runId, fields } }` — it will refuse to render if the named run hasn't
    completed, its stored output hash doesn't verify, or a named field isn't actually
    present/numeric in that real output. A conceptual visual (`kind: "conceptual"`) is refused if
    its spec contains anything that looks like a measured quantity (a field named
    count/value/n/total/percent/…).

## What you cannot do yet

- You cannot connect a REAL browser session or AI-provider account — only the offline simulated
  provider works; no MCP transport or real-provider adapter exists yet. See
  [RESEARCH-STUDIO-BROWSER-CONNECTOR.md](RESEARCH-STUDIO-BROWSER-CONNECTOR.md).
- No connector can retrieve full text — only a locally uploaded PDF/text artifact can ever set a
  source's `fulltext_status` to `full_text`.
- No agent writes narrative prose — every section is either human-authored (you supply the text)
  or an honest placeholder; there is no model or browser-backed writer yet.
- No LaTeX is compiled (the `.tex` export is source only); no chart types beyond bar
  charts/tables/box-and-arrow flow diagrams exist yet.
- No real journal/university submission requirements are built in — a compliance report is NOT a
  journal acceptance or certification, only a record of recorded word counts and human-confirmed
  checklist items.

## Operational notes

- Projects and tasks are Postgres-persisted under `research_studio_*` tables (migration added in
  `src/db/connection.ts`); nothing is in-memory-only.
- `research_studio_project_revisions` and `research_studio_task_events` are immutable at the
  database level (a trigger refuses UPDATE/DELETE/TRUNCATE) — if a migration ever needs to correct
  a row in these tables, that is a sign something is wrong upstream, not a normal maintenance
  operation.
- A task stuck in `queued` with `agentAvailable: false` is not stalled — it is honestly waiting
  for an agent that has not been built. A task stuck in `running` past `STALE_CLAIM_MS` (15
  minutes) without the server having crashed *would* indicate a real problem; `sweepStale` runs on
  every `tick()`, so under normal operation this self-heals within one orchestrator tick after a
  restart.
- Running the project's own test suite (`npx vitest run src/research-studio src/dashboard/server/routes/research-studio*.test.ts`)
  against `ANUCLAW_TEST_PG_URL` is the fastest way to confirm the engine still behaves correctly
  after a change; see [RESEARCH-STUDIO-EVALUATION.md](RESEARCH-STUDIO-EVALUATION.md) for the exact
  commands and current results.
