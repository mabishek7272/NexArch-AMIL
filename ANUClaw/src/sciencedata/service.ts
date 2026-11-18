/**
 * Science data service: describe → retrieve → store (immutable, content-addressed) → parse (derived, separate) → workspaces → manifest.
 *
 * Isolation model
 *  - Public FILES are cached once and shared by content (disk path = sha256); public source ROWS are immutable.
 *  - Who has seen which source (sci_retrievals), searches (sci_searches), workspaces, attachments and derived-analysis access are all
 *    scoped to {kind:'user'|'tenant', id}. A source is visible to a scope only if that scope retrieved it; a workspace only to its owner.
 *  - Nothing here writes to the clinical evidence corpus (reference_documents/chunks); everything is labelled researchOnly.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { FetchResult, LiveBudget, SafeFetcher } from './fetcher';
import { PARSER_VERSION, parseFasta, parseGff3, parseMmcif, parsePdb, parseSeriesMatrix, readZip } from './parsers';
import {
  allowedOrigins, Bases, describeAlphaFold, describeGeo, describeNcbiGenome, describeRcsb, FilePlan, geoSearchUrl, geoSoftUrl, geoMatrixUrl, geoSummaryUrl, ncbiTaxonSearchUrl,
  normalizeAccession, parseGeoSearch, parseGeoSummary, parseNcbiTaxonSearch, parseRcsbSearch, PROVIDERS, rcsbSearchBody, RecordDescription, resolveBases, SEARCH_TEXT,
} from './providers';
import { Classification, PROVIDER_IDS, ProviderId, RESEARCH_ONLY_NOTICE, ScienceError, SourceRecord } from './types';

export interface Scope { kind: 'user' | 'tenant'; id: string }
const originOf = (u: string) => new URL(u).origin;
/** The origins each provider may talk to (requests AND redirects): a redirect from one provider to another provider's host is refused. */
export const providerOrigins = (b: Bases, p: ProviderId): string[] => [...new Set(p === 'alphafold' ? [b.alphafold] : p === 'rcsb' ? [b.rcsbData, b.rcsbFiles, b.rcsbSearch] : p === 'ncbi_datasets' ? [b.ncbiDatasets] : [b.ncbiWww, b.ncbiFtp, b.ncbiEutils])].map(originOf);
export interface ScienceConfig { dir: string; bases: Bases; maxFileBytes: number; maxGenomeBytes: number; maxMatrixBytes: number; maxItemsPerWorkspace: number; maxWorkspacesPerScope: number; describeTtlMs?: number }

export function scienceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScienceConfig {
  const mb = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n * 1e6 : d * 1e6; };
  return { dir: path.resolve(env.ANUCLAW_SCIDATA_DIR ?? './data/scidata'), bases: resolveBases(env), maxFileBytes: mb(env.ANUCLAW_SCIDATA_MAX_FILE_MB, 20), maxGenomeBytes: mb(env.ANUCLAW_SCIDATA_MAX_GENOME_MBP, 12), maxMatrixBytes: mb(env.ANUCLAW_SCIDATA_MAX_MATRIX_MB, 20), maxItemsPerWorkspace: 200, maxWorkspacesPerScope: 50, describeTtlMs: Number.isFinite(Number(env.ANUCLAW_SCIDATA_DESCRIBE_TTL_MS)) && env.ANUCLAW_SCIDATA_DESCRIBE_TTL_MS !== undefined ? Number(env.ANUCLAW_SCIDATA_DESCRIBE_TTL_MS) : 60_000 };
}

const row2src = (r: any): SourceRecord => ({ termsBasis: 'provider_policy', recordSpecificTerms: r.record_terms ?? NO_RECORD_TERMS, acquisition: r.acquisition ?? 'live', replayNote: r.replay_note ?? null,
  id: r.id, provider: r.provider, accession: r.accession, kind: r.kind, classification: r.classification, classificationNote: r.classification_note, format: r.format, sourceUrl: r.source_url, finalUrl: r.final_url,
  sourceVersion: r.source_version, retrievedAt: Number(r.retrieved_at), sha256: r.sha256.trim(), bytes: Number(r.bytes), license: r.license, attribution: r.attribution, termsUrl: r.terms_url, restrictions: r.restrictions,
  contentType: r.content_type, etag: r.etag, parentSourceId: r.parent_source_id, memberPath: r.member_path || null, researchOnly: true,
});
/** SHA-256 over the exact bytes (the shared documents helper JSON-serialises non-strings, which would hash a Buffer's JSON form, not its bytes). */
export const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string => JSON.stringify(sortKeys(v));
const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v;
export const NO_RECORD_TERMS = 'Not established: the licence shown is the provider\'s published provider-wide policy, not terms read from this record. Dataset-, submitter- or entry-specific terms may differ — check the record page before reuse.';
const nf = () => new WorkflowError(404, 'not_found', 'Not found.');
const toWf = (e: unknown): never => { if (e instanceof ScienceError) throw new WorkflowError(e.status, e.code, e.message, e.details); throw e; };

