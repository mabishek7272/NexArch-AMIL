/**
 * Authenticated OCR-study API tests (real PostgreSQL, real dashboard sessions, SYNTHETIC data only).
 * Opt-in: ANUCLAW_TEST_PG_URL=postgres://… npx vitest run src/validation/study/study-api-pg.test.ts
 * "Authorizers" in these tests are test accounts created in a throw-away database; none is a real person or approval.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const FX = path.resolve(__dirname, '../../../validation/fixtures/ocr-study');
const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const NOTICE_RE = /Study tooling only/;

describe.skipIf(!URL_)('OCR study API (real PostgreSQL)', () => {
  const dbName = `anuclaw_study_${crypto.randomBytes(6).toString('hex')}`; const studyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrapi-'));
  let admin: Client; let server: Server; let base: string; let q: (s: string, p?: unknown[]) => Promise<any[]>; let resetRates: () => void;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {}; const email = (k: string) => `${k}@study-synthetic.invalid`;
  const USERS: Array<[string, string]> = [['owner', 'operator'], ['owner2', 'operator'], ['custodian', 'operator'], ['custodian2', 'operator'], ['annA', 'operator'], ['annB', 'operator'], ['annC', 'operator'], ['adj', 'clinician'], ['stat', 'operator'], ['lead', 'clinician'], ['auditor', 'auditor'], ['outsider', 'operator'], ['viewer', 'viewer']];

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANUCLAW_STUDY_STORAGE: 'local_synthetic', ANUCLAW_STUDY_LOCAL_ROOT: studyRoot });
    delete process.env.NODE_ENV; vi.resetModules(); await (await import('../../db/connection')).ensureDbReady(); const { db } = await import('../../db'); q = (s, p) => db.query(s, p as any[]);
    resetRates = (await import('../../dashboard/server/ocr-study-security')).resetRateLimits; const auth = await import('../../dashboard/server/auth');
    for (const [k, role] of USERS) { const id = crypto.randomUUID(); ids[k] = id; await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, email(k), role]); cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`; }
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express(); app.use(cookieParser()); app.use(express.json({ limit: '4mb' }));
    app.use('/api/ocr-study', (await import('../../dashboard/server/routes/ocr-study')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ocr-study`;
  }, 90_000);
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r())); try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
    fs.rmSync(studyRoot, { recursive: true, force: true });
  });

  const call = async (who: string | null, method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, headers: r.headers };
  };
  const mapIds = (f: any, caseIds: string[]) => { const m = (k: string) => caseIds[Number(k.slice(1)) - 1]; return { ...f, completedCaseIds: f.completedCaseIds.map(m), items: f.items.map((i: any) => ({ ...i, caseId: m(i.caseId) })) }; };
  /** An annotation upload never names the annotator: the server uses the signed-in user. */
  const annFile = (f: any, caseIds: string[]) => { const { annotatorId, ...rest } = mapIds(f, caseIds); void annotatorId; return rest; };
  const results = (caseIds: string[], stamp?: unknown) => { const r = rd('results.json'); return { ...r, ...(stamp ? { policy: stamp } : {}), documents: r.documents.map((d: any) => ({ ...d, documentId: caseIds[Number(d.documentId.slice(1)) - 1] })) }; };
  const sources = () => JSON.parse(fs.readFileSync(path.join(FX, 'sources.json'), 'utf8')).map((s: any) => ({ contentBase64: fs.readFileSync(path.join(FX, s.file)).toString('base64'), pages: s.pages, mediaType: s.mediaType }));

  type Stage = 'members' | 'dataset' | 'manifest' | 'annotated' | 'adjudicated' | 'truth' | 'locked';
  const ORDER: Stage[] = ['members', 'dataset', 'manifest', 'annotated', 'adjudicated', 'truth', 'locked'];
  interface S { ws: string; ds: string; caseIds: string[]; digest: string; dsDir: string; stamp?: unknown }
  async function study(stage: Stage, split: 'development' | 'locked_validation' = 'locked_validation'): Promise<S> {
    resetRates(); const at = (s: Stage) => ORDER.indexOf(stage) >= ORDER.indexOf(s);
    const ws = (await call('owner', 'POST', '/studies', { name: 'Synthetic OCR study', purpose: 'API tests (synthetic)' })).json.id as string;
    for (const [k, r] of [['custodian', 'dataset_custodian'], ['custodian2', 'dataset_custodian'], ['annA', 'annotator'], ['annB', 'annotator'], ['annC', 'annotator'], ['adj', 'adjudicator'], ['stat', 'statistician'], ['lead', 'clinical_lead'], ['auditor', 'auditor']]) expect((await call('owner', 'POST', `/studies/${ws}/members`, { memberEmail: email(k), studyRole: r })).status).toBe(201);
    const s: S = { ws, ds: '', caseIds: [], digest: '', dsDir: '' }; if (!at('dataset')) return s;
    const reg = await call('custodian', 'POST', `/studies/${ws}/datasets`, { name: 'synthetic', studyRef: 'SYNTHETIC-STUDY', provenanceKind: 'synthetic_fixture', split, origin: 'synthetic fixture', annotatorEmails: [email('annA'), email('annB')], sources: sources() });
    expect(reg.status).toBe(201); s.ds = reg.json.datasetId; s.caseIds = reg.json.caseIds; if (!at('manifest')) return s;
    expect((await call('custodian', 'POST', `/studies/${ws}/datasets/${s.ds}/manifest`)).status).toBe(409);                                                     // no attestation yet
    expect((await call('custodian', 'POST', `/studies/${ws}/datasets/${s.ds}/attestation`, { record: rd('attestation.synthetic.json') })).status).toBe(201);
    expect((await call('custodian', 'POST', `/studies/${ws}/datasets/${s.ds}/manifest`)).status).toBe(201);
    s.dsDir = locate(ws, s.ds); if (!at('annotated')) return s;
    { const r = await call('annA', 'POST', `/studies/${ws}/datasets/${s.ds}/annotations`, { file: annFile(rd('annotator-a.json'), s.caseIds) }); expect([r.status, r.json]).toEqual([201, expect.anything()]); };
    expect((await call('annB', 'POST', `/studies/${ws}/datasets/${s.ds}/annotations`, { file: annFile(rd('annotator-b.json'), s.caseIds) })).status).toBe(201); if (!at('adjudicated')) return s;
    const queue = (await call('adj', 'GET', `/studies/${ws}/datasets/${s.ds}/queue`)).json.queue as any[];
    for (const d of queue) expect((await call('adj', 'POST', `/studies/${ws}/datasets/${s.ds}/adjudications`, { queueId: d.id, source: d.field === 'presence' ? 'B' : 'A', reason: 'synthetic reasoning text ZEBRA-REASON' })).status).toBe(201);
    if (!at('truth')) return s; expect((await call('custodian', 'POST', `/studies/${ws}/datasets/${s.ds}/truth`)).status).toBe(201); s.stamp = (await call('stat', 'GET', `/studies/${ws}/policy?kind=synthetic_test`)).json.stamp; if (!at('locked')) return s;
    const lk = await call('custodian', 'POST', `/studies/${ws}/datasets/${s.ds}/lock`); expect(lk.status).toBe(201); s.digest = lk.json.lockDigest; s.stamp = (await call('stat', 'GET', `/studies/${ws}/policy?kind=synthetic_test`)).json.stamp; return s;
  }
  const locate = (ws: string, ds: string): string => { const hit = (fs.readdirSync(studyRoot, { recursive: true } as any) as string[]).map(String).find((x) => x.endsWith(`${path.sep}${ws}${path.sep}datasets${path.sep}${ds}`)); return path.join(studyRoot, hit!); };
  const P = (s: S, rest = '') => `/studies/${s.ws}/datasets/${s.ds}${rest}`;

  it('every response and header carries the study-tooling notice; unauthenticated and viewer accounts are refused', async () => {
    const o = await call('owner', 'GET', '/'); expect(o.status).toBe(200); expect(o.json.notice).toMatch(NOTICE_RE); expect(o.headers.get('x-study-tooling-notice')).toMatch(NOTICE_RE);
    expect(o.json.storage).toMatchObject({ ready: true, kind: 'local_synthetic', syntheticOnly: true }); expect(Object.keys(o.json.permissions)).toContain('adjudicate');
    expect((await call(null, 'GET', '/')).status).toBe(401); expect((await call('viewer', 'GET', '/')).status).toBe(403);
    const s = await study('members'); const view = await call('owner', 'GET', `/studies/${s.ws}`); expect(view.json.notice).toMatch(NOTICE_RE); expect(view.json.members).toHaveLength(10);
    expect((await call('owner', 'POST', `/studies/${s.ws}/members`, { memberEmail: email('annA'), studyRole: 'adjudicator' })).status).toBe(409);               // one role per user
    expect((await call('owner', 'POST', `/studies/${s.ws}/members`, { memberEmail: email('viewer'), studyRole: 'auditor' })).status).toBe(404);                // viewer accounts cannot join
  }, 60_000);

  it('identity, tenant, role and lock state are never accepted from a request body', async () => {
    for (const bad of [{ userId: ids.owner }, { tenantId: 'dashboard:other' }, { role: 'study_owner' }, { lockState: 'open' }, { actorId: ids.owner }]) {
      const r = await call('owner', 'POST', '/studies', { name: 'x', purpose: 'y', ...bad }); expect(r.status).toBe(400); expect(r.json.code).toBe('forbidden_field');
    }
    const s = await study('manifest'); const r = await call('custodian', 'POST', P(s, '/unlock-requests'), { reason: 'x', lockState: 'open' }); expect(r.json.code).toBe('forbidden_field');
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'r1', mode: 'development', results: {}, options: { role: 'x' } })).json.code).toBe('forbidden_field');
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'r1', mode: 'development', results: {}, options: { severityMap: { value: 'critical' } } })).status).toBe(400);   // severity comes from the study, not the body
  }, 60_000);

  it('cross-tenant and non-member access is "not found" everywhere, and every refusal is audited', async () => {
    const s = await study('annotated'); const other = (await call('owner2', 'POST', '/studies', { name: 'Other tenant study', purpose: 'isolation' })).json.id;
    const targets: Array<[string, string]> = [['GET', `/studies/${s.ws}`], ['GET', P(s, '/manifest')], ['GET', P(s, '/queue')], ['GET', P(s, '/cases')], ['GET', P(s, `/cases/${s.caseIds[0]}/source`)], ['GET', `/studies/${s.ws}/audit`], ['POST', P(s, '/lock')], ['POST', `/studies/${s.ws}/members`], ['POST', P(s, '/evaluations')], ['POST', `/studies/${s.ws}/acceptance`]];
    for (const who of ['outsider', 'owner2']) for (const [m, p] of targets) { const r = await call(who, m, p, m === 'POST' ? { x: 1 } : undefined); expect([m, p, r.status]).toEqual([m, p, 404]); }
    expect((await call('owner', 'GET', `/studies/${other}`)).status).toBe(404);                                                                                      // and the reverse
    expect((await call('owner', 'GET', '/studies/w-000000000000')).status).toBe(404);
    const denied = await q(`SELECT actor_id, meta FROM audit_events WHERE action = 'ocr_study.denied' AND actor_id = $1`, [ids.outsider]); expect(denied.length).toBeGreaterThanOrEqual(targets.length);
    expect(JSON.stringify(denied)).not.toMatch(/Sodium|SYNTHETIC FIXTURE/);
  }, 90_000);

  it('least privilege: each role is refused what it should not do', async () => {
    const s = await study('locked'); const refused = (who: string, m: string, p: string, body?: unknown) => call(who, m, p, body).then((r) => [who, m, p.replace(s.ws, 'W').replace(s.ds, 'D'), r.status]);
    const cases: Array<[string, string, string, unknown?]> = [
      ['annA', 'GET', P(s, '/manifest')], ['annA', 'GET', P(s, '/queue')], ['annA', 'GET', P(s, '/agreement')], ['annA', 'GET', P(s, '/adjudications')], ['annA', 'GET', `/studies/${s.ws}/audit`], ['annA', 'POST', P(s, '/lock')], ['annA', 'POST', P(s, '/evaluations'), { mode: 'development' }],
      ['adj', 'POST', P(s, '/annotations'), { file: {} }], ['adj', 'POST', `/studies/${s.ws}/datasets`, {}], ['adj', 'POST', P(s, '/lock')], ['adj', 'GET', P(s, '/manifest')], ['adj', 'POST', P(s, '/evaluations'), { mode: 'development' }],
      ['stat', 'POST', P(s, '/adjudications'), {}], ['stat', 'POST', P(s, '/lock')], ['stat', 'GET', P(s, '/queue')], ['stat', 'POST', P(s, '/unlock-requests'), { reason: 'x' }],
      ['lead', 'POST', P(s, '/evaluations'), { mode: 'development' }], ['lead', 'POST', P(s, '/lock')], ['lead', 'POST', P(s, '/annotations'), { file: {} }],
      ['custodian', 'POST', P(s, '/evaluations'), { mode: 'development' }], ['custodian', 'GET', P(s, '/queue')], ['custodian', 'GET', P(s, '/agreement')], ['custodian', 'POST', P(s, '/adjudications'), {}], ['custodian', 'GET', `/studies/${s.ws}/audit`],
      ['auditor', 'POST', P(s, '/adjudications'), {}], ['auditor', 'POST', P(s, '/annotations'), { file: {} }], ['auditor', 'POST', P(s, '/lock')], ['auditor', 'GET', P(s, '/queue')], ['auditor', 'POST', `/studies/${s.ws}/members`, { memberEmail: email('viewer'), studyRole: 'auditor' }],
      ['owner', 'POST', P(s, '/lock')], ['owner', 'POST', P(s, '/adjudications'), {}], ['owner', 'GET', P(s, '/queue')], ['owner', 'POST', P(s, '/evaluations'), { mode: 'development' }],
    ];
    for (const [who, m, p, b] of cases) expect(await refused(who, m, p, b)).toEqual([who, m, p.replace(s.ws, 'W').replace(s.ds, 'D'), 403]);
    for (const [who, m, p] of [['auditor', 'GET', P(s, '/manifest')], ['auditor', 'GET', `/studies/${s.ws}/audit`], ['owner', 'GET', `/studies/${s.ws}/audit`], ['stat', 'GET', P(s, '/agreement')], ['lead', 'GET', P(s, '/agreement')]] as const) expect((await call(who, m, p)).status).toBe(200);
  }, 90_000);

  it('annotators are blind: only their own work, only their assigned datasets; item-level disagreements go to adjudicators only', async () => {
    const s = await study('annotated'); const mineA = await call('annA', 'GET', P(s, '/my-annotations')); const mineB = await call('annB', 'GET', P(s, '/my-annotations'));
    expect(mineA.status).toBe(200); expect(mineA.json.versions).toHaveLength(1); expect(mineA.json.latest.annotatorId).toBe(ids.annA);
    expect(mineA.text).not.toMatch(/Urea|4\.1/); expect(mineB.text).toMatch(/Urea/);                                                                          // A never sees B's extra item or B's value
    expect(JSON.stringify(mineA.json)).not.toContain(ids.annB);
    expect((await call('annC', 'GET', P(s, '/cases'))).status).toBe(403); expect((await call('annC', 'GET', P(s, `/cases/${s.caseIds[0]}/source`))).status).toBe(403); expect((await call('annC', 'GET', P(s, '/my-annotations'))).status).toBe(403);   // not assigned
    expect((await call('annC', 'POST', P(s, '/annotations'), { file: annFile(rd('annotator-a.json'), s.caseIds) })).status).toBe(403);
    const impersonate = mapIds(rd('annotator-b.json'), s.caseIds); expect((await call('annA', 'POST', P(s, '/annotations'), { file: { ...impersonate, annotatorId: ids.annB } })).json.code).toBe('forbidden_field');   // cannot import as B
    const srcOk = await call('annA', 'GET', P(s, `/cases/${s.caseIds[0]}/source`)); expect(srcOk.status).toBe(200); expect(srcOk.text).toMatch(/SYNTHETIC FIXTURE 1/);
    const ds = await call('annA', 'GET', `/studies/${s.ws}`); expect(ds.json.datasets).toHaveLength(1); expect(ds.json.datasets[0].annotators).toBeUndefined(); expect(ds.json.members).toHaveLength(1);
    const summary = await call('stat', 'GET', P(s, '/agreement')); expect(summary.status).toBe(200); expect(summary.text).not.toMatch(/"disagreements"|Urea/); expect(summary.json.queue.open).toBeGreaterThan(0);
    const queue = await call('adj', 'GET', P(s, '/queue')); expect(queue.status).toBe(200); expect(queue.text).not.toContain(ids.annA); expect(queue.text).not.toContain(ids.annB); expect(queue.json.queue.length).toBe(summary.json.queue.open);
  }, 90_000);

  it('adjudicators cannot alter original annotations; both originals are preserved and the record chain verifies', async () => {
    const s = await study('annotated'); const fileHash = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const files = [path.join(s.dsDir, 'annotations', ids.annA, 'v1.json'), path.join(s.dsDir, 'annotations', ids.annB, 'v1.json')]; const before = files.map(fileHash);
    expect((await call('adj', 'POST', P(s, '/annotations'), { file: annFile(rd('annotator-a.json'), s.caseIds) })).status).toBe(403);
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect((await call('adj', m, P(s, '/annotations'), {})).status).toBe(404);                                       // no route exists to modify annotations
    for (const d of (await call('adj', 'GET', P(s, '/queue'))).json.queue) expect((await call('adj', 'POST', P(s, '/adjudications'), { queueId: d.id, source: d.field === 'presence' ? 'other' : 'B', finalValue: d.field === 'presence' ? 'exclude' : undefined, reason: 'synthetic' })).status).toBe(201);
    expect(files.map(fileHash)).toEqual(before);                                                                                                                  // originals untouched
    const recs = (await call('adj', 'GET', P(s, '/adjudications'))).json.records; const val = recs.find((r: any) => r.field === 'valueRaw'); expect(val.original).toMatchObject({ A: '4.7', B: '4.1' }); expect(val.decision.source).toBe('b');
    expect((await call('adj', 'POST', P(s, '/adjudications'), { queueId: val.queueId, source: 'A', reason: 'again' })).status).toBe(409);
    expect((await call('stat', 'POST', P(s, '/verify'), {})).json).toMatchObject({ ok: true });
    expect((await call('adj', 'POST', P(s, '/adjudications'), { queueId: 'nope', source: 'A', reason: 'x' })).status).toBe(404);
  }, 90_000);

  it('clinical lead configures severity labels but cannot accept a study; the labels flow into reports from the server-side map', async () => {
    const s = await study('truth', 'development');
    expect((await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'high-priority-label', bogus: 'x' } })).status).toBe(400);
    expect((await call('stat', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'x' } })).status).toBe(403);
    expect((await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'review-first' } })).status).toBe(200);
    for (const who of ['lead', 'owner', 'stat', 'custodian', 'adj', 'auditor']) { const r = await call(who, 'POST', `/studies/${s.ws}/acceptance`, {}); expect([who, r.status, r.json.code]).toEqual([who, 403, 'acceptance_not_available']); }
    expect((await call('lead', 'POST', `/studies/${s.ws}/acceptance`, { accepted: true })).json.code).toBe('forbidden_field');                                   // not even as a body flag
    const drift = await call('stat', 'POST', P(s, '/evaluations'), { runId: 'dev0', mode: 'development', results: results(s.caseIds, s.stamp) }); expect([drift.status, drift.json.code]).toEqual([409, 'policy_version_drift']);   // results stamped with the version from BEFORE the severity edit
    const fresh = (await call('stat', 'GET', `/studies/${s.ws}/policy?kind=synthetic_test`)).json.stamp; expect(fresh.version).toBeGreaterThan((s.stamp as { version: number }).version);
    const ev = await call('stat', 'POST', P(s, '/evaluations'), { runId: 'dev1', mode: 'development', results: results(s.caseIds, fresh) }); expect(ev.status).toBe(201); expect(ev.json.report.provenance.policy).toMatchObject({ version: fresh.version, sha256: fresh.sha256, kind: 'synthetic_test' });
    expect(ev.json.report.errorTypes.counts.unit.severity).toBe('review-first'); expect(ev.json.report.clinicalAcceptance.status).toBe('not_assessed_by_this_tool'); expect(ev.json.report.studyToolingNotice).toMatch(NOTICE_RE);
    expect((await call('owner', 'GET', `/studies/${s.ws}`)).json.severityMap).toMatchObject({ unit: 'review-first' });
  }, 90_000);

  it('manifest tampering is detected; a locked dataset can only be verified against an externally supplied lock digest', async () => {
    const s = await study('locked'); expect((await call('stat', 'POST', P(s, '/verify'), {})).json.code).toBe('expected_lock_digest_required');
    const v = await call('stat', 'POST', P(s, '/verify'), { expectedLockDigest: s.digest }); expect(v.json.ok).toBe(true); expect(v.json.custody).toMatch(/write access to the study directory can rewrite the manifest AND its hashes/);
    expect((await call('stat', 'POST', P(s, '/verify'), { expectedLockDigest: '1'.repeat(64) })).json.problems.join(' ')).toMatch(/externally recorded anchor/);
    expect((await call('stat', 'POST', P(s, '/verify'), { expectedLockDigest: 'nothex' })).status).toBe(400);
    const mp = path.join(s.dsDir, 'manifest.json'); const orig = fs.readFileSync(mp, 'utf8'); fs.writeFileSync(mp, orig.replace('"SYNTHETIC-STUDY"', '"EDITED"'));
    const bad = await call('stat', 'POST', P(s, '/verify'), { expectedLockDigest: s.digest }); expect(bad.json.ok).toBe(false); expect(bad.json.problems.join(' ')).toMatch(/self-hash mismatch/);
    const ev = await call('stat', 'POST', P(s, '/evaluations'), { runId: 'tamper1', mode: 'locked', expectedLockDigest: s.digest, results: results(s.caseIds, s.stamp) }); expect(ev.status).toBe(409); expect(ev.json.code).toBe('integrity');
    fs.writeFileSync(mp, orig); expect((await call('stat', 'POST', P(s, '/verify'), { expectedLockDigest: s.digest })).json.ok).toBe(true);
  }, 90_000);

  it('locked evaluation: development runs on a locked split are refused; the digest is mandatory and checked; export carries the hash and notice', async () => {
    const s = await study('locked');
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'd1', mode: 'development', results: results(s.caseIds, s.stamp) })).json.code).toBe('split_forbidden');
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'l0', mode: 'locked', results: results(s.caseIds, s.stamp) })).json.code).toBe('expected_lock_digest_required');
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'l0', mode: 'locked', expectedLockDigest: '2'.repeat(64), results: results(s.caseIds, s.stamp) })).status).toBe(409);
    const ev = await call('stat', 'POST', P(s, '/evaluations'), { runId: 'l1', mode: 'locked', expectedLockDigest: s.digest, results: results(s.caseIds, s.stamp) }); expect(ev.status).toBe(201);
    expect(ev.json.report.provenance).toMatchObject({ lockState: 'locked', lockDigest: s.digest, pristineLock: true, evaluationsOnThisLockedSet: 1 }); expect(ev.json.report.silentErrors).toHaveLength(1);
    const ex = await call('stat', 'POST', P(s, '/evaluations/l1/export')); expect(ex.status).toBe(200); expect(ex.headers.get('x-report-sha256')).toBe(ev.json.reportSha256); expect(crypto.createHash('sha256').update(ex.text).digest('hex')).toBe(ev.json.reportSha256); expect(ex.json.studyToolingNotice).toMatch(NOTICE_RE);
    expect((await call('annA', 'POST', P(s, '/evaluations/l1/export'))).status).toBe(403); expect((await call('auditor', 'POST', P(s, '/evaluations/l1/export'))).status).toBe(200); expect((await call('stat', 'POST', P(s, '/evaluations/nope/export'))).status).toBe(404);
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'l1', mode: 'locked', expectedLockDigest: s.digest, results: results(s.caseIds, s.stamp) })).json.code).toBe('run_exists');
  }, 90_000);

  it('unlock needs two different authenticated users, a bound single-use authorization, and refuses replay, mismatch and tenant mismatch', async () => {
    const s = await study('locked'); const U = (rest = '') => P(s, `/unlock-requests${rest}`); const authz = { reason: 'synthetic: TEST-ONLY reason', protocolDeviationRef: 'TEST-DEV-1', credentialRef: 'TEST-CRED', roleClaim: 'test role' };
    expect((await call('annA', 'POST', U(), { reason: 'x' })).status).toBe(403); expect((await call('owner', 'POST', U(), { reason: 'x' })).status).toBe(403);                // only the custodian requests
    const req1 = await call('custodian', 'POST', U(), { reason: 'synthetic: need to fix the truth' }); expect(req1.status).toBe(201); const r1 = req1.json.requestId;
    expect((await call('custodian', 'POST', U(), { reason: 'again' })).json.code).toBe('request_open');
    expect((await call('custodian', 'POST', U(`/${r1}/authorize`), authz)).status).toBe(403);                                                                      // the requester cannot authorize (role)
    expect((await call('custodian', 'POST', U(`/${r1}/execute`))).json.code).toBe('not_authorized');
    await q(`UPDATE ocr_study_unlocks SET requested_by = $1 WHERE id = $2`, [ids.owner, r1]); const same = await call('owner', 'POST', U(`/${r1}/authorize`), authz); expect(same.json.code).toBe('authorizer_must_differ');   // requester == authorizer (simulated)
    await q(`UPDATE ocr_study_unlocks SET requested_by = $1 WHERE id = $2`, [ids.custodian, r1]);
    await q(`UPDATE ocr_study_unlocks SET tenant_id = 'dashboard:someone-else' WHERE id = $1`, [r1]); expect((await call('owner', 'POST', U(`/${r1}/authorize`), authz)).json.code).toBe('tenant_mismatch');
    await q(`UPDATE ocr_study_unlocks SET tenant_id = (SELECT tenant_id FROM ocr_study_workspaces WHERE id = $1) WHERE id = $2`, [s.ws, r1]);
    expect((await call('owner', 'POST', U(`/${r1}/authorize`), { ...authz, reason: '' })).status).toBe(400);
    const a1 = await call('owner', 'POST', U(`/${r1}/authorize`), authz); expect(a1.status).toBe(201); expect((await call('owner', 'POST', U(`/${r1}/authorize`), authz)).json.code).toBe('bad_state');
    // manifest mismatch: a locked evaluation changes the manifest after authorization → the authorization no longer matches and is NOT consumed
    expect((await call('stat', 'POST', P(s, '/evaluations'), { runId: 'l1', mode: 'locked', expectedLockDigest: s.digest, results: results(s.caseIds, s.stamp) })).status).toBe(201);
    expect((await call('custodian', 'POST', U(`/${r1}/execute`))).json.code).toBe('authorization_mismatch'); expect((await q(`SELECT status FROM ocr_study_unlocks WHERE id = $1`, [r1]))[0].status).toBe('authorized');
    expect((await call('owner', 'POST', U(`/${r1}/authorize`), authz)).status).toBe(409);
    // fresh request, then tenant mismatch at execution, then success, then replay
    await q(`UPDATE ocr_study_unlocks SET status = 'executed' WHERE id = $1`, [r1]);                                                                                  // retire the stale one so a new request can be made
    const r2 = (await call('custodian', 'POST', U(), { reason: 'synthetic: second request' })).json.requestId; expect((await call('owner', 'POST', U(`/${r2}/authorize`), authz)).status).toBe(201);
    await q(`UPDATE ocr_study_unlocks SET tenant_id = 'dashboard:someone-else' WHERE id = $1`, [r2]); expect((await call('custodian', 'POST', U(`/${r2}/execute`))).json.code).toBe('authorization_mismatch');
    await q(`UPDATE ocr_study_unlocks SET tenant_id = (SELECT tenant_id FROM ocr_study_workspaces WHERE id = $1) WHERE id = $2`, [s.ws, r2]);
    expect((await call('custodian2', 'POST', U(`/${r2}/execute`))).status).toBe(403);                                                                               // only the requester executes
    const done = await call('custodian', 'POST', U(`/${r2}/execute`)); expect(done.status).toBe(200); expect(done.json).toMatchObject({ lockState: 'open', everUnlocked: true, epoch: 1 });
    expect((await call('custodian', 'POST', U(`/${r2}/execute`))).json.code).toBe('authorization_already_used');                                                   // replay
    expect((await call('annA', 'POST', P(s, '/annotations'), { file: annFile(rd('annotator-a.json'), s.caseIds) })).status).toBe(201);                              // open again (a new, immutable annotation version)
    expect((await call('auditor', 'GET', P(s, '/manifest'))).json).toMatchObject({ lockState: 'open', everUnlocked: true });
    const reqs = (await call('auditor', 'GET', U())).json.requests; expect(reqs.map((r: any) => r.status).sort()).toEqual(['executed', 'executed']);
  }, 120_000);

  it('audit entries hold identifiers, hashes and counts only — never document, annotation or free-text content', async () => {
    const s = await study('locked'); await call('stat', 'POST', P(s, '/evaluations'), { runId: 'a1', mode: 'locked', expectedLockDigest: s.digest, results: results(s.caseIds, s.stamp) });
    await call('custodian', 'POST', P(s, '/unlock-requests'), { reason: 'secret reason text QUOKKA-REQUEST' });
    const r = await call('auditor', 'GET', `/studies/${s.ws}/audit`); expect(r.status).toBe(200); expect(r.json.fileStoreChain.ok).toBe(true); const text = r.text;
    expect(text).not.toMatch(/Sodium|Potassium|Creatinine|Glucose|SYNTHETIC FIXTURE|ZEBRA-REASON|QUOKKA|TEST-ONLY|Urea|mmol/i);
    expect(r.json.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ocr_study.dataset_registered', 'ocr_study.annotations_imported', 'ocr_study.adjudicated', 'ocr_study.locked', 'ocr_study.locked_evaluation_run', 'ocr_study.unlock_requested']));
    const adj = r.json.events.find((e: any) => e.action === 'ocr_study.adjudicated'); expect(adj.meta).toHaveProperty('reasonSha256'); expect(adj.meta.reasonLength).toBeGreaterThan(0); expect(JSON.stringify(adj.meta)).not.toMatch(/ZEBRA/);
    const all = await q(`SELECT meta FROM audit_events WHERE target_type = 'ocr_study' AND target_id = $1`, [s.ws]); const SAFE = await import('../../dashboard/server/ocr-study-access');
    for (const row of all) for (const [k, v] of Object.entries(JSON.parse(row.meta ?? '{}'))) { expect(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').toBe(true); expect(String(v)).toMatch(/^[A-Za-z0-9._:@/+=-]{0,200}$/); void k; }
    expect(SAFE.safeMeta({ analyte: 'Sodium', reason: 'free text', datasetId: 'd-1', note: 'x y z' })).toEqual({ datasetId: 'd-1' });                                  // unknown keys and non-token values are dropped
    const fileLog = fs.readFileSync(path.join(path.dirname(path.dirname(s.dsDir)), 'audit.jsonl'), 'utf8'); expect(fileLog).not.toMatch(/Sodium|SYNTHETIC FIXTURE|ZEBRA|QUOKKA/);
    expect((await call('annA', 'GET', `/studies/${s.ws}/audit`)).status).toBe(403); expect((await call('owner', 'GET', `/studies/${s.ws}/audit`)).status).toBe(200);
  }, 120_000);

  it('real data and oversized or odd sources are refused by the synthetic-only adapter', async () => {
    const s = await study('members'); const base = { name: 'x', studyRef: 'S', split: 'development', origin: 'o', annotatorEmails: [email('annA'), email('annB')], sources: sources() };
    expect((await call('custodian', 'POST', `/studies/${s.ws}/datasets`, { ...base, provenanceKind: 'human_annotated' })).json.code).toBe('policy_not_active');
    expect((await call('custodian', 'POST', `/studies/${s.ws}/datasets`, { ...base, provenanceKind: 'synthetic_fixture', sources: [{ contentBase64: Buffer.alloc(1_100_000, 65).toString('base64'), pages: 1, mediaType: 'text/plain' }] })).status).toBe(400);
    expect((await call('custodian', 'POST', `/studies/${s.ws}/datasets`, { ...base, provenanceKind: 'synthetic_fixture', sources: [{ contentBase64: 'QQ==', pages: 1, mediaType: 'application/x-msdownload' }] })).status).toBe(400);
    expect((await call('custodian', 'POST', `/studies/${s.ws}/datasets`, { ...base, provenanceKind: 'synthetic_fixture', annotatorEmails: [email('annA'), email('adj')] })).status).toBe(400);     // an adjudicator cannot be an annotator
    expect((await call('custodian', 'POST', `/studies/${s.ws}/datasets`, { ...base, provenanceKind: 'synthetic_fixture', annotatorEmails: [email('annA'), email('annA')] })).status).toBe(400);
  }, 60_000);

  it('storage fails closed: unconfigured, production-unsafe, incomplete object-store and not-implemented object-store all give 503 and write nothing', async () => {
    const save = { ...process.env }; const before = fs.readdirSync(studyRoot).length;
    const expect503 = async (reasonRe: RegExp) => { const r = await call('owner', 'POST', '/studies', { name: 'n', purpose: 'p' }); expect(r.status).toBe(503); expect(r.json.code).toBe('study_storage_unavailable'); expect(r.json.reasons.join(' ')).toMatch(reasonRe); const g = await call('owner', 'GET', '/'); expect(g.json.storage.ready).toBe(false); expect(g.status).toBe(200); };
    try {
      delete process.env.ANUCLAW_STUDY_STORAGE; await expect503(/ANUCLAW_STUDY_STORAGE is not set/);
      process.env.ANUCLAW_STUDY_STORAGE = 'local_synthetic'; delete process.env.ANUCLAW_STUDY_LOCAL_ROOT; await expect503(/ANUCLAW_STUDY_LOCAL_ROOT must be set/);
      process.env.ANUCLAW_STUDY_LOCAL_ROOT = studyRoot; process.env.NODE_ENV = 'production'; process.env.ANUCLAW_STUDY_REQUIRE_ORIGIN = 'false'; await expect503(/refused in production/); delete process.env.NODE_ENV;
      process.env.ANUCLAW_STUDY_STORAGE = 'object_store'; await expect503(/ANUCLAW_STUDY_OBJECT_STORE_CREDENTIAL_REF is required/);
      Object.assign(process.env, { ANUCLAW_STUDY_OBJECT_STORE: 'x', ANUCLAW_STUDY_OBJECT_STORE_CREDENTIAL_REF: 'secret-ref', ANUCLAW_STUDY_OBJECT_STORE_ENCRYPTION_KEY_REF: 'key-ref', ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS: '365', ANUCLAW_STUDY_OBJECT_STORE_ACCESS_POLICY_REF: 'policy-ref' });
      await expect503(/not_implemented/); process.env.ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS = '0'; await expect503(/positive integer/);
      process.env.ANUCLAW_STUDY_STORAGE = 'something-else'; await expect503(/must be local_synthetic or object_store/);
      const m = await call('owner', 'GET', `/studies/w-000000000000`); expect(m.status).toBe(503);                                                                 // even reads refuse
    } finally { for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k]; Object.assign(process.env, save); }
    expect(fs.readdirSync(studyRoot).length).toBe(before); expect((await call('owner', 'GET', '/')).json.storage.ready).toBe(true);
  }, 60_000);
});

describe('OpenAPI contract for the OCR study API', () => {
  it('every implemented route is documented and every documented operation exists; the spec carries the notice', async () => {
    process.env.DASHBOARD_JWT_SECRET ??= crypto.randomBytes(32).toString('hex');
    const router = (await import('../../dashboard/server/routes/ocr-study')).default as any; const { buildOcrStudyOpenApi, OPS } = await import('./openapi');
    const impl = new Set<string>(); for (const l of router.stack) if (l.route) for (const m of Object.keys(l.route.methods)) impl.add(`${m} ${String(l.route.path).replace(/:(\w+)/g, '{$1}')}`);
    const doc = new Set(OPS.map((o) => `${o.method} ${o.path}`)); expect([...impl].sort()).toEqual([...doc].sort());
    const spec = buildOcrStudyOpenApi(); expect(spec.info.description).toMatch(NOTICE_RE); expect(Object.keys(spec.paths).length).toBeGreaterThan(15);
    for (const p of Object.values(spec.paths)) for (const op of Object.values(p as Record<string, any>)) expect(op.description).toMatch(NOTICE_RE);
  });
});
