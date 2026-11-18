# Public scientific data connectors (research-only)

Connectors and an ingestion layer for four public sources. **Everything here is research-only**: it is not part of the approved clinical
evidence corpus, it is never embedded for retrieval, and a successful download validates nothing — retrieving an AlphaFold prediction is not
running AlphaFold, and nothing here is structure prediction, docking, biomarker discovery or clinical validation.

| Provider | What is retrieved | Classification (from the record, never from a file name) | Endpoints used |
|---|---|---|---|
| **AlphaFold DB** (EMBL-EBI/DeepMind) | an *existing* predicted structure (PDB / mmCIF) and PAE file, with pLDDT confidence metadata, by UniProt accession | `predicted` | `GET /api/prediction/{accession}`, files under `/files/` (host `alphafold.ebi.ac.uk`) |
| **RCSB PDB** | entry metadata + coordinates (PDB / mmCIF); full-text search | `experimental`, or `predicted` when the record says it is a computed/theoretical model | `data.rcsb.org/rest/v1/core/entry/{id}`, `files.rcsb.org/download/{id}.pdb`, `search.rcsb.org/rcsbsearch/v2/query` |
| **NCBI Datasets** | assembly report and, for genomes ≤ the cap (default 12 Mbp), FASTA + GFF3 from the download zip | RefSeq `curated_reference`; GenBank `author_supplied`; GFF3 annotation `predicted` | `api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/{acc}/dataset_report` and `…/download`, taxon search |
| **GEO** | series metadata (SOFT) and the series matrix (processed data) when ≤ the cap (default 20 MB) | `author_supplied` | `www.ncbi.nlm.nih.gov/geo/query/acc.cgi`, `ftp.ncbi.nlm.nih.gov/geo/series/…`, E-utilities `esearch/esummary` (db=gds) |

## Ingestion layer (`src/sciencedata/`)

- **Provenance on every stored file:** provider, stable accession, source URL (and final URL after validated redirects), provider version
  (AlphaFold `latestVersion`, PDB revision, NCBI accession.version + release date, GEO last update), retrieval time, SHA-256, size, content type, ETag,
  licence, attribution text, terms URL, restrictions and the research-only flag.
- **Classification** is explicit (`experimental | predicted | author_supplied | curated_reference | metadata_only`) with a note; a PDB entry that is a computed
  model is reported as `predicted`.
- **Immutable, versioned cache:** source rows are never updated. A new provider version or changed bytes creates a **new row**; workspace attachments pin an exact
  source id, so a stored analysis keeps its original bytes. The manifest tells you when a newer version is known. Files are content-addressed on disk and
  re-hashed on read, in provenance and at manifest export — a mismatch is refused (`integrity_failure`), never served.
- **Source files and derived results are separate:** structured parser summaries (structures: chains/residues/atoms/ranges, pLDDT bands for AlphaFold only; FASTA; GFF3;
  GEO series matrix) live in `sci_derived` with the parser version. Unsupported formats are stored unmodified and marked `unsupported` — no analysis is invented.
  Sequence data are parsed, never embedded as text; nothing is added to the clinical corpus (`reference_documents/chunks` stay untouched; tested).
- **Safe network use:** approved provider origins only (https; loopback http only for tests, never in production); every redirect hop must be https and allow-listed;
  hard byte cap enforced *while streaming* (declared length checked first); idle timeout; ≤ 2 retries with back-off for network errors/5xx/429 honouring `Retry-After`;
  per-host minimum interval (NCBI 400 ms ≈ under the 3 requests/s limit); identity encoding (no decompression bombs); `Accept: */*` (the default axios Accept header made
  `ftp.ncbi.nlm.nih.gov` stall on file GETs — found by the live check). Zip archives are read in memory with limits (entries, per-entry/total size, ratio, CRC, unsafe
  paths refused, Zip64 supported) and entry names are never used as file paths. Explicit error codes: `blocked_origin, redirect_refused, too_large, rate_limited,
  access_denied (HTTP 401/403), not_found, unavailable, timeout, bad_content_type, malformed_response, budget_exhausted, bad_accession, unsupported_format, integrity_failure`.
- **Bounded:** genomes above the cap and series matrices above the cap are **refused before any download**; supplementary files are listed, never fetched; no controlled-access
  sources exist in the connector set.
- **No identifiers to providers:** accessions are strictly validated; search text is limited to 2–200 safe characters and the UI/API say it is sent to the public provider.

