/**
 * OFFLINE replay of an artifact that was fetched live earlier: no provider request is made, the live-download ledger is not touched.
 * The bytes must hash to the SHA-256 recorded at the live fetch or NOTHING is stored. The stored source is labelled `replay_of_live_artifact`.
 *
 *   ANUCLAW_TEST_PG_URL=… npx tsx scripts/replay-science-artifact.ts --provenance docs/evidence/live-artifacts/PROVENANCE.json --file docs/evidence/live-artifacts/rcsb-4HHB.pdb
 *   ANUCLAW_TEST_PG_URL=… npx tsx scripts/replay-science-artifact.ts --pending docs/evidence/live-artifacts/PENDING.json --file /path/to/GSE2_series_matrix.txt.gz
 *
 * Uses a throw-away PostgreSQL database and file store, replays, attaches to a workspace, exports the manifest to docs/evidence/ and cleans up.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
async function main() {
  const pgUrl = process.env.ANUCLAW_TEST_PG_URL; if (!pgUrl) { console.error('ANUCLAW_TEST_PG_URL (disposable server) is required.'); process.exit(2); }
  const file = arg('file'); if (!file) { console.error('--file is required'); process.exit(2); }
  const bytes = fs.readFileSync(path.resolve(file)); const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  let entry: any;
  if (arg('pending')) entry = JSON.parse(fs.readFileSync(path.resolve(arg('pending')!), 'utf8')).entry;
  else { const prov = JSON.parse(fs.readFileSync(path.resolve(arg('provenance') ?? 'docs/evidence/live-artifacts/PROVENANCE.json'), 'utf8')).artifacts; entry = prov.find((a: any) => a.sha256 === sha); if (!entry) { console.error(`No provenance record has sha256 ${sha.slice(0, 12)}…; refusing to replay unrecorded bytes.`); process.exit(3); } }
  const dbName = `anuclaw_replay_${crypto.randomBytes(5).toString('hex')}`; const u = new URL(pgUrl);
  const admin = new Client({ connectionString: pgUrl }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
  Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, ANUCLAW_SCIDATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scidata-replay-')) });
  try {
    await (await import('../src/db/connection')).ensureDbReady();
    const { ScienceService } = await import('../src/sciencedata/service'); const svc = ScienceService.create(process.env);
    const scope = { kind: 'user' as const, id: 'replay' };
    const provider = entry.provider ?? (entry.sourceUrl.includes('alphafold') ? 'alphafold' : entry.sourceUrl.includes('rcsb') ? 'rcsb' : entry.sourceUrl.includes('geo') ? 'geo' : 'ncbi_datasets');
    const accession = entry.accession ?? (entry.sourceUrl.match(/AF-([A-Z0-9]+)-F1/)?.[1] ?? entry.sourceUrl.match(/\/(\d[A-Z0-9]{3})\.pdb/i)?.[1] ?? entry.sourceUrl.match(/(GC[AF]_\d+\.\d+)/)?.[1]);
    const r = await svc.replay(scope, { provider, accession, kind: entry.kind, format: entry.format, classification: entry.classification, classificationNote: entry.classificationNote ?? 'See the live-fetch record.', sourceUrl: entry.sourceUrl, sourceVersion: entry.sourceVersion, bytes, expectedSha256: entry.sha256, retrievedAt: Date.parse(entry.retrievedAt), origin: 'live_artifact', ledgerRef: entry.ledgerRef ?? 'docs/evidence/science-live-results*.json', archive: entry.format === 'zip' });
    const ws = await svc.createWorkspace(scope, 'Replay', 'end-to-end replay of a live-fetched artifact'); for (const s of r.sources) await svc.attach(scope, ws.id, s.id, undefined, 'replay');
    const m = await svc.manifest(scope, ws.id); const out = path.resolve('docs/evidence', `science-replay-manifest-${provider}-${accession}.json`); fs.writeFileSync(out, JSON.stringify(m, null, 1));
    console.log(`replayed ${r.sources.length} source(s) as ${r.acquisition}; manifest → ${out}; integrity ${m.items.every((i: any) => i.source.integrityCheckedAtExport === 'ok') ? 'ok' : 'FAILED'}`);
  } finally {
    try { (await import('../src/db/connection')).getDb().end(); } catch { /* ignore */ }
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end();
  }
}
main().catch((e) => { console.error(e.code ?? '', e.message ?? e); process.exit(1); });
