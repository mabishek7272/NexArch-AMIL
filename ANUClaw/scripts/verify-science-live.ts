/**
 * BOUNDED LIVE check of the public-data connectors against the real providers (read-only, public reference records only).
 *
 * Hard limits for this run (enforced by the fetcher's ledger, not by good intentions): ≤ 20 files and ≤ 100 MiB of NEW downloads in
 * total (every response — including errors and retries — is counted as a file; HEAD requests are counted as requests, not files).
 * Disk space is checked first. No accounts, no API keys, no agreements, no controlled-access data, no bulk datasets.
 * Uses a throw-away PostgreSQL database (ANUCLAW_TEST_PG_URL) and a throw-away file store; writes docs/evidence/science-live-*.json.
 *
 *   ANUCLAW_TEST_PG_URL=… npx tsx scripts/verify-science-live.ts
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const MAX_FILES = 20, MAX_BYTES = 100 * 1024 * 1024, MIN_FREE = 2 * 1024 ** 3;
// --continue          keep the existing ledger (limits are for the WHOLE milestone) and write *-run2 result files
// --steps=ncbi,geo    run only some steps;  --gse=GSE2  use this series instead of searching
const ARGS = process.argv.slice(2); const CONTINUE = ARGS.includes('--continue'); const ONLY = (ARGS.find((a) => a.startsWith('--steps='))?.slice(8) ?? '').split(',').filter(Boolean); const FIXED_GSE = ARGS.find((a) => a.startsWith('--gse='))?.slice(6);
const want = (k: string) => !ONLY.length || ONLY.includes(k); const SUFFIX = CONTINUE ? '-run2' : '';
async function main() {
  const pgUrl = process.env.ANUCLAW_TEST_PG_URL; if (!pgUrl) { console.error('ANUCLAW_TEST_PG_URL (disposable server) is required.'); process.exit(2); }
  const free = fs.statfsSync(os.tmpdir()).bavail * fs.statfsSync(os.tmpdir()).bsize;
  console.log(`free disk: ${(free / 1024 ** 3).toFixed(1)} GiB (need ≥ ${(MIN_FREE / 1024 ** 3).toFixed(0)} GiB)`); if (free < MIN_FREE) { console.error('Not enough free disk space; aborting before any download.'); process.exit(3); }
  const evDir = path.resolve('docs/evidence'); fs.mkdirSync(evDir, { recursive: true });
  const ledgerPath = path.join(evDir, 'science-live-ledger.json'); if (!CONTINUE || !fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, JSON.stringify({ files: 0, bytes: 0, requests: 0, log: [] }));
  const dbName = `anuclaw_live_${crypto.randomBytes(5).toString('hex')}`; const u = new URL(pgUrl);
  const admin = new Client({ connectionString: pgUrl }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
  Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, ANUCLAW_SCIDATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scidata-live-')) });
  delete process.env.ANUCLAW_SCIDATA_BASE_OVERRIDES;
  const results: Record<string, unknown> = { ranAt: new Date().toISOString(), limits: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES }, label: 'LIVE retrieval of public reference records. A successful download validates nothing about any model, analysis or clinical use.', steps: [] as unknown[] };
  const steps = results.steps as Array<Record<string, unknown>>;
  try {
    await (await import('../src/db/connection')).ensureDbReady();
    const { ScienceService } = await import('../src/sciencedata/service'); const { LiveBudget } = await import('../src/sciencedata/fetcher');
    const svc = ScienceService.create(process.env, new LiveBudget(ledgerPath, { maxFiles: MAX_FILES, maxBytes: MAX_BYTES }));
    const scope = { kind: 'user' as const, id: 'live-check' };
    const step = async (name: string, fn: () => Promise<Record<string, unknown>>) => {
      const t = Date.now(); try { const r = await fn(); const probs = (r as any).problems?.length ?? 0; steps.push({ name, ok: probs === 0, ms: Date.now() - t, ...r }); if (probs) { console.log(`  PARTIAL ${name}: ${JSON.stringify((r as any).problems).slice(0, 200)}`); return; } console.log(`  ok    ${name}`); } catch (e: any) { steps.push({ name, ok: false, ms: Date.now() - t, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 300) }); console.log(`  FAIL  ${name}: ${e?.code ?? ''} ${String(e?.message ?? e).slice(0, 160)}`); }
    };
    const summarise = (r: any) => ({ record: r.record, problems: r.problems, sources: r.sources.map((s: any) => ({ id: s.id, kind: s.kind, format: s.format, memberPath: s.memberPath, classification: s.classification, sourceVersion: s.sourceVersion, sha256: s.sha256, bytes: s.bytes, sourceUrl: s.sourceUrl, license: s.license, retrievedAt: new Date(s.retrievedAt).toISOString() })) });
    const derived = async (r: any, pick: (s: any) => boolean) => { const s = r.sources.find(pick); return s ? { derived: (await svc.getSource(scope, s.id)).derived.map((d) => ({ parser: d.parser, status: d.status, summary: d.summary })) } : {}; };

    if (want('af')) await step('AlphaFold DB: P69905 (human hemoglobin alpha) — existing prediction, PDB file', async () => { const r: any = await svc.retrieve(scope, 'alphafold', 'P69905', ['pdb']); return { ...summarise(r), ...(await derived(r, (s) => s.format === 'pdb')) }; });
    if (want('rcsb')) await step('RCSB PDB: 4HHB (human deoxyhaemoglobin, experimental) — entry + PDB file', async () => { const r: any = await svc.retrieve(scope, 'rcsb', '4HHB', ['pdb']); return { ...summarise(r), ...(await derived(r, (s) => s.format === 'pdb')) }; });
    if (want('rcsb')) await step('RCSB PDB: full-text search "hemoglobin"', async () => { const r: any = await svc.search(scope, 'rcsb', 'hemoglobin'); return { results: r.results.slice(0, 5) }; });
    if (want('ncbi')) await step('NCBI Datasets: GCF_000819615.1 (phage phiX174 RefSeq, ~5.4 kb) — FASTA + GFF3', async () => { const r: any = await svc.retrieve(scope, 'ncbi_datasets', 'GCF_000819615.1', ['genome_zip']); return { ...summarise(r), ...(await derived(r, (s) => s.format === 'fasta')) }; });
    let gse: string | null = FIXED_GSE ?? null;
    if (want('geo') && !gse) await step('GEO: search small open expression series', async () => { const r: any = await svc.search(scope, 'geo', 'yeast cell cycle'); gse = (r.results as any[]).find((x) => (x.samples ?? 99) <= 12)?.accession ?? r.results[0]?.accession ?? null; return { results: r.results, chosen: gse }; });
    if (want('geo') && gse) {
      await step(`GEO: describe ${gse}`, async () => { const d: any = await svc.describe(scope, 'geo', gse); return { title: d.title, classification: d.classification, files: d.files.map((f: any) => ({ key: f.key, sizeKnownBytes: f.sizeKnownBytes })), refused: d.refused ?? [], warnings: d.warnings }; });
      await step(`GEO: retrieve ${gse} series matrix (only if within the size cap)`, async () => { const r: any = await svc.retrieve(scope, 'geo', gse, ['series_matrix']); return { ...summarise(r), ...(await derived(r, (s) => s.format === 'series_matrix')) }; });
    }
    // workspace + manifest over what was really retrieved
    await step('workspace: attach all retrieved sources and export the manifest', async () => {
      const ws = await svc.createWorkspace(scope, 'Live check', 'bounded live verification of public connectors');
      const ids = (await (await import('../src/db')).db.query<any>('SELECT s.id FROM sci_sources s JOIN sci_retrievals v ON v.source_id = s.id WHERE v.scope_id = $1 AND s.kind <> \'record_metadata\'', [scope.id])).map((r) => r.id);
      for (const id of ids) await svc.attach(scope, ws.id, id, undefined, 'live-check');
      const m: any = await svc.manifest(scope, ws.id);
      fs.writeFileSync(path.join(evDir, `science-live-manifest${SUFFIX}.json`), JSON.stringify(m, null, 1));
      return { items: m.items.length, manifestSha256: m.manifestSha256, allIntegrityOk: m.items.every((i: any) => i.source.integrityCheckedAtExport === 'ok') };
    });
  } finally {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); results.ledger = { files: ledger.files, bytes: ledger.bytes, requests: ledger.requests, withinLimits: ledger.files <= MAX_FILES && ledger.bytes <= MAX_BYTES, urls: ledger.log };
    const ok = steps.filter((s) => s.ok).length; results.summary = { steps: steps.length, ok, failed: steps.length - ok };
    fs.writeFileSync(path.join(evDir, `science-live-results${SUFFIX}.json`), JSON.stringify(results, null, 1));
    try { (await import('../src/db/connection')).getDb().end(); } catch { /* ignore */ }
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end();
    console.log(`\nledger: ${ledger.files} files, ${ledger.bytes} bytes, ${ledger.requests} requests (limits ${MAX_FILES} files / ${MAX_BYTES} bytes)`);
    console.log(`${ok}/${steps.length} steps ok → docs/evidence/science-live-results${SUFFIX}.json`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