## Scoping and authorisation

| Item | Scope |
|---|---|
| Public file bytes | shared cache by content hash |
| Source *visibility*, searches, workspaces, attachments, manifests | the caller's scope only: dashboard = the signed-in **user**; `/v1` = the **tenant** (a different scope kind never matches, even with the same id string) |
| Roles | dashboard `admin`, `operator`, `clinician` (like Research); `/v1` needs an API key |
| Limits | 50 workspaces per scope, 200 items per workspace |

Residual: whether a file is already in the shared cache can affect response time for another scope (it learns nothing about *who* fetched it).

## API

Dashboard (`/api/science`, cookie auth) and BaaS (`/v1/science`, API key; documented in `docs/openapi-v1.json`):
`GET /` (limits, terms, classifications) · `POST /search` · `POST /describe {provider, accession}` · `POST /retrieve {provider, accession, files:[…]}` ·
`GET /sources/{id}` (provenance, integrity, derived summaries) · `GET /sources/{id}/content` (bytes, `X-Content-SHA256`, `X-Research-Only`) ·
`POST/GET /workspaces` · `GET /workspaces/{id}` · `POST /workspaces/{id}/items {sourceId,label}` · `GET /workspaces/{id}/manifest`
(sources and derived summaries listed separately; checksums re-verified at export; manifest carries its own SHA-256 and the research-only notice).
Dashboard page: **Public data** (accession/search → classification & metadata → file selection → provenance → workspace → manifest).


## Review of the ingestion layer (2026-11-17) — findings, fixes and what remains