export class ScienceService {
  constructor(readonly cfg: ScienceConfig, readonly fetcher: SafeFetcher) {}

  static create(env: NodeJS.ProcessEnv = process.env, budget: LiveBudget | null = null): ScienceService {
    const cfg = scienceConfigFromEnv(env);
    const loop = Boolean(env.ANUCLAW_SCIDATA_BASE_OVERRIDES);
    return new ScienceService(cfg, new SafeFetcher({
      allowedOrigins: allowedOrigins(cfg.bases), allowInsecureLoopback: loop, defaultMaxBytes: cfg.maxFileBytes, budget,
      minIntervalMs: (h) => (h.endsWith('ncbi.nlm.nih.gov') ? Number(env.ANUCLAW_SCIDATA_NCBI_MIN_INTERVAL_MS ?? 400) : Number(env.ANUCLAW_SCIDATA_MIN_INTERVAL_MS ?? 100)),
    }));
  }

  catalog() {
    return {
      notice: RESEARCH_ONLY_NOTICE,
      limits: { maxFileBytes: this.cfg.maxFileBytes, maxGenomeBytes: this.cfg.maxGenomeBytes, maxMatrixBytes: this.cfg.maxMatrixBytes, maxItemsPerWorkspace: this.cfg.maxItemsPerWorkspace },
      providers: PROVIDER_IDS.map((id) => PROVIDERS[id]),
      classifications: { experimental: 'derived from an experiment', predicted: 'computational prediction or computational annotation', author_supplied: 'processed data supplied by the submitting authors', curated_reference: 'curated reference sequence', metadata_only: 'descriptive record only' },
    };
  }

