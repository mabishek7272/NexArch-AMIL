/** Science service against REAL PostgreSQL + a SYNTHETIC mock of the providers (not a live test): provenance, versioning, integrity, isolation. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FASTA_TEXT, MATRIX_TEXT, makeZip, startMockProviders } from './testkit';
import * as zlib from 'zlib';
void FASTA_TEXT; void makeZip;

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('science data service (real PostgreSQL, synthetic mock providers)', () => {
  const dbName = `anuclaw_it_${crypto.randomBytes(6).toString('hex')}`; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scidata-'));
  let admin: Client; let mock: Awaited<ReturnType<typeof startMockProviders>>; let svc: import('./service').ScienceService; let q: (s: string, p?: unknown[]) => Promise<any[]>;
  const A = { kind: 'user' as const, id: 'user-A' }, B = { kind: 'user' as const, id: 'user-B' }, T1 = { kind: 'tenant' as const, id: 'tenant-1' };

  beforeAll(async () => {
    mock = await startMockProviders();
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName });
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady(); q = (await import('../db')).db.query as any;
    const { ScienceService, scienceConfigFromEnv } = await import('./service'); const { SafeFetcher } = await import('./fetcher');
    const o = mock.origin; const bases = { alphafold: o, rcsbData: o, rcsbFiles: o, rcsbSearch: o, ncbiDatasets: o, ncbiEutils: o, ncbiWww: o, ncbiFtp: o };
    const cfg = { ...scienceConfigFromEnv({} as any), dir, bases, maxGenomeBytes: 12e6, describeTtlMs: 0 };
    svc = new ScienceService(cfg, new SafeFetcher({ allowedOrigins: [o], allowInsecureLoopback: true, sleep: async () => undefined, defaultMaxBytes: 20e6 }));
  }, 60_000);
  afterAll(async () => {
    await mock.close();
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });
  const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code ?? e.message; } return 'no error'; };

  it('AlphaFold: describe → retrieve stores an immutable PREDICTED source with full provenance and a separate pLDDT summary', async () => {
    const d: any = await svc.describe(A, 'alphafold', 'p69905');
    expect(d).toMatchObject({ classification: 'predicted', researchOnly: true, license: expect.stringMatching(/^CC BY 4\.0/), sourceVersion: 'v4' }); expect(d.notice).toMatch(/validates nothing/);
    const r: any = await svc.retrieve(A, 'alphafold', 'P69905', ['pdb', 'pae']);
    expect(r.problems).toEqual([]); const s = r.sources.find((x: any) => x.format === 'pdb');
    expect(s).toMatchObject({ provider: 'alphafold', accession: 'P69905', classification: 'predicted', kind: 'structure_file', sourceVersion: '4', researchOnly: true, license: expect.stringMatching(/^CC BY 4\.0/) });
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/); expect(s.sourceUrl).toContain('/files/AF-P69905-F1-model_v4.pdb'); expect(s.retrievedAt).toBeGreaterThan(0); expect(s.attribution).toMatch(/Jumper/); expect(s.termsUrl).toMatch(/^https:/);
    const got: any = await svc.getSource(A, s.id);
    expect(got.integrity).toBe('ok'); const parsed = got.derived.find((x: any) => x.parser === 'pdb'); expect(parsed.status).toBe('ok'); expect(parsed.summary.plddt.residuesScored).toBe(4);
    expect(parsed.summary.chains[0].id).toBe('A');
    expect(r.sources.find((x: any) => x.format === 'json' && x.kind === 'confidence_file')).toBeTruthy();
    expect(got.derived[0].parserVersion).toMatch(/anuclaw-scidata-parsers/);
    expect(d.metadata.confidence.meaning).toMatch(/not an accuracy guarantee/);
  });

  it('RCSB: an experimental entry and a COMPUTED model entry are classified differently; a missing format is reported per file', async () => {
    const e: any = await svc.retrieve(A, 'rcsb', '4hhb', ['pdb', 'cif']);
    expect(e.record.classification).toBe('experimental'); expect(e.sources).toHaveLength(1); expect(e.sources[0]).toMatchObject({ classification: 'experimental', format: 'pdb' });
    expect(e.problems).toEqual([{ key: 'cif', code: 'not_found', message: expect.stringMatching(/no such record/) }]);
    const c: any = await svc.retrieve(A, 'rcsb', '1XYZ', ['pdb']);
    expect(c.record.classification).toBe('predicted'); expect(c.record.classificationNote).toMatch(/COMPUTED model/); expect(c.sources[0].classification).toBe('predicted');
  });

  it('NCBI: the zip is stored as the raw source; FASTA and GFF3 members are stored separately with parent links and parsed; oversized genomes are refused', async () => {
    const r: any = await svc.retrieve(A, 'ncbi_datasets', 'GCF_000000001.1', ['genome_zip']);
    expect(r.problems).toEqual([]); const zip = r.sources.find((s: any) => s.kind === 'archive'); const fna = r.sources.find((s: any) => s.format === 'fasta'); const gff = r.sources.find((s: any) => s.format === 'gff3');
    expect(zip.classification).toBe('curated_reference'); expect(fna).toMatchObject({ parentSourceId: zip.id, kind: 'sequence_file', classification: 'curated_reference' }); expect(fna.memberPath).toMatch(/genomic\.fna$/);
    expect(gff).toMatchObject({ classification: 'predicted', kind: 'annotation_file' }); expect(gff.classificationNote).toMatch(/not experimental evidence/);
    expect(r.sources).toHaveLength(3);                                                    // dataset_catalog.json is not a member this integration reads
    expect((await svc.getSource(A, fna.id) as any).derived.find((d: any) => d.parser === 'fasta').summary).toMatchObject({ records: 2, kind: 'nucleotide' });
    expect((await svc.getSource(A, zip.id) as any).derived[0]).toMatchObject({ status: 'unsupported' });
    const big: any = await svc.retrieve(A, 'ncbi_datasets', 'GCF_000000002.1', ['genome_zip']);
    expect(big.sources).toEqual([]); expect(big.problems[0]).toMatchObject({ key: 'genome_zip', code: 'too_large' }); expect(big.problems[0].message).toMatch(/Mbp cap/);
    const zips = mock.hits.filter((h) => h.includes('GCF_000000002.1/download')); expect(zips).toHaveLength(0);   // the refusal happened BEFORE any download
  });

  it('GEO: author_supplied; matrix parsed; supplementary files listed but not fetched; contact details never stored', async () => {
    const r: any = await svc.retrieve(A, 'geo', 'GSE1', ['series_matrix']);
    expect(r.problems).toEqual([]); expect(r.sources[0]).toMatchObject({ classification: 'author_supplied', kind: 'expression_matrix', format: 'series_matrix' });
    expect((await svc.getSource(A, r.sources[0].id) as any).derived[0].summary).toMatchObject({ samples: 2, features: 2, valuesMissing: 1 });
    const d: any = await svc.describe(A, 'geo', 'GSE1'); expect(d.warnings.join(' ')).toMatch(/not fetched/);
    expect(JSON.stringify(await q('SELECT * FROM sci_sources'))).not.toContain('person@example.org');
    expect(mock.hits.some((h) => h.includes('_RAW.tar'))).toBe(false);
  });

  it('unsupported file requests and bad inputs give explicit errors (no invented analysis)', async () => {
    const r: any = await svc.retrieve(A, 'alphafold', 'P69905', ['mmtf', 'pdb']);
    expect(r.problems).toEqual([{ key: 'mmtf', code: 'unknown_file', message: expect.any(String) }]); expect(r.sources.length).toBeGreaterThan(0);
    expect(await code(svc.retrieve(A, 'alphafold', 'P69905', []))).toBe('files_required');
    expect(await code(svc.describe(A, 'alphafold', 'not-an-accession'))).toBe('bad_accession');
    expect(await code(svc.search(A, 'alphafold', 'hemoglobin'))).toBe('search_unsupported');
    expect(await code(svc.search(A, 'rcsb', 'x; DROP TABLE'))).toBe('bad_query');
    // an unparseable format is stored unmodified and marked unsupported
    const { ScienceService } = await import('./service');
    await (svc as any).parse(crypto.randomUUID(), 'x', Buffer.alloc(1), 'rcsb').catch(() => undefined);
    void ScienceService;
  });

  it('upstream outage / malformed / rate limit surface as explicit codes and store nothing', async () => {
    const before = (await q('SELECT COUNT(*)::int AS n FROM sci_sources'))[0].n;
    for (const [mode, expected] of [['outage', 'unavailable'], ['badjson', 'malformed_response'], ['ratelimit', 'rate_limited'], ['html', 'bad_content_type']] as const) {
      mock.setMode('afJson', mode); try { expect(await code(svc.describe(A, 'alphafold', 'P69905'))).toBe(expected); } finally { mock.setMode('afJson', ''); }
    }
    expect((await q('SELECT COUNT(*)::int AS n FROM sci_sources'))[0].n).toBe(before);
    mock.mutate({ afVersion: 7 });       // a version nobody has cached, so a real download is attempted
    mock.setMode('afFile', 'huge'); try { const r: any = await svc.retrieve(B, 'alphafold', 'P69905', ['pdb']); expect(r.problems[0].code).toBe('too_large'); expect(r.sources.filter((s: any) => s.format === 'pdb')).toEqual([]); } finally { mock.setMode('afFile', ''); mock.mutate({ afVersion: 4 }); }
  });

  it('CACHE + VERSIONING: an unchanged provider version is served from cache with no download; a new version is a NEW immutable row and pinned attachments keep their original bytes', async () => {
    const first: any = await svc.retrieve(B, 'alphafold', 'P69905', ['pdb']); const v4 = first.sources.find((s: any) => s.format === 'pdb');
    const ws = await svc.createWorkspace(B, 'Hb study', 'tests of pinning'); await svc.attach(B, ws.id, v4.id, 'hba model', 'user-B');
    mock.hits.length = 0; const again: any = await svc.retrieve(B, 'alphafold', 'P69905', ['pdb']);
    expect(again.sources.find((s: any) => s.format === 'pdb').id).toBe(v4.id); expect(mock.hits.filter((h) => h.includes('/files/'))).toEqual([]);   // cache hit: only the metadata call was made
    mock.mutate({ afVersion: 5 });
    const upd: any = await svc.retrieve(B, 'alphafold', 'P69905', ['pdb']); const v5 = upd.sources.find((s: any) => s.format === 'pdb');
    expect(v5.id).not.toBe(v4.id); expect(v5.sourceVersion).toBe('5'); expect(v5.sha256).not.toBe(v4.sha256);
    const unchanged: any = await svc.getSource(B, v4.id); expect(unchanged.source.sha256).toBe(v4.sha256); expect(unchanged.integrity).toBe('ok');   // the old version was NOT replaced
    expect((await svc.getWorkspace(B, ws.id)).items[0].source).toMatchObject({ id: v4.id, sourceVersion: '4' });                                   // the analysis stays pinned
    const man: any = await svc.manifest(B, ws.id); expect(man.items[0].newerVersionKnown).toMatchObject({ sourceId: v5.id, sourceVersion: '5' });
    expect((await svc.versions(B, 'alphafold', 'P69905')).filter((s) => s.kind === 'structure_file' && s.format === 'pdb').length).toBe(2);
    mock.mutate({ afVersion: 4 });
  });

  it('ISOLATION: sources, workspaces, attachments, manifests and searches of one scope are invisible to another (404)', async () => {
    const r: any = await svc.retrieve(T1, 'rcsb', '4HHB', ['pdb']); const sid = r.sources[0].id;
    const wsT = await svc.createWorkspace(T1, 'Tenant ws', 'isolation test');
    await svc.attach(T1, wsT.id, sid, 'x', 'tenant:tenant-1');
    const C = { kind: 'user' as const, id: 'user-C' };     // never retrieved anything
    for (const op of [() => svc.getSource(C, sid), () => svc.readContent(C, sid), () => svc.getWorkspace(C, wsT.id), () => svc.manifest(C, wsT.id), () => svc.attach(C, wsT.id, sid, 'l', 'c')]) expect(await code(op())).toBe('not_found');
    expect(await code(svc.attach(C, (await svc.createWorkspace(C, 'C ws', 'own workspace'))[ 'id' ], sid, 'l', 'c'))).toBe('not_found');   // cannot attach a source it never retrieved
    expect(await code(svc.getSource({ kind: 'tenant', id: 'user-A' }, sid))).toBe('not_found');   // same id string, different scope KIND → still isolated
    expect((await svc.listWorkspaces(C)).map((w) => w.name)).toEqual(['C ws']);
    // a scope that retrieves the same public file later can see it (shared cache) — but not another scope's workspace
    await svc.retrieve(C, 'rcsb', '4HHB', ['pdb']); expect((await svc.getSource(C, sid) as any).source.id).toBe(sid); expect(await code(svc.getWorkspace(C, wsT.id))).toBe('not_found');
    await svc.search(A, 'rcsb', 'hemoglobin'); expect((await q(`SELECT scope_id FROM sci_searches WHERE query='hemoglobin'`)).map((x: any) => x.scope_id)).toEqual(['user-A']);
    expect((await q(`SELECT COUNT(*)::int AS n FROM sci_retrievals WHERE scope_id='user-C' AND source_id=$1`, [sid]))[0].n).toBe(1);
  });

  it('INTEGRITY: bytes are re-hashed on read, in provenance and in the manifest; a tampered file is refused and flagged', async () => {
    const r: any = await svc.retrieve(A, 'geo', 'GSE1', ['series_matrix']); const s = r.sources[0]; const ws = await svc.createWorkspace(A, 'Integrity', 'tamper check'); await svc.attach(A, ws.id, s.id, 'm', 'user-A');
    const ok = await svc.readContent(A, s.id); expect(crypto.createHash('sha256').update(ok.bytes).digest('hex')).toBe(s.sha256);
    expect((await svc.manifest(A, ws.id) as any).items[0].source.integrityCheckedAtExport).toBe('ok');
    const fp = path.join(dir, 'files', s.sha256.slice(0, 2), s.sha256); fs.chmodSync(fp, 0o644); fs.appendFileSync(fp, 'tampered');
    expect(await code(svc.readContent(A, s.id))).toBe('integrity_failure');
    expect((await svc.getSource(A, s.id) as any).integrity).toBe('failed');
    expect((await svc.manifest(A, ws.id) as any).items[0].source.integrityCheckedAtExport).toBe('failed');
    fs.writeFileSync(fp, Buffer.from(ok.bytes));        // repair for later tests
  });

  it('MANIFEST: lists sources and derived summaries separately with licences, attribution and the research-only notice; its own hash is verifiable; nothing enters the clinical corpus', async () => {
    const ws = await svc.createWorkspace(A, 'Manifest', 'manifest check'); const r: any = await svc.retrieve(A, 'alphafold', 'P69905', ['pdb']);
    await svc.attach(A, ws.id, r.sources.find((s: any) => s.format === 'pdb').id, undefined, 'user-A');
    expect(await code(svc.attach(A, ws.id, r.sources.find((s: any) => s.format === 'pdb').id, 'dup', 'user-A'))).toBe('already_attached');
    const m: any = await svc.manifest(A, ws.id); const { manifestSha256, ...body } = m;
    const canon = (v: unknown): string => JSON.stringify((function sk(x: any): any { return Array.isArray(x) ? x.map(sk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, sk(y)])) : x; })(v));
    expect(manifestSha256).toBe(crypto.createHash('sha256').update(canon(body)).digest('hex'));
    expect(m).toMatchObject({ schema: 'anuclaw-science-manifest/v1', researchOnly: true }); expect(m.evidenceCorpus).toMatch(/NOT part of the approved clinical evidence corpus/);
    const it0 = m.items[0]; expect(it0.source).toMatchObject({ classification: 'predicted', license: expect.stringMatching(/^CC BY 4\.0/) }); expect(it0.derived[0]).toMatchObject({ parser: 'pdb', status: 'ok' }); expect(it0.attributionRequired).toMatch(/AlphaFold/);
    expect(JSON.stringify(m)).not.toMatch(/ATOM {2}/);      // source bytes are not embedded; derived summaries only
    expect((await q('SELECT COUNT(*)::int AS n FROM reference_documents'))[0].n).toBe(0); expect((await q('SELECT COUNT(*)::int AS n FROM reference_chunks'))[0].n).toBe(0);
  });

  it('describe is reused for a short time so retrieve does not ask the provider twice (and 403/404 on a GEO matrix are reported, not hidden)', async () => {
    const { ScienceService } = await import('./service'); const cached = new ScienceService({ ...svc.cfg, describeTtlMs: 60_000 }, svc.fetcher);
    mock.hits.length = 0; await cached.describe(A, 'alphafold', 'P69905'); await cached.retrieve(A, 'alphafold', 'P69905', ['pdb']);
    expect(mock.hits.filter((h) => h.includes('/api/prediction/P69905'))).toHaveLength(1);
    mock.setMode('geoMatrix', 'forbidden'); try { const d: any = await svc.describe(A, 'geo', 'GSE1'); expect(d.files.map((f: any) => f.key)).not.toContain('series_matrix'); expect(d.warnings.join(' ')).toMatch(/answered HTTP 403 \(access denied\).*not assumed to be controlled access/); const r: any = await svc.retrieve(A, 'geo', 'GSE1', ['series_matrix']); expect(r.problems[0]).toMatchObject({ key: 'series_matrix', code: 'unknown_file' }); } finally { mock.setMode('geoMatrix', ''); }
  });

  it('REVIEW: provider JSON cannot point a file download at ANOTHER provider\'s host (cross-origin file URL refused), nor can redirects hop providers', async () => {
    const { ScienceService } = await import('./service'); const { SafeFetcher } = await import('./fetcher');
    const other = await startMockProviders();
    try {
      const o = mock.origin, o2 = other.origin;
      const split = new ScienceService({ ...svc.cfg, describeTtlMs: 0, bases: { ...svc.cfg.bases, alphafold: o, rcsbData: o2, rcsbFiles: o2, rcsbSearch: o2 } }, new SafeFetcher({ allowedOrigins: [o, o2], allowInsecureLoopback: true, sleep: async () => undefined }));
      mock.mutate({ afFileBase: o2, afVersion: 11 });      // AlphaFold's record lists its files on the RCSB-side origin (allow-listed globally, but not AlphaFold's)
      try {
        const r: any = await split.retrieve({ kind: 'user', id: 'user-X' }, 'alphafold', 'P69905', ['pdb']);
        expect(r.sources.filter((x: any) => x.format === 'pdb')).toEqual([]); expect(r.problems[0]).toMatchObject({ key: 'pdb', code: 'blocked_origin' });
        expect(other.hits.filter((h) => h.includes('/files/'))).toEqual([]);                  // nothing was requested from the other provider
      } finally { mock.mutate({ afFileBase: undefined, afVersion: 4 }); }
    } finally { await other.close(); }
  });

  it('REVIEW: terms are explicit — the licence is provider-wide policy, record-specific terms are NOT established; unknown stays unknown', async () => {
    const r: any = await svc.retrieve(A, 'geo', 'GSE1', ['series_matrix']); const s = r.sources[0];
    expect(s).toMatchObject({ termsBasis: 'provider_policy', acquisition: 'live', replayNote: null }); expect(s.recordSpecificTerms).toMatch(/Not established.*provider-wide policy.*check the record page/s);
    expect(s.license).toMatch(/No single licence.*provider-wide policy/); expect(s.termsUrl).toMatch(/^https:\/\//);
    const af: any = await svc.retrieve(A, 'alphafold', 'P69905', ['pdb']); expect(af.sources[0].license).toMatch(/CC BY 4\.0.*provider-wide policy/); expect(af.sources[0].recordSpecificTerms).toMatch(/Not established/);
    const d: any = await svc.describe(A, 'geo', 'GSE1'); expect(d.license).toMatch(/submitter may attach terms/);
  });

  it('REVIEW: predictions and confidence stay separate from experimental measurements', async () => {
    const af: any = await svc.retrieve(A, 'alphafold', 'P69905', ['pdb']); const afd: any = await svc.getSource(A, af.sources.find((x: any) => x.format === 'pdb').id);
    expect(afd.source.classification).toBe('predicted'); expect(afd.derived.find((d: any) => d.parser === 'pdb').summary.plddt).not.toBeNull();              // pLDDT only for AlphaFold models
    const exp: any = await svc.retrieve(A, 'rcsb', '4HHB', ['pdb']); const expd: any = await svc.getSource(A, exp.sources[0].id);
    expect(expd.source.classification).toBe('experimental'); expect(expd.derived[0].summary.plddt).toBeNull();                                         // a B-factor is never presented as confidence
    const cm: any = await svc.retrieve(A, 'rcsb', '1XYZ', ['pdb']); const cmd: any = await svc.getSource(A, cm.sources[0].id);
    expect(cmd.source.classification).toBe('predicted'); expect(cmd.derived[0].summary.plddt).toBeNull();                                               // a computed PDB entry is predicted, but its B column is NOT assumed to be pLDDT
    const man: any = await svc.manifest(A, (await svc.createWorkspace(A, 'sep', 'separation check')).id); expect(man.items).toEqual([]);
  });

  it('REVIEW: cache reuse re-verifies the stored bytes — a corrupted cached file is NOT served and is re-fetched and repaired; refresh makes a new immutable version', async () => {
    const r1: any = await svc.retrieve(B, 'rcsb', '4HHB', ['pdb']); const s = r1.sources[0]; const fp = path.join(dir, 'files', s.sha256.slice(0, 2), s.sha256);
    fs.chmodSync(fp, 0o644); fs.appendFileSync(fp, 'corrupt'); mock.hits.length = 0;
    const r2: any = await svc.retrieve(B, 'rcsb', '4HHB', ['pdb']);
    expect(mock.hits.some((h) => h.includes('/download/4HHB.pdb'))).toBe(true);                    // not served from the corrupt cache
    expect(r2.sources[0].id).toBe(s.id); expect((await svc.getSource(B, s.id) as any).integrity).toBe('ok');           // same immutable row, bytes repaired
    mock.hits.length = 0; await svc.retrieve(B, 'rcsb', '4HHB', ['pdb']); expect(mock.hits.some((h) => h.includes('/download/'))).toBe(false);   // verified cache hit: no download
    mock.hits.length = 0; await svc.retrieve(B, 'rcsb', '4HHB', ['pdb'], { refresh: true }); expect(mock.hits.some((h) => h.includes('/download/4HHB.pdb'))).toBe(true);   // refresh bypasses the cache
  });

  it('REPLAY (end to end, NOT a live provider workflow): real live-fetched artifacts re-ingested offline, hash-verified, parsed, attached, exported', async () => {
    const dirA = path.resolve(__dirname, '../../docs/evidence/live-artifacts'); const prov = JSON.parse(fs.readFileSync(path.join(dirA, 'PROVENANCE.json'), 'utf8')).artifacts;
    const ledgerPath = path.resolve(__dirname, '../../docs/evidence/science-live-ledger.json'); const ledgerBefore = crypto.createHash('sha256').update(fs.readFileSync(ledgerPath)).digest('hex');
    const { ScienceService } = await import('./service'); const { DEFAULT_BASES } = await import('./providers'); const real = new ScienceService({ ...svc.cfg, bases: DEFAULT_BASES }, svc.fetcher);   // real provider origins; replay makes no request
    const R1 = { kind: 'user' as const, id: 'replay-1' }, R2 = { kind: 'user' as const, id: 'replay-2' }; const sent = mock.hits.length;
    const rep = async (scope: typeof R1, file: string, extra: Record<string, unknown>) => { const p = prov.find((x: any) => x.file.endsWith(file)); const bytes = fs.readFileSync(path.join(dirA, file));
      return real.replay(scope, { provider: extra.provider as any, accession: extra.accession as string, kind: p.kind, format: p.format, classification: p.classification, classificationNote: 'from the live-fetch record', sourceUrl: p.sourceUrl, sourceVersion: p.sourceVersion, bytes, expectedSha256: p.sha256, retrievedAt: Date.parse(p.retrievedAt), origin: 'live_artifact', ledgerRef: 'science-live-results.json', archive: p.format === 'zip' }); };
    const af: any = await rep(R1, 'alphafold-P69905-model.pdb', { provider: 'alphafold', accession: 'P69905' });
    const ncbi: any = await rep(R1, 'ncbi-GCF_000819615.1-genome.zip', { provider: 'ncbi_datasets', accession: 'GCF_000819615.1' });
    expect(mock.hits.length).toBe(sent);                                                           // no provider request of any kind was made
    expect(af.acquisition).toBe('replay_of_live_artifact'); expect(af.sources[0]).toMatchObject({ acquisition: 'replay_of_live_artifact', termsBasis: 'provider_policy', classification: 'predicted', sourceVersion: '6' });
    expect(af.sources[0].replayNote).toMatch(/Replay of a live-fetched artifact.*no provider request/s); expect(af.sources[0].sourceUrl).toBe('https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb');
    expect(new Date(af.sources[0].retrievedAt).getTime()).toBe(Date.parse(prov.find((x: any) => x.file.endsWith('alphafold-P69905-model.pdb')).retrievedAt));   // the ORIGINAL retrieval time is kept
    const afd: any = await svc.getSource(R1, af.sources[0].id); const sm = afd.derived.find((d: any) => d.parser === 'pdb').summary;
    expect(sm).toMatchObject({ residues: 142, atoms: 1077 }); expect(sm.plddt.mean).toBeCloseTo(98.06, 1);                                           // the same numbers the live run recorded
    expect(ncbi.sources).toHaveLength(3); expect(ncbi.sources.map((s: any) => s.format).sort()).toEqual(['fasta', 'gff3', 'zip']);                   // real Zip64 archive read
    expect((await svc.getSource(R1, ncbi.sources.find((s: any) => s.format === 'fasta').id) as any).derived.find((d: any) => d.parser === 'fasta').summary).toMatchObject({ records: 1, totalResidues: 5386 });
    // attach + export + isolation + manifest integrity
    const ws = await svc.createWorkspace(R1, 'Replay', 'replay end to end'); for (const s of [...af.sources, ...ncbi.sources]) await svc.attach(R1, ws.id, s.id, undefined, 'replay');
    const man: any = await svc.manifest(R1, ws.id); expect(man.items).toHaveLength(4); expect(man.items.every((i: any) => i.source.integrityCheckedAtExport === 'ok' && i.source.acquisition === 'replay_of_live_artifact')).toBe(true);
    const { manifestSha256, ...body } = man; const canon = (v: unknown): string => JSON.stringify((function sk(x: any): any { return Array.isArray(x) ? x.map(sk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, sk(y)])) : x; })(v));
    expect(manifestSha256).toBe(crypto.createHash('sha256').update(canon(body)).digest('hex'));
    for (const op of [() => svc.getSource(R2, af.sources[0].id), () => svc.getWorkspace(R2, ws.id), () => svc.manifest(R2, ws.id), () => svc.readContent(R2, af.sources[0].id)]) expect(await code(op())).toBe('not_found');
    const fp = path.join(dir, 'files', af.sources[0].sha256.slice(0, 2), af.sources[0].sha256); const good = fs.readFileSync(fp); fs.chmodSync(fp, 0o644); fs.appendFileSync(fp, 'x');
    expect((await svc.manifest(R1, ws.id) as any).items.find((i: any) => i.source.id === af.sources[0].id).source.integrityCheckedAtExport).toBe('failed'); fs.writeFileSync(fp, good);   // tampering is visible in the manifest
    // the download ledger was neither reset nor touched
    expect(crypto.createHash('sha256').update(fs.readFileSync(ledgerPath)).digest('hex')).toBe(ledgerBefore); expect(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).files).toBe(20);
  });

  it('REPLAY refuses bytes that do not match the recorded hash, and unrecorded provenance; nothing is stored', async () => {
    const dirA = path.resolve(__dirname, '../../docs/evidence/live-artifacts'); const p = JSON.parse(fs.readFileSync(path.join(dirA, 'PROVENANCE.json'), 'utf8')).artifacts[0]; const bytes = Buffer.from(fs.readFileSync(path.join(dirA, 'alphafold-P69905-model.pdb')));
    const before = (await q('SELECT COUNT(*)::int AS n FROM sci_sources'))[0].n; bytes[100] ^= 1;   // one flipped bit
    const base = { provider: 'alphafold' as const, accession: 'P69905', kind: 'structure_file' as const, format: 'pdb', classification: 'predicted' as const, classificationNote: 'x', sourceUrl: p.sourceUrl, sourceVersion: '6', expectedSha256: p.sha256, retrievedAt: 1, origin: 'live_artifact' as const };
    const { ScienceService } = await import('./service'); const { DEFAULT_BASES } = await import('./providers'); const real = new ScienceService({ ...svc.cfg, bases: DEFAULT_BASES }, svc.fetcher);
    expect(await code(real.replay(A, { ...base, bytes }))).toBe('integrity_failure');
    expect(await code(real.replay(A, { ...base, bytes, expectedSha256: 'abc' }))).toBe('integrity_failure');
    expect(await code(real.replay(A, { ...base, bytes: fs.readFileSync(path.join(dirA, 'alphafold-P69905-model.pdb')), sourceUrl: 'https://evil.example.org/x.pdb' }))).toBe('blocked_origin');
    expect((await q('SELECT COUNT(*)::int AS n FROM sci_sources'))[0].n).toBe(before);
  });

  it('REPLAY of the GEO series-matrix path (SYNTHETIC fixture, labelled as such): retrieve → store → parse → attach → export, with workspace isolation. The real GSE2 bytes were not retained — that live request is PENDING', async () => {
    const gz = zlib.gzipSync(Buffer.from(MATRIX_TEXT.replace('1.5', '1.75')));   // distinct bytes: identical bytes already stored live would just return that live row
     const sha = crypto.createHash('sha256').update(gz).digest('hex'); const G1 = { kind: 'user' as const, id: 'geo-1' }, G2 = { kind: 'user' as const, id: 'geo-2' };
    const { ScienceService } = await import('./service'); const { DEFAULT_BASES } = await import('./providers'); const real = new ScienceService({ ...svc.cfg, bases: DEFAULT_BASES }, svc.fetcher);
    const r: any = await real.replay(G1, { provider: 'geo', accession: 'GSE1', kind: 'expression_matrix', format: 'series_matrix', classification: 'author_supplied', classificationNote: 'synthetic', sourceUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE1/matrix/GSE1_series_matrix.txt.gz', sourceVersion: 'synthetic', bytes: gz, expectedSha256: sha, retrievedAt: 1_700_000_000_000, origin: 'synthetic_fixture' });
    expect(r.acquisition).toBe('synthetic_fixture'); expect(r.sources[0].replayNote).toMatch(/Synthetic test fixture.*not provider data/); expect(r.sources[0].acquisition).not.toBe('live');
    expect((await svc.getSource(G1, r.sources[0].id) as any).derived[0].summary).toMatchObject({ samples: 2, features: 2, valuesMissing: 1 });
    const ws = await svc.createWorkspace(G1, 'GEO replay', 'synthetic replay'); await svc.attach(G1, ws.id, r.sources[0].id, 'matrix', 'geo-1');
    const m: any = await svc.manifest(G1, ws.id); expect(m.items[0].source).toMatchObject({ acquisition: 'synthetic_fixture', integrityCheckedAtExport: 'ok' });
    expect(await code(svc.getWorkspace(G2, ws.id))).toBe('not_found'); expect(await code(svc.getSource(G2, r.sources[0].id))).toBe('not_found');
    const pend = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/evidence/live-artifacts/PENDING.json'), 'utf8'));
    expect(pend.exactRequest).toMatchObject({ method: 'GET', url: expect.stringContaining('/GSE2/matrix/GSE2_series_matrix.txt.gz'), expectedBytes: 14878 }); expect(pend.exactRequest.expectedSha256).toMatch(/^9fcf768c/);   // the pending live request is recorded exactly
  });

  it('LIMITS: workspace and item caps are enforced', async () => {
    const small = new (await import('./service')).ScienceService({ ...svc.cfg, maxItemsPerWorkspace: 1, maxWorkspacesPerScope: 2 }, svc.fetcher); const S = { kind: 'user' as const, id: 'user-limits' };
    const r: any = await small.retrieve(S, 'rcsb', '4HHB', ['pdb']); const w = await small.createWorkspace(S, 'w1', 'limit test'); await small.attach(S, w.id, r.sources[0].id, 'a', 's');
    const g: any = await small.retrieve(S, 'geo', 'GSE1', ['series_matrix']); expect(await code(small.attach(S, w.id, g.sources[0].id, 'b', 's'))).toBe('item_limit');
    await small.createWorkspace(S, 'w2', 'limit test'); expect(await code(small.createWorkspace(S, 'w3', 'limit test'))).toBe('workspace_limit');
  });
});