| Check | Finding | Fix / evidence |
|---|---|---|
| Hashes cover the exact downloaded bytes | Yes: raw identity-encoded bytes, never decompressed before hashing. **Defect found earlier by a test:** the shared `sha256()` JSON-serialised non-strings, so a Buffer was hashed as its JSON form. | bytes-correct `sha256` in the service; integrity tests recompute the hash independently |
| ZIP / Zip64 | Existing reader rejected traversal, bombs (ratio), encrypted entries, bad CRC, huge members. **Gaps found:** symbolic-link entries were not refused; duplicate member names were not refused; only the entries we *read* counted towards the total (an archive declaring gigabytes in unread entries passed); a Zip64 *directory* (entry count `0xFFFF`) was not understood, so the count limit could be bypassed; a member with data but zero compressed size slipped the ratio test (caught only by the CRC). | all fixed in `readZip`: any symlink anywhere → refusal; duplicate names → refusal; the DECLARED total of ALL entries is limited; Zip64 EOCD/locator parsed and its count limited; zero-csize refusal. Regression tests for each (`science.test.ts`). Entry names are never used as paths and nothing is extracted to disk. |
| Redirects cannot escape the provider | The allow-list was global: a redirect (or a file URL inside a provider's JSON) pointing at *another provider's* allow-listed host was accepted. | every request carries the provider's own origin set (`providerOrigins`), enforced on each redirect hop; regression tests (redirect hop to the other provider refused; AlphaFold record listing a file on the RCSB-side origin → `blocked_origin`, nothing requested there) |
| Cache reuse verifies integrity; attachments pinned | Cache hit already re-hashed the stored bytes; attachments pin an immutable source id (tested). **Residual:** the cache key trusts the provider's *version label* — if a provider silently changes a file without changing its version, a cached copy is served. | new `refresh: true` on retrieve bypasses the cache and stores a changed file as a **new** immutable version (never replaces); corrupted cache is re-fetched and repaired (tested) |
| Licence / attribution source-backed | The licence strings were provider-wide policy summaries written by the integration, **not read from the records**, but were presented as the licence of each file. | each source now carries `termsBasis: "provider_policy"` and `recordSpecificTerms: "Not established …"`; licence strings say "provider-wide policy" (GEO/NCBI: "No single licence … submitter may attach terms"); the terms URL is shown. Record- or submitter-specific terms are never claimed. The policy summaries themselves still come from the integration, not from a live read of the policy pages (not verified within the download budget). |
| HTTP 403 | Reported as `restricted`, implying controlled access. | now `access_denied` with the HTTP status; the message says the reason is **not established** and is **not assumed** to be controlled access (embargo, withdrawal, WAF/rate limiting and access control all produce the same status). GEO describe says the same. No source is ever labelled controlled-access by this connector. |
| Predictions vs experimental measurements | Separate by construction: classification per source; pLDDT bands are computed **only** for AlphaFold models; an experimental PDB's B-factor is never shown as confidence; a PDB entry that is itself a computed model is `predicted` and its B column is **not** assumed to be pLDDT. | tested through the service (`REVIEW: predictions and confidence stay separate…`) |

## Replay of live-fetched artifacts (offline; never a fresh live workflow)

`ScienceService.replay()` / `scripts/replay-science-artifact.ts` re-ingest bytes from an earlier live fetch **without any provider request** and without touching the
download ledger. The bytes must hash to the SHA-256 recorded at the live fetch or nothing is stored; the recorded URL must be on the provider's approved origins;
the source keeps its original URL, version and retrieval time and is labelled `acquisition: "replay_of_live_artifact"` with a note (`synthetic_fixture` for test data).
It is a service/script function, deliberately **not** an HTTP route.

| Replayed end to end (store → parse → attach → manifest → isolation → tamper detection) | Status |
|---|---|
| AlphaFold P69905 PDB (real bytes fetched live, `docs/evidence/live-artifacts/`) | ✓ same numbers as the live run (142 residues, 1,077 atoms, mean pLDDT 98.06); manifest integrity ok |
| NCBI GCF_000819615.1 genome zip (real Zip64 archive) | ✓ zip + FASTA (5,386 bp) + GFF3 stored as parent-linked sources |
| RCSB 4HHB | bytes retained and recorded; replayable with the script (not part of the automated test) |
| GEO series matrix path | exercised with a **synthetic** matrix fixture, labelled `synthetic_fixture` |
| **GEO GSE2 (the real artifact)** | **NOT replayable: its bytes were not retained** (only hash `9fcf768c…` and a parsed summary). One more live request is required and is **pending**: `GET https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE2/matrix/GSE2_series_matrix.txt.gz` (`Accept: */*`, expect 14,878 bytes, sha256 `9fcf768cbf83…`), which needs the 20-file allowance to be raised by an explicit decision (the ledger is at 20/20 and is not reset). Exact record: `docs/evidence/live-artifacts/PENDING.json`; then `npx tsx scripts/replay-science-artifact.ts --pending docs/evidence/live-artifacts/PENDING.json --file <saved bytes>`. |

## Configuration (all optional; none contains a secret)

`ANUCLAW_SCIDATA_DIR` (default `./data/scidata`), `ANUCLAW_SCIDATA_MAX_FILE_MB` (20), `ANUCLAW_SCIDATA_MAX_GENOME_MBP` (12), `ANUCLAW_SCIDATA_MAX_MATRIX_MB` (20),
`ANUCLAW_SCIDATA_NCBI_MIN_INTERVAL_MS` (400), `ANUCLAW_SCIDATA_MIN_INTERVAL_MS` (100), `ANUCLAW_SCIDATA_DESCRIBE_TTL_MS` (60000).
Tests/demos only: `ANUCLAW_SCIDATA_BASE_OVERRIDES` (JSON of base URLs; loopback only; refused in production).

## Evidence — and what each kind proves

| Evidence | What ran | Proves |
|---|---|---|
| **Deterministic tests, synthetic mock** (`science.test.ts`, 24) | parsers, zip/Zip64 safety, provider normalisation, classification, fetcher (outage, 429/Retry-After, oversized, redirect-to-other-origin, bad content type, timeout, pacing, `Accept`) against a local synthetic server | logic and failure handling |
| **Real-PostgreSQL service tests, synthetic mock** (`science-pg.test.ts`, 12) | provenance, immutable versioning and pinning, cache hit without network, checksum tamper detection, scope isolation, manifest hash, limits, nothing enters the clinical corpus | storage/isolation behaviour |
| **Route tests, synthetic mock** (`science-routes-pg.test.ts`, 5) | dashboard + `/v1` authentication, roles, ownership, tenant isolation | authorisation |
| **Browser workflow, synthetic mock** (`verify:local`) | the Public-data page end to end | the UI works |
| **LIVE, bounded** (`scripts/verify-science-live.ts`, `docs/evidence/science-live-*.json`) | real AlphaFold DB, RCSB, NCBI Datasets, GEO — see [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md) for exact results and what was **not** verified live | the connectors work against the real services for the examples listed |

None of this is clinical validation, and live retrieval of a record says nothing about the scientific validity of its content.