  // ── search (scoped, logged privately) ──────────────────────────────────────
  async search(scope: Scope, provider: ProviderId, query: unknown) {
    if (!PROVIDER_IDS.includes(provider)) throw new WorkflowError(400, 'bad_provider', 'Unknown provider.');
    if (!PROVIDERS[provider].searchable) throw new WorkflowError(400, 'search_unsupported', `${PROVIDERS[provider].name.split(' (')[0]} has no public text search here; enter an accession (example ${PROVIDERS[provider].accessionExample}).`);
    const q = typeof query === 'string' ? query.trim() : '';
    if (!SEARCH_TEXT.test(q)) throw new WorkflowError(400, 'bad_query', 'Search text must be 2–200 characters of letters, digits and basic punctuation. It is sent to the public provider: never include patient identifiers.');
    const b = this.cfg.bases; let results: Array<Record<string, unknown>> = [];
    try {
      if (provider === 'rcsb') { const r = await this.req(provider, `${b.rcsbSearch}/rcsbsearch/v2/query`, { method: 'POST', body: rcsbSearchBody(q), maxBytes: 1e6, expectTypes: /json/i, accept: 'application/json' }); results = parseRcsbSearch(this.json(r)); }
      else if (provider === 'ncbi_datasets') { const r = await this.req(provider, ncbiTaxonSearchUrl(b, q), { maxBytes: 2e6, expectTypes: /json/i }); results = parseNcbiTaxonSearch(this.json(r)); }
      else if (provider === 'geo') {
        const ids = parseGeoSearch(this.json(await this.req(provider, geoSearchUrl(b, q), { maxBytes: 1e6, expectTypes: /json/i })));
        results = ids.length ? parseGeoSummary(this.json(await this.req(provider, geoSummaryUrl(b, ids), { maxBytes: 2e6, expectTypes: /json/i }))) : [];
      }
    } catch (e) { toWf(e); }
    await db.query('INSERT INTO sci_searches (id, scope_kind, scope_id, provider, query, at, result_count) VALUES ($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), scope.kind, scope.id, provider, q, Date.now(), results.length]);
    return { provider, query: q, results, note: 'Search results are not cached or shared; only an explicit retrieval stores anything.' };
  }

  /** Every provider call is confined to that provider's own origins (also across redirects). */
  private req(provider: ProviderId, url: string, o: Parameters<SafeFetcher['request']>[1] = {}) { return this.fetcher.request(url, { ...o, origins: providerOrigins(this.cfg.bases, provider) }); }

  private json(r: FetchResult): unknown { try { return JSON.parse(r.body.toString('utf8')); } catch { throw new ScienceError('malformed_response', 'The provider returned invalid JSON.', 502); } }

  // ── describe ───────────────────────────────────────────────────────────────
  private readonly descCache = new Map<string, { at: number; desc: RecordDescription; raw: FetchResult }>();
  /** Describing is a network call; the same record is reused for 60 s (e.g. describe followed by retrieve) so the provider is not asked twice. */
  async describe(scope: Scope, provider: ProviderId, accessionRaw: unknown) {
    if (!PROVIDER_IDS.includes(provider)) throw new WorkflowError(400, 'bad_provider', 'Unknown provider.');
    let acc: string, desc: RecordDescription, raw: FetchResult;
    try { acc = normalizeAccession(provider, accessionRaw); } catch (e) { return toWf(e); }
    const b = this.cfg.bases; const ck = `${provider}:${acc}`; const cached = this.descCache.get(ck);
    if (cached && Date.now() - cached.at < (this.cfg.describeTtlMs ?? 60_000)) { desc = cached.desc; raw = cached.raw; return this.finishDescribe(scope, provider, acc, desc, raw); }
    try {
      if (provider === 'alphafold') { raw = await this.req(provider, `${b.alphafold}/api/prediction/${acc}`, { maxBytes: 2e6, expectTypes: /json/i }); desc = describeAlphaFold(acc, this.json(raw), b); }
      else if (provider === 'rcsb') { raw = await this.req(provider, `${b.rcsbData}/rest/v1/core/entry/${acc}`, { maxBytes: 2e6, expectTypes: /json/i }); desc = describeRcsb(acc, this.json(raw), b); }
      else if (provider === 'ncbi_datasets') { raw = await this.req(provider, `${b.ncbiDatasets}/datasets/v2/genome/accession/${acc}/dataset_report`, { maxBytes: 2e6, expectTypes: /json/i }); desc = describeNcbiGenome(acc, this.json(raw), b, this.cfg.maxGenomeBytes); }
      else {
        raw = await this.req(provider, geoSoftUrl(b, acc), { maxBytes: 2e6 });
        let size: number | null = null; let none = false; let matrixWhy = '';
        try { const h = await this.req(provider, geoMatrixUrl(b, acc), { method: 'HEAD', retries: 1, maxBytes: 1e5 }); size = Number(h.headers['content-length']) || null; }
        catch (e) { if (e instanceof ScienceError && (e.code === 'not_found' || e.code === 'access_denied')) { none = true; matrixWhy = e.code === 'access_denied' ? 'The provider answered HTTP 403 (access denied) for this series\' matrix file. The reason is not established — it is not assumed to be controlled access.' : 'This series has no series-matrix file (metadata only).'; } else if (!(e instanceof ScienceError)) throw e; }
        desc = describeGeo(acc, raw.body.toString('utf8'), b, this.cfg.maxMatrixBytes, size);
        if (none) { desc.files = desc.files.filter((f) => f.key !== 'series_matrix'); desc.warnings.push(matrixWhy); }
      }
    } catch (e) { return toWf(e); }
    if ((this.cfg.describeTtlMs ?? 60_000) > 0) this.descCache.set(ck, { at: Date.now(), desc, raw }); if (this.descCache.size > 200) this.descCache.delete(this.descCache.keys().next().value as string);
    return this.finishDescribe(scope, provider, acc, desc, raw);
  }

  private async finishDescribe(scope: Scope, provider: ProviderId, acc: string, desc: RecordDescription, raw: FetchResult) {
    const info = PROVIDERS[provider];
    const metaSrc = await this.storeSource(scope, { provider, accession: acc, kind: 'record_metadata', classification: 'metadata_only', classificationNote: 'Descriptive provider record. The record\'s subject is classified separately (see "classification" of the record).', format: provider === 'geo' ? 'soft_text' : 'json', url: raw.finalUrl, finalUrl: raw.finalUrl, version: desc.sourceVersion, bytes: raw.body, contentType: raw.headers['content-type'] ?? null, etag: raw.headers.etag ?? null, parent: null, member: '' }, info);
    return { ...desc, termsUrl: info.termsUrl, license: info.license, attribution: info.attribution, restrictions: info.restrictions, metadataSourceId: metaSrc.id, researchOnly: true, notice: RESEARCH_ONLY_NOTICE };
  }

  // ── retrieve ───────────────────────────────────────────────────────────────
  /** `refresh: true` bypasses the cache for this call (a changed file becomes a NEW immutable version; nothing is replaced). */
  async retrieve(scope: Scope, provider: ProviderId, accessionRaw: unknown, fileKeys: unknown, opts: { refresh?: boolean } = {}) {
    const desc = await this.describe(scope, provider, accessionRaw);
    const wanted = Array.isArray(fileKeys) && fileKeys.length ? fileKeys.map(String) : null;
    if (!wanted) throw new WorkflowError(400, 'files_required', `Choose files to retrieve: ${desc.files.map((f) => f.key).join(', ') || '(none available)'}.`);
    const out: SourceRecord[] = []; const problems: Array<{ key: string; code: string; message: string }> = [];
    for (const key of wanted) {
      const refused = desc.refused?.find((r) => r.key === key);
      if (refused) { problems.push({ key, code: 'too_large', message: refused.reason }); continue; }
      const plan = desc.files.find((f) => f.key === key);
      if (!plan) { problems.push({ key, code: 'unknown_file', message: `No file '${key}' for this record.` }); continue; }
      try { out.push(...(await this.fetchFile(scope, provider, desc.accession, plan, Boolean(opts.refresh)))); } catch (e) { if (e instanceof ScienceError) problems.push({ key, code: e.code, message: e.message }); else throw e; }
    }
    return { record: { provider, accession: desc.accession, title: desc.title, classification: desc.classification, classificationNote: desc.classificationNote, sourceVersion: desc.sourceVersion }, sources: out, problems, researchOnly: true, notice: RESEARCH_ONLY_NOTICE };
  }

  private async fetchFile(scope: Scope, provider: ProviderId, acc: string, plan: FilePlan, refresh = false): Promise<SourceRecord[]> {
    const info = PROVIDERS[provider];
    // cache: same URL + same provider version + integrity-verified bytes on disk → no network
    const hit = await db.queryOne<any>(`SELECT * FROM sci_sources WHERE provider=$1 AND accession=$2 AND kind=$3 AND source_url=$4 AND source_version=$5 AND parent_source_id IS NULL ORDER BY retrieved_at DESC LIMIT 1`, [provider, acc, plan.kind, plan.url, plan.version]);
    if (!refresh && hit && hit.acquisition !== 'synthetic_fixture' && (await this.verifyOnDisk(hit.sha256.trim()))) {   // cache reuse ALWAYS re-verifies the stored bytes first
      const members = await db.query<any>('SELECT id FROM sci_sources WHERE parent_source_id = $1', [hit.id]);
      await this.grant(scope, hit.id); for (const m of members) await this.grant(scope, m.id);
      return [row2src(hit), ...(await Promise.all(members.map(async (m) => row2src((await db.queryOne<any>('SELECT * FROM sci_sources WHERE id=$1', [m.id]))!))))];
    }
    const r = await this.req(provider, plan.url, { maxBytes: Math.min(plan.maxBytes, this.cfg.maxFileBytes * (plan.archive ? 3 : 1)) });
    const src = await this.storeSource(scope, { provider, accession: acc, kind: plan.kind, classification: plan.classification, classificationNote: plan.classificationNote, format: plan.format, url: plan.url, finalUrl: r.finalUrl, version: plan.version, bytes: r.body, contentType: r.headers['content-type'] ?? null, etag: r.headers.etag ?? null, parent: null, member: '' }, info);
    const out = [src];
    if (plan.archive) out.push(...(await this.extractArchive(scope, provider, acc, src, r.body, { url: plan.url, finalUrl: r.finalUrl, version: plan.version, classification: plan.classification, classificationNote: plan.classificationNote })));
    return out;
  }

  /** Archive members are stored as their own sources (parent-linked) and parsed individually; the archive itself stays as served. Shared by live retrieval and replay. */
  private async extractArchive(scope: Scope, provider: ProviderId, acc: string, src: SourceRecord, bytes: Buffer, c: { url: string; finalUrl: string; version: string; classification: Classification; classificationNote: string; acquisition?: SourceRecord['acquisition']; replayNote?: string | null; retrievedAt?: number }): Promise<SourceRecord[]> {
    const info = PROVIDERS[provider]; const out: SourceRecord[] = [];
    let members: Array<{ name: string; data: Buffer }>;
    try { members = readZip(bytes, (n) => /\.(fna|fa|fasta|gff|gff3)$/i.test(n) && !n.endsWith('/')); } catch (e) { await this.storeDerived(src.id, 'zip', 'failed', { error: (e as Error).message }); throw e; }
    if (!members.length) await this.storeDerived(src.id, 'zip', 'unsupported', { reason: 'The archive contains no FASTA or GFF3 members this integration can read.' });
    for (const m of members) {
      const gff = /\.gff3?$/i.test(m.name);
      out.push(await this.storeSource(scope, { provider, accession: acc, kind: gff ? 'annotation_file' : 'sequence_file', classification: gff ? 'predicted' : c.classification, classificationNote: gff ? 'Gene/feature annotation produced by NCBI/submitter pipelines (computational or curated); not experimental evidence.' : c.classificationNote, format: gff ? 'gff3' : 'fasta', url: c.url, finalUrl: c.finalUrl, version: c.version, bytes: m.data, contentType: null, etag: null, parent: src.id, member: m.name, acquisition: c.acquisition, replayNote: c.replayNote, retrievedAt: c.retrievedAt }, info));
    }
    return out;
  }

  /**
   * OFFLINE replay of an artifact that was fetched live earlier. No provider request is made. The bytes must hash to the SHA-256 recorded at the
   * live fetch, or nothing is stored. The source is labelled `replay_of_live_artifact` (never `live`) and keeps the original URL, version and
   * retrieval time. `synthetic_fixture` is for tests and is labelled as such. This is deliberately a service/script function, not an HTTP route.
   */
  async replay(scope: Scope, a: { provider: ProviderId; accession: string; kind: SourceRecord['kind']; format: string; classification: Classification; classificationNote: string; sourceUrl: string; sourceVersion: string; bytes: Buffer; expectedSha256: string; retrievedAt: number; origin: 'live_artifact' | 'synthetic_fixture'; ledgerRef?: string; archive?: boolean }) {
    const acc = normalizeAccession(a.provider, a.accession); const got = sha256(a.bytes);
    if (!/^[0-9a-f]{64}$/.test(a.expectedSha256) || got !== a.expectedSha256) throw new WorkflowError(409, 'integrity_failure', `The replayed bytes hash to ${got.slice(0, 12)}…, not the recorded ${a.expectedSha256.slice(0, 12)}…; nothing was stored.`);
    if (a.origin === 'live_artifact' && !providerOrigins(this.cfg.bases, a.provider).includes(originOf(a.sourceUrl))) throw new WorkflowError(400, 'blocked_origin', 'The recorded source URL is not on this provider\'s approved origins.');
    const acquisition: SourceRecord['acquisition'] = a.origin === 'live_artifact' ? 'replay_of_live_artifact' : 'synthetic_fixture';
    const note = a.origin === 'live_artifact' ? `Replay of a live-fetched artifact (recorded sha256 ${a.expectedSha256}${a.ledgerRef ? `, ${a.ledgerRef}` : ''}); no provider request was made in this workflow.` : 'Synthetic test fixture replayed offline; not provider data.';
    const info = PROVIDERS[a.provider];
    const src = await this.storeSource(scope, { provider: a.provider, accession: acc, kind: a.kind, classification: a.classification, classificationNote: a.classificationNote, format: a.format, url: a.sourceUrl, finalUrl: a.sourceUrl, version: a.sourceVersion, bytes: a.bytes, contentType: null, etag: null, parent: null, member: '', acquisition, replayNote: note, retrievedAt: a.retrievedAt }, info);
    const out = [src];
    if (a.archive) out.push(...(await this.extractArchive(scope, a.provider, acc, src, a.bytes, { url: a.sourceUrl, finalUrl: a.sourceUrl, version: a.sourceVersion, classification: a.classification, classificationNote: a.classificationNote, acquisition, replayNote: note, retrievedAt: a.retrievedAt })));
    return { sources: out, acquisition, notice: RESEARCH_ONLY_NOTICE };
  }

  // ── storage ────────────────────────────────────────────────────────────────
  private filePath(sha: string) { return path.join(this.cfg.dir, 'files', sha.slice(0, 2), sha); }
  private async verifyOnDisk(sha: string): Promise<boolean> { try { return sha256(fs.readFileSync(this.filePath(sha))) === sha; } catch { return false; } }

  private async storeSource(scope: Scope, a: { provider: ProviderId; accession: string; kind: SourceRecord['kind']; classification: Classification; classificationNote: string; format: string; url: string; finalUrl: string; version: string; bytes: Buffer; contentType: string | null; etag: string | null; parent: string | null; member: string; acquisition?: SourceRecord['acquisition']; replayNote?: string | null; retrievedAt?: number }, info: (typeof PROVIDERS)[ProviderId]): Promise<SourceRecord> {
    const sha = sha256(a.bytes); const fp = this.filePath(sha);
    if (!(await this.verifyOnDisk(sha))) {
      fs.mkdirSync(path.dirname(fp), { recursive: true }); const tmp = `${fp}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      const fd = fs.openSync(tmp, 'wx', 0o640); try { fs.writeSync(fd, a.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, fp);
      if (sha256(fs.readFileSync(fp)) !== sha) throw new ScienceError('integrity_failure', 'The stored file failed its checksum after writing.', 500);
    }
    const id = crypto.randomUUID();
    const ins = await db.query<any>(
      `INSERT INTO sci_sources (id, provider, accession, kind, classification, classification_note, format, source_url, final_url, source_version, retrieved_at, sha256, bytes, license, attribution, terms_url, restrictions, content_type, etag, parent_source_id, member_path, record_terms, acquisition, replay_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) ON CONFLICT (provider, accession, kind, format, sha256, member_path) DO NOTHING RETURNING *`,
      [id, a.provider, a.accession, a.kind, a.classification, a.classificationNote, a.format, a.url, a.finalUrl, a.version, a.retrievedAt ?? Date.now(), sha, a.bytes.length, info.license, info.attribution, info.termsUrl, info.restrictions, a.contentType, a.etag, a.parent, a.member, NO_RECORD_TERMS, a.acquisition ?? 'live', a.replayNote ?? null]);
    const row = ins[0] ?? (await db.queryOne<any>('SELECT * FROM sci_sources WHERE provider=$1 AND accession=$2 AND kind=$3 AND format=$4 AND sha256=$5 AND member_path=$6', [a.provider, a.accession, a.kind, a.format, sha, a.member]))!;
    await this.grant(scope, row.id);
    if (ins[0]) await this.parse(row.id, a.format, a.bytes, a.provider);
    return row2src(row);
  }

  private async grant(scope: Scope, sourceId: string) {
    await db.query('INSERT INTO sci_retrievals (scope_kind, scope_id, source_id, at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope.kind, scope.id, sourceId, Date.now()]);
  }

  private async storeDerived(sourceId: string, parser: string, status: 'ok' | 'unsupported' | 'failed', summary: unknown) {
    await db.query('INSERT INTO sci_derived (id, source_id, parser, parser_version, status, summary_json, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_id, parser, parser_version) DO NOTHING', [crypto.randomUUID(), sourceId, parser, PARSER_VERSION, status, JSON.stringify(summary), Date.now()]);
  }

  /** Derived results live in their own table; the source bytes are never modified. Unsupported formats are stated, not guessed at. */
  private async parse(sourceId: string, format: string, bytes: Buffer, provider: ProviderId) {
    try {
      let summary: unknown; const parser = format;
      if (format === 'pdb') summary = parsePdb(bytes.toString('utf8'), { bFactorIsPlddt: provider === 'alphafold' });
      else if (format === 'mmcif') summary = parseMmcif(bytes.toString('utf8'), { bFactorIsPlddt: provider === 'alphafold' });
      else if (format === 'fasta') summary = parseFasta(bytes.toString('utf8'));
      else if (format === 'gff3') summary = parseGff3(bytes.toString('utf8'));
      else if (format === 'series_matrix') summary = parseSeriesMatrix(bytes);
      else if (format === 'json' || format === 'soft_text' || format === 'zip') { await this.storeDerived(sourceId, parser, 'unsupported', { reason: format === 'zip' ? 'Archive: members are stored and parsed individually.' : 'Descriptive record kept as received; no numeric parser applies.' }); return; }
      else { await this.storeDerived(sourceId, parser, 'unsupported', { reason: `No parser for format '${format}'. The file is stored unmodified and no analysis was attempted.` }); return; }
      await this.storeDerived(sourceId, parser, 'ok', summary);
    } catch (e) { await this.storeDerived(sourceId, format, 'failed', { error: e instanceof ScienceError ? e.message : 'The file could not be parsed.' }); }
  }

  // ── scoped reads ───────────────────────────────────────────────────────────
  private async visible(scope: Scope, id: string): Promise<any> {
    const r = await db.queryOne<any>('SELECT s.* FROM sci_sources s JOIN sci_retrievals v ON v.source_id = s.id WHERE s.id = $1 AND v.scope_kind = $2 AND v.scope_id = $3', [id, scope.kind, scope.id]);
    if (!r) throw nf(); return r;
  }
  async getSource(scope: Scope, id: string) {
    const r = await this.visible(scope, id);
    const d = await db.query<any>('SELECT parser, parser_version, status, summary_json, created_at FROM sci_derived WHERE source_id = $1 ORDER BY created_at', [id]);
    const integrity = (await this.verifyOnDisk(r.sha256.trim())) ? 'ok' : 'failed';
    return { source: row2src(r), integrity, derived: d.map((x) => ({ parser: x.parser, parserVersion: x.parser_version, status: x.status, summary: JSON.parse(x.summary_json), createdAt: Number(x.created_at) })), researchOnly: true };
  }
  /** Bytes are re-hashed on every read; a mismatch is refused, never served. */
  async readContent(scope: Scope, id: string): Promise<{ bytes: Buffer; source: SourceRecord }> {
    const r = await this.visible(scope, id);
    let b: Buffer; try { b = fs.readFileSync(this.filePath(r.sha256.trim())); } catch { throw new WorkflowError(409, 'integrity_failure', 'The stored file is missing.'); }
    if (sha256(b) !== r.sha256.trim()) throw new WorkflowError(409, 'integrity_failure', 'The stored file no longer matches its recorded checksum; it was not served.');
    return { bytes: b, source: row2src(r) };
  }
  async versions(scope: Scope, provider: ProviderId, accession: string) {
    const rows = await db.query<any>('SELECT s.* FROM sci_sources s JOIN sci_retrievals v ON v.source_id = s.id WHERE s.provider=$1 AND s.accession=$2 AND v.scope_kind=$3 AND v.scope_id=$4 ORDER BY s.retrieved_at', [provider, accession.toUpperCase(), scope.kind, scope.id]);
    return rows.map(row2src);
  }

  // ── workspaces ─────────────────────────────────────────────────────────────
  async createWorkspace(scope: Scope, name: unknown, purpose: unknown) {
    const n = typeof name === 'string' ? name.trim() : '', p = typeof purpose === 'string' ? purpose.trim() : '';
    if (!n || n.length > 200) throw new WorkflowError(400, 'validation', 'name is required (≤ 200 chars).');
    if (p.length < 5 || p.length > 500) throw new WorkflowError(400, 'validation', 'A purpose of use (5–500 chars) is required.');
    const c = await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM sci_workspaces WHERE scope_kind=$1 AND scope_id=$2', [scope.kind, scope.id]);
    if (Number(c!.n) >= this.cfg.maxWorkspacesPerScope) throw new WorkflowError(429, 'workspace_limit', `At most ${this.cfg.maxWorkspacesPerScope} workspaces.`);
    const id = crypto.randomUUID();
    await db.query('INSERT INTO sci_workspaces (id, scope_kind, scope_id, name, purpose, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, scope.kind, scope.id, n, p, Date.now()]);
    return { id, name: n, purpose: p, researchOnly: true };
  }
  async listWorkspaces(scope: Scope) {
    const r = await db.query<any>('SELECT w.id, w.name, w.purpose, w.created_at, (SELECT COUNT(*) FROM sci_items i WHERE i.workspace_id = w.id) AS items FROM sci_workspaces w WHERE w.scope_kind=$1 AND w.scope_id=$2 ORDER BY w.created_at DESC', [scope.kind, scope.id]);
    return r.map((w) => ({ id: w.id, name: w.name, purpose: w.purpose, createdAt: Number(w.created_at), items: Number(w.items) }));
  }
  private async ownWorkspace(scope: Scope, id: string) {
    const w = await db.queryOne<any>('SELECT * FROM sci_workspaces WHERE id=$1 AND scope_kind=$2 AND scope_id=$3', [id, scope.kind, scope.id]); if (!w) throw nf(); return w;
  }
  async attach(scope: Scope, workspaceId: string, sourceId: string, label: unknown, by: string) {
    const w = await this.ownWorkspace(scope, workspaceId); const s = await this.visible(scope, sourceId);   // both must belong to this scope
    const l = (typeof label === 'string' && label.trim() ? label.trim() : `${s.provider}:${s.accession}`).slice(0, 200);
    const c = await db.queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM sci_items WHERE workspace_id=$1', [w.id]);
    if (Number(c!.n) >= this.cfg.maxItemsPerWorkspace) throw new WorkflowError(429, 'item_limit', `At most ${this.cfg.maxItemsPerWorkspace} items per workspace.`);
    const id = crypto.randomUUID();
    const r = await db.query('INSERT INTO sci_items (id, workspace_id, source_id, label, attached_by, attached_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id, source_id) DO NOTHING RETURNING id', [id, w.id, s.id, l, by, Date.now()]);
    if (!r.length) throw new WorkflowError(409, 'already_attached', 'That exact source version is already in this workspace.');
    return { id, workspaceId: w.id, sourceId: s.id, label: l, pinnedVersion: s.source_version, sha256: s.sha256.trim() };
  }
  async getWorkspace(scope: Scope, id: string) {
    const w = await this.ownWorkspace(scope, id);
    const items = await db.query<any>('SELECT i.id AS item_id, i.label, i.attached_by, i.attached_at, s.* FROM sci_items i JOIN sci_sources s ON s.id = i.source_id WHERE i.workspace_id=$1 ORDER BY i.attached_at', [w.id]);
    return { id: w.id, name: w.name, purpose: w.purpose, createdAt: Number(w.created_at), researchOnly: true, items: items.map((i) => ({ itemId: i.item_id, label: i.label, attachedBy: i.attached_by, attachedAt: Number(i.attached_at), source: row2src(i) })) };
  }

  /** Manifest of everything attached, with checksums re-verified NOW. Source files and derived summaries are listed separately. */
  async manifest(scope: Scope, id: string) {
    const w = await this.getWorkspace(scope, id); const items = [];
    for (const it of w.items) {
      const integrity = (await this.verifyOnDisk(it.source.sha256)) ? 'ok' : 'failed';
      const d = await db.query<any>('SELECT parser, parser_version, status, summary_json FROM sci_derived WHERE source_id=$1 ORDER BY created_at', [it.source.id]);
      const newer = await db.queryOne<any>(`SELECT id, source_version FROM sci_sources WHERE provider=$1 AND accession=$2 AND kind=$3 AND member_path=$4 AND retrieved_at > $5 ORDER BY retrieved_at DESC LIMIT 1`, [it.source.provider, it.source.accession, it.source.kind, it.source.memberPath ?? '', it.source.retrievedAt]);
      items.push({ label: it.label, attachedAt: it.attachedAt, attachedBy: it.attachedBy, source: { ...it.source, localStorage: `content-addressed:${it.source.sha256}`, integrityCheckedAtExport: integrity }, derived: d.map((x) => ({ parser: x.parser, parserVersion: x.parser_version, status: x.status, summary: JSON.parse(x.summary_json) })), newerVersionKnown: newer ? { sourceId: newer.id, sourceVersion: newer.source_version } : null, attributionRequired: it.source.attribution });
    }
    const body = { schema: 'anuclaw-science-manifest/v1', generatedAt: new Date().toISOString(), workspace: { id: w.id, name: w.name, purpose: w.purpose }, researchOnly: true, notice: RESEARCH_ONLY_NOTICE, evidenceCorpus: 'These files are NOT part of the approved clinical evidence corpus.', items };
    return { ...body, manifestSha256: sha256(Buffer.from(canon(body))) };
  }
}

let singleton: ScienceService | null = null;
export const science = (): ScienceService => (singleton ??= ScienceService.create());
export const resetScienceForTests = () => { singleton = null; };
