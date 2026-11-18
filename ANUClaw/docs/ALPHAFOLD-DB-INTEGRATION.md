# AlphaFold Protein Structure Database integration

Implemented 18 November 2026. Research use only. **Predictions are not experimental validation or clinical conclusions.** No deployment, credential change or commit is part of this work.

## Inventory and architectural choice

The connector extends the existing public scientific-data hierarchy rather than the literature-specific Crossref connector:

| Existing component inspected | Reused or changed |
| --- | --- |
| `src/sciencedata/providers.ts`, `service.ts`, `fetcher.ts` | Existing AlphaFold/RCSB/NCBI/GEO providers, exact origin restrictions, bounded transport, content-addressed blobs, scoped retrievals and science workspaces |
| `src/research-studio/connectors/crossref.ts` | Confirmed that public-data connectors already reuse SafeFetcher |
| `src/research-studio/import-service.ts`, `evidence-service.ts`, `permissions.ts` | Project/source artifact directory, artifact records, owner-only project checks and existing downstream invalidation |
| `src/security/shared-limits.ts`, API rate-limit and usage middleware | Shared PostgreSQL counters and expiring concurrency leases; tenant plan quotas remain in force |
| `src/db/connection.ts` | Existing idempotent migration convention; new DDL follows Studio tables so foreign keys work on a clean database |
| `src/api/openapi-v1.ts` | Code-generated OpenAPI and exact route parity regression |
| `dashboard/src/nexarch/`, `App.tsx`, `Science.tsx`, `ResearchStudio.tsx` | Existing black/gold shell, primitives, roles, original public-data UI and Studio UI |
| `src/engines/structure/alphafold.ts` | Retired reliance on sunset fields, preserved all returned models, removed URL-as-artifact-hash behavior |
| `src/engines/docking/vina.ts`, dashboard `elab-engine.ts` | Existing engine needs prepared PDBQT; coordinates are handed off without starting Vina |
| `docs/evidence/live-artifacts/alphafold-P69905-model.pdb` and retained replay manifests | Historical artifacts remain labelled historical/replayed; they are not evidence for the current schema |
| Molecular viewers and Python environment | No Mol*, NGL or 3Dmol dependency previously existed. No PyMOL added |

Prior NexArch redesign changes in the dirty worktree were preserved. The unrelated concurrent editor was paused by the user before implementation continued.

## Official contract and endpoints

Primary contract: [official API OpenAPI JSON](https://alphafold.ebi.ac.uk/api/openapi.json), inspected directly with bounded HTTP requests. [API documentation](https://alphafold.ebi.ac.uk/api-docs), [official FAQ](https://alphafold.ebi.ac.uk/faq), and [EMBL-EBI sequence guidance](https://www.ebi.ac.uk/training/online/courses/navigating-alphafold-database/what-is-the-afdb/accessing-searching-afdb/access-via-website/) inform validation and limitations. No browser scraping.

Only `https://alphafold.ebi.ac.uk` is approved for production metadata and advertised files. No wildcard `ebi.ac.uk`, FTP or arbitrary user URL. Existing non-production, loopback-only base overrides remain available for deterministic HTTP fixtures and are labelled `synthetic_fixture`.

| Operation | Official GET endpoint | Detail |
| --- | --- | --- |
| `prediction` | `/api/prediction/{qualifier}` | All returned models/fragments; current fields `modelEntityId`, `sequence`, `sequenceStart`, `sequenceEnd` |
| `complex` | `/api/complex/{qualifier}` | Actual composition, stoichiometry, assembly and dynamic `complexPredictionAccuracy_*` metrics; files/chains remain absent if not supplied |
| `uniprot` | `/api/uniprot/summary/{qualifier}.json` | UniProt entry and model/entity residue coverage |
| `sequence` | `/api/sequence/summary?type=sequence&rows=25&id={sequence}` | Existing sequence-summary matches, not a new prediction or an implemented BLAST workflow |
| `annotations` | `/api/annotations/{qualifier}.json?type=MUTAGEN` | The current contract requires a type and currently enumerates only MUTAGEN |

The current summary contract documents a UniProt accession, not a custom residue-range suffix. Bounded probes of `P69905:1-50` and `P69905_1_50` were rejected by the provider. The connector sends the published accession/model qualifier and displays returned `segment_start/end` and `uniprot_start/end`. It does not invent an unsupported range URL or claim server-side arbitrary range filtering.

Supported identifiers: validated UniProt accession, optional isoform suffix, `AF-{accession}-F{fragment}`, numeric 16-digit AlphaFold identifiers, and a model version suffix. Paths, URL inputs, encoded traversal and query fragments are refused.

Sequence requests accept only 20–2,700 standard amino acids `ACDEFGHIKLMNPQRSTVWY`; case/whitespace normalize. The raw input is capped at 10,000 characters. FASTA headers, non-standard residues and unrelated metadata are refused. Only the sequence is sent. Sequence cache keys and logged request URLs use SHA-256 rather than the sequence; raw provider response artifacts retain their exact bytes under scoped access.

Postman CLI was unavailable. Orbit discovery returned prediction-compute services rather than this read-only official database, so those results were not reused. Transport/failure verification uses the repository's existing native HTTP fixture infrastructure and the real application service, not a fake application implementation.

## Application API

BaaS routes retain API-key/JWT authentication, shared tenant rate limits, plan quota and usage metering:

| Method | Route |
| --- | --- |
| POST | `/v1/science/alphafold/lookup` |
| GET | `/v1/science/alphafold/lookups/{id}` |
| POST | `/v1/science/alphafold/import` |
| GET | `/v1/science/alphafold/imports/{id}` |

Dashboard routes use `/api/science/alphafold` with the same four suffixes and signed-in roles admin/operator/clinician. Additional owner-only dashboard routes:

| Method | Suffix |
| --- | --- |
| POST / GET | `/projects/{projectId}/attachments` |
| POST | `/projects/{projectId}/receptors` |
| GET | `/projects/{projectId}/receptors/{receptorId}` |

Lookup body: `{ "operation": "prediction", "value": "P69905", "refresh": false }`.

Import body: `{ "lookupId": "<owned lookup>", "modelId": "AF-P69905-F1", "fileKey": "pdb", "refresh": false }`. File keys: `mmcif`, `bcif`, `pdb`, `pae`, `plddt`. The server resolves URLs from the stored normalized lookup; URL input is never accepted. Exactly one file is selected per import. The legacy `/science/describe` and `/science/retrieve` AlphaFold paths also use the guarded connector/import logic, preventing a weaker legacy import bypass.

Attach body: `{ "importId": "<owned import>" }`; optional `replaces` explicitly replaces an active attachment with a new immutable artifact. Tenant API clients can attach returned source IDs to the existing tenant-scoped science workspace endpoints. They cannot claim ownership of a dashboard user's Studio project.

Cancellation propagates from a disconnected dashboard/BaaS response to SafeFetcher, including response streaming. Provider failures retain explicit 404, 429, upstream failure, timeout, content-type, oversize and cancellation codes.

## Versioned normalization

`src/sciencedata/alphafold.ts` defines `anuclaw-alphafold/v1`. Unknown fields are ignored safely; original bytes remain hash-addressed. Required current model identifiers fail closed if renamed/missing. Deprecated `entryId`, `uniprotSequence`, `uniprotStart`, `uniprotEnd`, `isReviewed` and `isReferenceProteome` are not dependencies, even though some live responses still include them.

Normalized fields include:

- Model: ID, UniProt accessions, protein names, genes, organisms, taxonomy IDs, sequence/fragment length and range, type/category, predicted label, chain, entities, assembly/oligomeric state, advertised formats, official entry URL.
- Entity/chain: actual identifier/type, description, chain IDs and stoichiometry; missing data stays null/empty.
- UniProt: accession, ID, sequence length/checksum, segment range.
- Sequence summary: length, checksum and checksum type; sequence is not copied into request logs.
- Annotation: type, description, residues, regions/values/units, original evidence, source database/URL, and distinct `experimental`, `transferred`, `computational`, `unknown` evidence classes. No generic verified label.
- Confidence: provider type/average, mean pLDDT, fractions, interface metrics. Separate versioned imported confidence objects expose exact PAE matrix, supplied maximum PAE and indexed pLDDT scores with supplied residue numbers. Absent numbers/maxima remain null.
- Provenance: actual model producer, tool, creation date and version when supplied. Complex producers can differ from Google DeepMind.
- Warnings: scientific interpretation warnings and bounded provider warning strings when supplied.
- Coverage: explicit overlap ranges, known missing internal coverage, and whether full sequence length is known. Separate models are never merged.

## Storage, authorization and provenance

Public bytes reuse `sci_sources` and SHA-256 paths. `sci_retrievals` grants scope-specific visibility. New immutable `sci_af_lookups` rows persist normalized responses, metadata source/hash, operation/cache key, actor/scope, retrieval/check timestamps and cache status. `sci_af_imports` pins source, lookup, model, format and per-import provenance. Private associations are never made public merely because the external data is public.

Every import records provider, metadata retrieval endpoint and time, exact official file URL/final URL, file retrieval timestamp, model/UniProt identifiers, supplied model version/producer/tool, format, byte size, SHA-256, content type, CC BY attribution/EMBL terms, requester scope/actor, and raw metadata response hash. Loopback fixtures are explicitly marked synthetic. Raw response bytes hash to `responseHash`; application consumers receive normalized fields.

Studio attachment reuses `storeStructureArtifact` in the existing project/source artifact directory and `recordArtifact` in `research_studio_artifacts`. Filenames are SHA-256, never provider filenames. Both the source blob and project copy are hash checked. Project links pin an import and artifact ID; project identity is recorded on the link. Cross-user/tenant IDs return a non-enumerable 404. Unauthenticated callers get 401 and disallowed roles get 403.

Idempotent PostgreSQL DDL extends artifact kinds with `structure`/`confidence`, adds lookup/import/link/receptor tables, and installs immutability triggers for source/artifact provenance, lookup/import records, receptor inputs and attachment pins. Replacement can only invalidate the old association and insert a new artifact. Source hash/model-version/metadata-hash changes invoke existing excerpt/task/section/visual invalidation. Old hashes/bytes and historical attachments remain pinned. A corrupted cached blob is refused and never silently repaired.

The existing Studio provenance export now includes structure metadata, attribution and raw-response hash. Science manifests already export source attribution and checksums.

## Fetch safety, caching and limits

SafeFetcher validates HTTPS/exact origin on every redirect (at most three hops), destroys redirected streams, applies response/connection bounds, refuses oversized declared/streamed bodies, checks metadata JSON types, and supports ETag/Last-Modified conditional requests and 304. Safe transient metadata failures get at most two retries with bounded backoff (Retry-After capped at 10 seconds). 404 and permanent validation failures are not retried. Metadata attempt timeout is 12 seconds, metadata cap 2,000,000 bytes. Cancellation also interrupts streaming/backoff.

Imports get one bounded attempt (20 seconds; no automatic large-file retry), final URL/extension checking, MIME and format checks. PDB/mmCIF use existing parsers. bCIF requires a MessagePack map envelope and BinaryCIF signature keys; it is stored unmodified, not treated as scientifically validated. Confidence JSON is validated before normalization. All downloads are non-executable data and are served as attachments with `nosniff`.

| Setting | Default | Scope / behavior |
| --- | --- | --- |
| `ANUCLAW_AF_USER_RPM` | 30 | Authenticated dashboard user, shared PG fixed window |
| `ANUCLAW_AF_TENANT_RPM` | 120 | Tenant API principal, in addition to existing plan limits/quota; tenant auth has no distinct end-user identity |
| `ANUCLAW_AF_CONCURRENT_DOWNLOADS` | 2 | Shared global PG leases, maximum configurable 8 |
| `ANUCLAW_AF_MAX_FILE_BYTES` | 20,000,000 | Also bounded by existing science file cap; can only reduce the application maximum |
| `ANUCLAW_AF_DAILY_BYTES` | 200,000,000 | UTC daily window, per user/tenant scope; reserves full file cap before I/O; failures/short responses do not refund the reservation |
| `ANUCLAW_AF_CACHE_TTL_MS` | 60,000 | Bounded metadata/import cache TTL, configurable up to one hour |

The metadata cache contains at most 64 public payload entries, keyed by operation plus canonical qualifier/sequence SHA-256. Private lookup/audit records are persisted separately. Expired entries revalidate with ETag/Last-Modified if supplied. Manual metadata refresh bypasses TTL but may yield a provider 304; original retrieval time/hash are retained. `cache: hit`, `miss`, or `revalidated` is transparent; a hit is never live provider verification. File cache reuse is scoped, time bounded, and rehashes stored bytes; `refresh: true`/“Refresh selected artifact” performs a fresh bounded import. New bytes create a new immutable source version.

## NexArch UI and molecular viewer

Routes: `/nexarch/bioinformatics/structural-biology/alphafold`, `/nexarch/bioinformatics`, `/nexarch/evidence-library`, `/nexarch/dry-lab`. Evidence Library/Dry Lab expose their structure workflow; unrelated unbuilt features remain unavailable. Research Studio offers “Attach structure artifact” with project selection carried into the connector.

The real UI includes ID/sequence operations, model/fragment selection, metadata, explicit predicted label, confidence summaries, pLDDT table, PAE overview/exact row table, annotation evidence classes, complex components, explicit format import, project attachment, official entry links, provenance drawer, cache/retrieval time, cancellation, loading/empty/404/rate/error states and narrow layouts. Gold is brand/selection; confidence uses semantic blue/cyan/amber/orange and PAE green.

[3Dmol.js](https://3dmol.csb.pitt.edu/doc/) 2.5.5 is pinned under BSD-3-Clause. It supports PDB/mmCIF and confidence coloring. The production build lazy-loads a separate ~588 kB minified/~170 kB gzip chunk. Our adapter reads only the application's hash-verified content endpoint, uses no CDN script/worker/eval, and was exercised with `script-src 'self'`, `worker-src 'none'`. Existing dashboard font styles need their existing font origins. bCIF is import/download only in this adapter. WebGL absence leaves metadata/confidence tables and downloads available.

## Docking boundary

A confirmed selected chain/model/fragment becomes a pinned `anuclaw-receptor-input/v1` record including structure artifact ID/hash, residue coverage, warnings, requester, confirmation time, project review criterion/source, preparation status and nullable preparation tool/version. A criterion without a source is refused. No universal confidence cutoff is invented.

The existing `/api/elab-engine/dock` recognizes `projectId` + `receptorInputId` and rejects invalidated inputs or returns `409 receptor_preparation_required` with the pinned handoff. **This application has no governed coordinate-to-PDBQT preparation adapter yet.** Tool/version/prepared artifact remain null; no claim of preparation is made. Import/attachment/handoff never launches docking. A prepared receptor, recorded preparation tool/version and separate human action are still needed before Vina can run against this structure.

## Scientific and licence boundaries

[AlphaFold DB FAQ](https://alphafold.ebi.ac.uk/faq) states the data licence and model limitations. Imported predictions retain [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) attribution and [EMBL-EBI terms](https://www.ebi.ac.uk/about/terms-of-use/), shown in UI and export provenance. NexArch does not claim to have generated or own the predictions. Cite the database/model producer and the appropriate provider publications.

High confidence is not experimental validation. Low-confidence regions may be flexible/disordered. Relative domain orientation needs PAE inspection. Docking inherits model uncertainty. Predictions establish neither binding, mechanism, efficacy nor safety. Proteins/fragments without a sufficient API representation require an explicit user-directed bulk-data workflow, including special handling documented for some proteins over 2,700 residues. No FTP download is initiated.

## Verification and reproduction

Deterministic fixtures are under `src/sciencedata/fixtures/alphafold/`. Prediction fixtures omit all sunset fields. Other fixtures cover fragments, complex, summary, sequence and annotations; HTTP modes exercise missing/malformed/schema-change responses, 408/429/5xx, timeout, redirects, oversize, MIME mismatch and cancellation. PG tests use a fresh database and actual application routes, inspect hashes/copies/attribution, ownership/tenant 404s, immutable records, source replacement invalidation and docking confirmation/criteria.

```sh
# Supply ONLY a disposable PostgreSQL instance. Each PG suite creates and drops its own DB.
ANUCLAW_TEST_PG_URL=postgres://... npx vitest run --maxWorkers=3
ANUCLAW_TEST_PG_URL=postgres://... npx vitest run src/sciencedata src/engines/structure/alphafold.test.ts
npx tsc --noEmit
npm run lint
npm run build --prefix dashboard
npm run openapi:v1
npx tsx scripts/check-doc-links.ts

# Opt-in official provider test: P69905, one small public protein; five metadata calls,
# 500,000-byte total ledger, no coordinate downloads. Default fixture runs skip this test.
ANUCLAW_ALPHAFOLD_LIVE=1 npx vitest run src/sciencedata/alphafold.test.ts

# Real application/browser + disposable PG + explicitly synthetic HTTP provider.
ANUCLAW_TEST_PG_URL=postgres://... npx tsx scripts/alphafold-qa-server.ts
# In a second terminal, from dashboard/:
npx playwright test --config=e2e/alphafold/playwright.config.ts
# SIGTERM the QA server to drop its DB/files and remove its temporary auth state.
```

The QA configuration uses local Chrome by default; adjust executablePath for another local browser installation. The local QA-only fixture control route is not mounted by production code. Screenshots and browser assertions are fixture evidence, not a live provider/UI validation. No real coordinate import was performed in the opt-in live test. The live evidence file records the five actual HTTP 200 results, response byte sizes/hashes and timestamps. Historical AlphaFold PDB replay remains separate evidence.

Exact final commands, counts, skips and screenshot inspection are recorded in [verification evidence](evidence/alphafold-verification.json). [Live metadata evidence](evidence/alphafold-live.json) and [browser screenshots](evidence/alphafold-ui/README.md) are separate. PostgreSQL/OCR/live model tests requiring additional opt-in infrastructure remain skipped as listed in the verification evidence.

## Changed files

- Connector/persistence: `src/sciencedata/alphafold.ts`, `alphafold-service.ts`, `fetcher.ts`, `providers.ts`, `service.ts`, `types.ts`; `src/security/shared-limits.ts`; `src/db/connection.ts`.
- Existing integration paths: `src/engines/structure/alphafold.ts`; `src/research-studio/import-service.ts`, `evidence-service.ts`, `export-service.ts`, `types.ts`; `src/dashboard/server/routes/science.ts`, `elab-engine.ts`; `src/api/routes/baas-v1.ts`, `src/api/openapi-v1.ts`; generated `docs/openapi-v1.json`.
- Dashboard: `dashboard/src/nexarch/pages/AlphaFoldPage.tsx`, `alphafold.css`, `ResearchStudioPage.tsx`; `dashboard/src/nexarch/structure/MolecularViewer.tsx`; `dashboard/src/nexarch/nav.ts`, `NexArchShell.tsx`; `dashboard/src/App.tsx`; `dashboard/package.json`/lock for pinned 3Dmol dependency.
- Tests/QA: `src/sciencedata/alphafold.test.ts`, `alphafold-pg.test.ts`, `science.test.ts`, `science-pg.test.ts`, `testkit.ts`, `fixtures/alphafold/*.json`; `src/engines/structure/alphafold.test.ts`; `dashboard/e2e/alphafold/*`; `scripts/alphafold-qa-server.ts`.
- Documentation: this document, architecture, acceptance matrix, integration/implementation status, Studio release handoff/runbook, NexArch route map, API runbook, science-data notes, and separate verification/live/browser evidence. Unrelated pre-existing dirty files are not part of this connector change.
