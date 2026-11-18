/**
 * Security-behaviour tests for the OCR-study API (real PostgreSQL, real sessions; SYNTHETIC data). Passing these tests does not resolve any risk in
 * docs/OCR-STUDY-THREAT-MODEL.md by itself: each risk there states what a test shows and what still needs infrastructure or human decisions.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const FX = path.resolve(__dirname, '../../../validation/fixtures/ocr-study');
const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const PW = (k: string) => `Pw-${k}-Xy7!aaaa`;

describe.skipIf(!URL_)('OCR study security controls (real PostgreSQL)', () => {
  const dbName = `anuclaw_sec_${crypto.randomBytes(6).toString('hex')}`; const studyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrsec-'));
  let admin: Client; let server: Server; let base: string; let q: (s: string, p?: unknown[]) => Promise<any[]>; let reset: () => void;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {}; const token: Record<string, string> = {}; const email = (k: string) => `${k}@sec-synthetic.invalid`;
  const KEYS = ['owner', 'owner2', 'cust', 'annA', 'annB', 'adj', 'stat', 'lead', 'lead2', 'aud', 'outsider'];
  const ENV_KEYS = ['ANUCLAW_STUDY_REAUTH', 'ANUCLAW_STUDY_FRESH_SESSION_SEC', 'ANUCLAW_STUDY_REQUIRE_ORIGIN', 'ANUCLAW_STUDY_RATE_SENSITIVE', 'ANUCLAW_STUDY_RATE_EXPENSIVE', 'ANUCLAW_STUDY_RATE_UPLOAD', 'ANUCLAW_STUDY_RATE_GENERAL'];

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'), ANUCLAW_STUDY_STORAGE: 'local_synthetic', ANUCLAW_STUDY_LOCAL_ROOT: studyRoot });
    delete process.env.NODE_ENV; vi.resetModules(); await (await import('../../db/connection')).ensureDbReady(); const { db } = await import('../../db'); q = (s, p) => db.query(s, p as any[]);
    const auth = await import('../../dashboard/server/auth'); const { hashPassword } = await import('../../security/password'); reset = (await import('../../dashboard/server/ocr-study-security')).resetRateLimits;
    for (const k of KEYS) { const id = crypto.randomUUID(); ids[k] = id; await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,$4,0)`, [id, email(k), k === 'aud' ? 'auditor' : 'operator', await hashPassword(PW(k))]); token[k] = (await auth.issueTokens(id)).accessToken; cookie[k] = `dash_token=${token[k]}`; }
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express(); app.use(cookieParser()); app.use(express.json({ limit: '4mb' }));
    app.use('/api/ocr-study', (await import('../../dashboard/server/routes/ocr-study')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ocr-study`;
  }, 120_000);
  afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; reset(); });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r())); try { (await import('../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
    fs.rmSync(studyRoot, { recursive: true, force: true });
  });

  const call = async (who: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ } return { status: r.status, json, text, headers: r.headers };
  };
  const annFile = (f: any, caseIds: string[]) => { const m = (k: string) => caseIds[Number(k.slice(1)) - 1]; const { annotatorId, ...rest } = f; void annotatorId; return { ...rest, completedCaseIds: f.completedCaseIds.map(m), items: f.items.map((i: any) => ({ ...i, caseId: m(i.caseId) })) }; };
  const sources = () => JSON.parse(fs.readFileSync(path.join(FX, 'sources.json'), 'utf8')).map((s: any) => ({ contentBase64: fs.readFileSync(path.join(FX, s.file)).toString('base64'), pages: s.pages, mediaType: s.mediaType }));
  interface S { ws: string; ds: string; caseIds: string[]; digest: string }
  async function study(upTo: 'members' | 'annotated' | 'locked' = 'members'): Promise<S> {
    reset();
    const ws = (await call('owner', 'POST', '/studies', { name: 'Synthetic security study', purpose: 'tests' })).json.id as string;
    for (const [k, r] of [['owner2', 'study_owner'], ['cust', 'dataset_custodian'], ['annA', 'annotator'], ['annB', 'annotator'], ['adj', 'adjudicator'], ['stat', 'statistician'], ['lead', 'clinical_lead'], ['lead2', 'clinical_lead'], ['aud', 'auditor']]) expect((await call('owner', 'POST', `/studies/${ws}/members`, { memberEmail: email(k), studyRole: r })).status).toBe(201);
    const s: S = { ws, ds: '', caseIds: [], digest: '' }; if (upTo === 'members') return s;
    const reg = await call('cust', 'POST', `/studies/${ws}/datasets`, { name: 'synthetic', studyRef: 'SYNTH', provenanceKind: 'synthetic_fixture', split: 'locked_validation', origin: 'synthetic', annotatorEmails: [email('annA'), email('annB')], sources: sources() }); expect(reg.status).toBe(201); s.ds = reg.json.datasetId; s.caseIds = reg.json.caseIds;
    await call('cust', 'POST', `/studies/${ws}/datasets/${s.ds}/attestation`, { record: rd('attestation.synthetic.json') }); await call('cust', 'POST', `/studies/${ws}/datasets/${s.ds}/manifest`);
    expect((await call('annA', 'POST', `/studies/${ws}/datasets/${s.ds}/annotations`, { file: annFile(rd('annotator-a.json'), s.caseIds) })).status).toBe(201); expect((await call('annB', 'POST', `/studies/${ws}/datasets/${s.ds}/annotations`, { file: annFile(rd('annotator-b.json'), s.caseIds) })).status).toBe(201);
    if (upTo === 'annotated') return s;
    for (const d of (await call('adj', 'GET', `/studies/${ws}/datasets/${s.ds}/queue`)).json.queue) await call('adj', 'POST', `/studies/${ws}/datasets/${s.ds}/adjudications`, { queueId: d.id, source: d.field === 'presence' ? 'B' : 'A', reason: 'synthetic' });
    await call('cust', 'POST', `/studies/${ws}/datasets/${s.ds}/truth`); const lk = await call('cust', 'POST', `/studies/${ws}/datasets/${s.ds}/lock`); s.digest = lk.json.lockDigest; return s;
  }
  const M = (s: S, uid: string, rest = '') => `/studies/${s.ws}/members/${ids[uid]}${rest}`;

  it('suspended and removed members lose ALL study access immediately; history and audit provenance are preserved, never rewritten', async () => {
    const s = await study('annotated'); const annFileA = fs.readdirSync(studyRoot, { recursive: true } as any).map(String).find((x) => x.endsWith(path.join(ids.annA, 'v1.json')))!; const hashA = crypto.createHash('sha256').update(fs.readFileSync(path.join(studyRoot, annFileA))).digest('hex');
    expect((await call('annA', 'GET', `/studies/${s.ws}/datasets/${s.ds}/my-annotations`)).status).toBe(200);
    const sus = await call('owner', 'POST', M(s, 'annA', '/suspend'), { reason: 'synthetic: suspicious activity SECRET-REASON-TEXT' }); expect(sus.status).toBe(200); expect(sus.json.warning).toMatch(/revokes ALL their access/);
    for (const [m, p, b] of [['GET', `/studies/${s.ws}`], ['GET', `/studies/${s.ws}/datasets/${s.ds}/cases`], ['GET', `/studies/${s.ws}/datasets/${s.ds}/my-annotations`], ['POST', `/studies/${s.ws}/datasets/${s.ds}/annotations`, { file: annFile(rd('annotator-a.json'), s.caseIds) }], ['GET', `/studies/${s.ws}/datasets/${s.ds}/cases/${s.caseIds[0]}/source`]] as const) expect([m, p, (await call('annA', m, p, b)).status]).toEqual([m, p, 404]);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(studyRoot, annFileA))).digest('hex')).toBe(hashA);                                          // annotation file untouched
    const list = await call('owner', 'GET', `/studies/${s.ws}/members`); expect(list.json.members.find((m: any) => m.userId === ids.annA)).toMatchObject({ status: 'suspended' });
    expect((await call('owner', 'POST', M(s, 'annA', '/suspend'), { reason: 'again' })).status).toBe(409);
    expect((await call('owner', 'POST', M(s, 'annA', '/reinstate'), { reason: 'cleared' })).status).toBe(200); expect((await call('annA', 'GET', `/studies/${s.ws}/datasets/${s.ds}/my-annotations`)).status).toBe(200);
    expect((await call('owner', 'POST', M(s, 'annA', '/remove'), { reason: 'left the study' })).status).toBe(200);
    expect((await call('annA', 'GET', `/studies/${s.ws}`)).status).toBe(404); expect((await call('owner', 'POST', M(s, 'annA', '/reinstate'), { reason: 'x' })).json.code).toBe('bad_state');
    expect((await call('owner', 'POST', `/studies/${s.ws}/members`, { memberEmail: email('annA'), studyRole: 'annotator' })).json.code).toBe('already_member');                 // a removed member cannot be re-added
    expect((await q(`SELECT status FROM ocr_study_members WHERE workspace_id = $1 AND user_id = $2`, [s.ws, ids.annA]))[0].status).toBe('removed');                          // the row is kept
    expect((await call('annB', 'GET', `/studies/${s.ws}/datasets/${s.ds}/my-annotations`)).status).toBe(200);                                                              // others unaffected
    expect(fs.existsSync(path.join(studyRoot, annFileA))).toBe(true);                                                                                                         // no deletion route exists
    for (const m of ['DELETE', 'PUT', 'PATCH']) expect((await call('owner', m, M(s, 'annA'))).status).toBe(404);
    const audit = await call('aud', 'GET', `/studies/${s.ws}/audit`); expect(audit.text).not.toMatch(/SECRET-REASON-TEXT|suspicious|left the study/);
    const ev = audit.json.events.filter((e: any) => /member_(suspended|reinstated|removed)/.test(e.action)); expect(ev.length).toBe(3); for (const e of ev) { expect(e.meta.reasonSha256).toMatch(/^[0-9a-f]{64}$/); expect(e.meta.reasonLength).toBeGreaterThan(0); }
    expect((await call('owner', 'POST', M(s, 'annB', '/suspend'), {})).status).toBe(400);                                                                                    // reason required
    expect((await call('adj', 'POST', M(s, 'annB', '/suspend'), { reason: 'x' })).status).toBe(403);                                                                         // only study owners
  }, 120_000);

  it('the last active study owner cannot be suspended or removed; a second owner makes it possible', async () => {
    const s = await study('members'); const r1 = await call('owner', 'POST', M(s, 'owner', '/suspend'), { reason: 'self' }); expect(r1.status).toBe(200);                      // owner2 exists, so allowed … (owner now suspended)
    expect((await call('owner', 'GET', `/studies/${s.ws}`)).status).toBe(404);                                                                                                  // a suspended owner has no access, even to their own study
    const r2 = await call('owner2', 'POST', M(s, 'owner2', '/remove'), { reason: 'last owner attempt' }); expect([r2.status, r2.json.code]).toEqual([409, 'last_owner']);
    expect((await call('owner2', 'POST', M(s, 'owner2', '/suspend'), { reason: 'last owner attempt' })).json.code).toBe('last_owner');
    expect((await call('owner2', 'POST', M(s, 'owner', '/reinstate'), { reason: 'restore' })).status).toBe(200); expect((await call('owner', 'POST', M(s, 'owner2', '/remove'), { reason: 'ok now' })).status).toBe(200);
    expect((await call('owner', 'POST', M(s, 'owner', '/remove'), { reason: 'last' })).json.code).toBe('last_owner'); expect(Number((await q(`SELECT COUNT(*) AS n FROM ocr_study_members WHERE workspace_id = $1 AND study_role = 'study_owner' AND status = 'active'`, [s.ws]))[0].n)).toBe(1);
  }, 120_000);

  it('removing a dataset custodian or clinical lead needs a SECOND authorized actor; requester, target and replay are refused', async () => {
    const s = await study('members'); expect((await call('owner', 'POST', M(s, 'cust', '/remove'), { reason: 'direct' })).json.code).toBe('second_authorization_required');
    expect((await call('owner', 'POST', M(s, 'annA', '/requests'), { action: 'remove', reason: 'x' })).status).toBe(400);                                                       // not a two-person role
    const rq = await call('owner', 'POST', M(s, 'cust', '/requests'), { action: 'remove', reason: 'synthetic: custody concern QUOKKA-REASON' }); expect(rq.status).toBe(201); const rid = rq.json.requestId;
    expect((await call('owner', 'POST', M(s, 'cust', '/requests'), { action: 'suspend', reason: 'dup' })).json.code).toBe('request_open');
    expect((await call('owner', 'POST', M(s, 'cust', `/requests/${rid}/approve`), { reason: 'self-approve' })).json.code).toBe('approver_must_differ');                          // requester cannot approve
    expect((await call('cust', 'POST', M(s, 'cust', `/requests/${rid}/approve`), { reason: 'self' })).status).toBe(403);                                                         // the member concerned cannot
    expect((await call('adj', 'POST', M(s, 'cust', `/requests/${rid}/approve`), { reason: 'x' })).status).toBe(403); expect((await call('annA', 'POST', M(s, 'cust', `/requests/${rid}/approve`), { reason: 'x' })).status).toBe(403);
    expect((await call('owner', 'POST', M(s, 'cust', `/requests/${rid}/execute`))).json.code).toBe('not_authorized'); expect((await call('cust', 'GET', `/studies/${s.ws}`)).status).toBe(200);   // unapproved: nothing changed
    expect((await call('owner2', 'POST', M(s, 'cust', `/requests/${rid}/approve`), { reason: 'agreed' })).status).toBe(200); expect((await call('owner2', 'POST', M(s, 'cust', `/requests/${rid}/execute`))).status).toBe(403);   // only the requester executes
    const done = await call('owner', 'POST', M(s, 'cust', `/requests/${rid}/execute`)); expect([done.status, done.json.status]).toEqual([200, 'removed']); expect((await call('cust', 'GET', `/studies/${s.ws}`)).status).toBe(404);
    expect((await call('owner', 'POST', M(s, 'cust', `/requests/${rid}/execute`))).json.code).toBe('authorization_already_used');
    // clinical lead, approved by the OTHER clinical lead
    const rq2 = await call('owner', 'POST', M(s, 'lead', '/requests'), { action: 'suspend', reason: 'review' }); const rid2 = rq2.json.requestId; expect((await call('lead', 'POST', M(s, 'lead', `/requests/${rid2}/approve`), { reason: 'self' })).json.code).toBe('approver_must_differ');
    expect((await call('lead2', 'POST', M(s, 'lead', `/requests/${rid2}/approve`), { reason: 'ok' })).status).toBe(200); expect((await call('owner', 'POST', M(s, 'lead', `/requests/${rid2}/execute`))).status).toBe(200); expect((await call('lead', 'GET', `/studies/${s.ws}`)).status).toBe(404);
    expect((await call('lead2', 'GET', `/studies/${s.ws}`)).status).toBe(200);
    // an approver who lost their role before execution voids the approval
    const rq3 = await call('owner', 'POST', M(s, 'lead2', '/requests'), { action: 'remove', reason: 'x' }); const rid3 = rq3.json.requestId; expect((await call('owner2', 'POST', M(s, 'lead2', `/requests/${rid3}/approve`), { reason: 'ok' })).status).toBe(200);
    expect((await call('owner', 'POST', M(s, 'owner2', '/remove'), { reason: 'approver leaves' })).status).toBe(200); expect((await call('owner', 'POST', M(s, 'lead2', `/requests/${rid3}/execute`))).json.code).toBe('not_authorized');
    const audit = await call('aud', 'GET', `/studies/${s.ws}/audit`); expect(audit.text).not.toMatch(/QUOKKA|custody concern/); expect(audit.json.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ocr_study.member_action_requested', 'ocr_study.member_action_approved', 'ocr_study.member_removed']));
  }, 120_000);

  it('sensitive actions need re-authentication when the policy requires it (stale session → password); the password is never logged or echoed', async () => {
    const s = await study('locked'); Object.assign(process.env, { ANUCLAW_STUDY_REAUTH: 'required', ANUCLAW_STUDY_FRESH_SESSION_SEC: '0' });
    expect((await call('owner', 'GET', '/')).json.security.reauth).toMatchObject({ required: true, freshSessionSeconds: 0 });
    const sev = (extra: object = {}) => call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'review-first' }, ...extra });
    const a = await sev(); expect([a.status, a.json.code]).toEqual([401, 'reauth_required']); expect(a.json.policy).toBe('configure_severity');
    const b = await sev({ reauthPassword: 'wrong-password-ZEBRA' }); expect([b.status, b.json.code]).toEqual([401, 'reauth_failed']); expect(b.text).not.toContain('ZEBRA');
    expect((await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'review-first' }, reauthPassword: PW('lead') })).status).toBe(200);
    expect((await call('owner2', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'x' }, reauthPassword: PW('lead') })).status).toBe(403);                                       // someone else's password never helps (and the role check came first)
    expect((await call('stat', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations`, { runId: 'e1', mode: 'locked', expectedLockDigest: s.digest, results: { schema: 'anuclaw-ocr-extraction/v1', system: { engine: 'f', version: '0' }, documents: [] }, })).status).not.toBe(401);   // evaluation is not a sensitive action
    expect((await call('owner', 'POST', M(s, 'annA', '/suspend'), { reason: 'x' })).json.code).toBe('reauth_required'); expect((await call('owner', 'POST', M(s, 'annA', '/suspend'), { reason: 'x', reauthPassword: PW('owner') })).status).toBe(200);
    const rq = await call('cust', 'POST', `/studies/${s.ws}/datasets/${s.ds}/unlock-requests`, { reason: 'synthetic' }); const rid = rq.json.requestId;
    const au = (b: object) => call('owner', 'POST', `/studies/${s.ws}/datasets/${s.ds}/unlock-requests/${rid}/authorize`, { reason: 'r', protocolDeviationRef: 'D', credentialRef: 'C', roleClaim: 'R', ...b }); expect((await au({})).json.code).toBe('reauth_required'); expect((await au({ reauthPassword: PW('owner') })).status).toBe(201);
    expect((await call('cust', 'POST', `/studies/${s.ws}/datasets/${s.ds}/unlock-requests/${rid}/execute`, {})).json.code).toBe('reauth_required');
    expect((await call('aud', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations/none/export`, {})).json.code).toBe('reauth_required'); expect((await call('aud', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations/none/export`, { reauthPassword: PW('aud') })).status).toBe(404);
    const audit = (await call('owner', 'GET', `/studies/${s.ws}/audit`)); expect(audit.text).not.toMatch(/Pw-|ZEBRA|wrong-password/); expect(audit.json.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ocr_study.security.reauth_required', 'ocr_study.security.reauth_failed']));
    process.env.ANUCLAW_STUDY_FRESH_SESSION_SEC = '3600'; expect((await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'again' } })).status).toBe(200);                       // a fresh session satisfies the policy
    delete process.env.ANUCLAW_STUDY_REAUTH; expect((await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'off' } })).status).toBe(200);                              // default (non-production) behaviour unchanged
  }, 120_000);

  it('cross-site and malformed mutations are refused (origin, fetch-metadata, content type); production mode requires a same-origin Origin for cookie mutations', async () => {
    const host = new URL(base).host; const body = { name: 'n', purpose: 'p' };
    const evil = await call('owner', 'POST', '/studies', body, { origin: 'http://evil.example' }); expect([evil.status, evil.json.code]).toEqual([403, 'csrf_refused']);
    expect((await call('owner', 'POST', '/studies', body, { 'sec-fetch-site': 'cross-site' })).json.code).toBe('csrf_refused'); expect((await call('owner', 'POST', '/studies', body, { origin: 'null' })).json.code).toBe('csrf_refused');
    expect((await call('owner', 'POST', '/studies', JSON.stringify(body), { 'content-type': 'text/plain' })).json?.code ?? 'csrf_refused').toBe('csrf_refused'); expect((await call('owner', 'POST', '/studies', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).json.code).toBe('csrf_refused');
    expect((await call('owner', 'POST', '/studies', body, { origin: `http://${host}` })).status).toBe(201); expect((await call('owner', 'GET', '/', undefined, { origin: 'http://evil.example' })).status).toBe(200);   // reads carry no side effects
    process.env.ANUCLAW_STUDY_REQUIRE_ORIGIN = 'true'; expect((await call('owner', 'POST', '/studies', body)).json.code).toBe('csrf_refused');
    expect((await call('owner', 'POST', '/studies', body, { origin: `http://${host}` })).status).toBe(201); expect((await call('owner', 'POST', '/studies', body, { 'sec-fetch-site': 'same-origin' })).status).toBe(201);
    const bearer = await fetch(base + '/studies', { method: 'POST', headers: { authorization: `Bearer ${token.owner}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(bearer.status).toBe(201);   // not cookie-ambient
    const denied = (await q(`SELECT 1 FROM audit_events WHERE action = 'ocr_study.denied'`)).length; void denied;
  }, 60_000);

  it('oversized input, archives, deep JSON and unpaginated reads are refused or clamped', async () => {
    const s = await study('annotated'); const reg = (srcs: unknown) => call('cust', 'POST', `/studies/${s.ws}/datasets`, { name: 'x', studyRef: 'S', provenanceKind: 'synthetic_fixture', split: 'development', origin: 'o', annotatorEmails: [email('annA'), email('annB')], sources: srcs });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('payload')]).toString('base64'); const z = await reg([{ contentBase64: zip, pages: 1, mediaType: 'text/plain' }]); expect([z.status, z.json.code]).toEqual([400, 'archive_refused']);
    expect((await reg([{ contentBase64: Buffer.from([0x1f, 0x8b, 8, 0]).toString('base64'), pages: 1, mediaType: 'application/pdf' }])).json.code).toBe('archive_refused'); expect((await reg([{ contentBase64: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]).toString('base64'), pages: 1, mediaType: 'image/png' }])).json.code).toBe('archive_refused');
    expect((await reg(Array.from({ length: 51 }, () => ({ contentBase64: 'QQ==', pages: 1, mediaType: 'text/plain' })))).status).toBe(400); expect((await reg([{ contentBase64: Buffer.alloc(1_048_577, 65).toString('base64'), pages: 1, mediaType: 'text/plain' }])).status).toBe(400);
    expect((await reg(Array.from({ length: 3 }, () => ({ contentBase64: Buffer.alloc(1_033_334, 65).toString('base64'), pages: 1, mediaType: 'text/plain' })))).status).toBe(400);                  // 3.1 MB in total
    const big = await fetch(base + '/studies', { method: 'POST', headers: { cookie: cookie.owner, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(5_000_000), purpose: 'p' }) }); expect(big.status).toBe(413);
    let deep: any = { v: 1 }; for (let i = 0; i < 30; i++) deep = { a: deep }; expect((await call('owner', 'POST', '/studies', { name: 'n', purpose: 'p', deep })).json.code).toBe('too_deep');
    const many = { schema: 'anuclaw-ocr-annotator-file/v1', completedCaseIds: s.caseIds, items: Array.from({ length: 5001 }, () => ({})) }; expect((await call('annA', 'POST', `/studies/${s.ws}/datasets/${s.ds}/annotations`, { file: many })).status).toBe(413);
    const cand = Array.from({ length: 20001 }, () => ({ analyte: 'a', valueRaw: '1', page: 1 })); expect((await call('stat', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations`, { runId: 'r', mode: 'development', results: { documents: [{ candidates: cand }] } })).status).toBe(413);
    const pg = await call('adj', 'GET', `/studies/${s.ws}/datasets/${s.ds}/queue?limit=100000&offset=-3`); expect(pg.json).toMatchObject({ limit: 200, offset: 0 }); const p2 = await call('adj', 'GET', `/studies/${s.ws}/datasets/${s.ds}/queue?limit=1`); expect(p2.json.queue).toHaveLength(1); expect(p2.json.total).toBeGreaterThan(1);
    expect((await call('aud', 'GET', `/studies/${s.ws}/audit?limit=1`)).json.events).toHaveLength(1); expect((await call('annA', 'GET', `/studies/${s.ws}/datasets/${s.ds}/cases?limit=1`)).json.cases).toHaveLength(1);
  }, 120_000);

  it('expensive and sensitive operations are rate limited per user with Retry-After; refusals are audited without content', async () => {
    const s = await study('members'); process.env.ANUCLAW_STUDY_RATE_SENSITIVE = '2'; reset();
    const put = (n: number) => call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: `label${n}` } }); expect((await put(1)).status).toBe(200); expect((await put(2)).status).toBe(200);
    const third = await put(3); expect([third.status, third.json.code]).toEqual([429, 'rate_limited']); expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0); expect(third.json.bucket).toBe('sensitive');
    expect((await call('owner', 'POST', M(s, 'annA', '/suspend'), { reason: 'x' })).status).toBe(200);                                                                                      // another user has their own window
    process.env.ANUCLAW_STUDY_RATE_GENERAL = '3'; reset(); const codes: number[] = []; for (let i = 0; i < 5; i++) codes.push((await call('aud', 'GET', '/')).status); expect(codes).toEqual([200, 200, 200, 429, 429]);
    delete process.env.ANUCLAW_STUDY_RATE_GENERAL; reset(); const ev = await q(`SELECT meta FROM audit_events WHERE action = 'ocr_study.security.rate_limited' AND target_id = $1`, [s.ws]); expect(ev.length).toBeGreaterThanOrEqual(1);
    for (const r of ev) expect(JSON.parse(r.meta)).toEqual({ bucket: 'sensitive', limit: 2 });
  }, 120_000);

  it('security headers are set, and structured security events contain no names, free text, reasons or credentials', async () => {
    const s = await study('members'); const r = await call('owner', 'GET', `/studies/${s.ws}`); const h = r.headers;
    expect(h.get('x-content-type-options')).toBe('nosniff'); expect(h.get('cache-control')).toBe('no-store'); expect(h.get('content-security-policy')).toMatch(/default-src 'none'/); expect(h.get('x-frame-options')).toBe('DENY'); expect(h.get('referrer-policy')).toBe('no-referrer'); expect(h.get('x-study-tooling-notice')).toMatch(/Study tooling only/);
    expect(h.get('access-control-allow-origin')).toBeNull();                                                                                                                                // no CORS opened for this route
    Object.assign(process.env, { ANUCLAW_STUDY_REAUTH: 'required', ANUCLAW_STUDY_FRESH_SESSION_SEC: '0' }); await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'x' }, reauthPassword: 'Jane-Roe-secret-QUOKKA' }); await call('outsiderless' as never, 'GET', '/');
    const rows = await q(`SELECT actor_id, action, meta FROM audit_events WHERE target_type = 'ocr_study' AND target_id = $1`, [s.ws]); const all = JSON.stringify(rows);
    expect(all).not.toMatch(/Jane|Roe|QUOKKA|@sec-synthetic|Pw-|password/i); for (const row of rows) for (const v of Object.values(JSON.parse(row.meta ?? '{}'))) expect(String(v)).toMatch(/^[A-Za-z0-9._:@/+=-]{0,200}$/);
  }, 60_000);

  // ── OCR study policy (persistence, authorization, immutability, fail-closed) ──
  const stampOf = async (ws: string, kind = 'synthetic_test') => (await call('stat', 'GET', `/studies/${ws}/policy?kind=${kind}`)).json.stamp;
  const resultsFor = (caseIds: string[], stamp?: unknown) => { const r = rd('results.json'); return { ...r, ...(stamp ? { policy: stamp } : {}), documents: r.documents.map((d: any) => ({ ...d, documentId: caseIds[Number(d.documentId.slice(1)) - 1] })) }; };
  const allFields = (ref: string) => Object.fromEntries(['confidenceFlagThreshold', 'enabledReviewFlags', 'severityMap', 'humanConfirmation', 'secondReaderRule', 'unitEquivalence', 'annotationTolerance', 'minTruthItems', 'minDocuments', 'calibrationBins', 'acceptanceCriteriaRef', 'stoppingRulesRef', 'independentReviewRequirementsRef'].map((k) => [k, { value: {
    confidenceFlagThreshold: 0.5, enabledReviewFlags: ['missing_unit'], severityMap: Object.fromEntries(['value', 'comparator', 'unit', 'refLow', 'refHigh', 'page', 'missed_item', 'extraction_failure', 'extraneous_candidate'].map((t) => [t, 'L'])), humanConfirmation: 'every_candidate_confirmed', secondReaderRule: 'none',
    unitEquivalence: { caseFold: true, microSignToU: true, stripWhitespace: true, equivalentGroups: [] }, annotationTolerance: { default: { abs: 0, rel: 0 } }, minTruthItems: 1, minDocuments: 1, calibrationBins: 5, acceptanceCriteriaRef: 'TEST-DOC', stoppingRulesRef: 'TEST-DOC', independentReviewRequirementsRef: 'TEST-DOC' }[k], sourceRef: ref }]));

  it('policy: a blank real-study policy is unconfigured and not effective; only owner / clinical lead / statistician can edit; others are refused or see nothing; the synthetic chain is separate', async () => {
    const s = await study('members'); const real = await call('stat', 'GET', `/studies/${s.ws}/policy`); expect(real.status).toBe(200); expect(real.json.policy.kind).toBe('real_study'); expect(real.json.effectiveState).toMatch(/draft — not effective.*13 required field\(s\) unconfigured/); expect(Object.values(real.json.policy.fields).every((f: any) => f.status === 'unconfigured')).toBe(true);
    const syn = await call('stat', 'GET', `/studies/${s.ws}/policy?kind=synthetic_test`); expect(syn.json.policy.kind).toBe('synthetic_test'); expect(syn.json.policy.fields.confidenceFlagThreshold.sourceRef).toMatch(/SYNTHETIC TEST VALUE/); expect(syn.json.stamp).toMatchObject({ kind: 'synthetic_test', version: 1 }); expect(real.json.stamp).toBeNull();
    const edit = (who: string) => call(who, 'PUT', `/studies/${s.ws}/policy`, { kind: 'real_study', fields: { calibrationBins: { value: 7, sourceRef: 'TEST-SOURCE' } } });
    for (const who of ['annA', 'adj', 'aud', 'cust']) expect([who, (await edit(who)).status]).toEqual([who, 403]); const other = (await call('lead', 'POST', '/studies', { name: 'other', purpose: 'isolation' })).json.id; for (const m of ['GET', 'PUT']) expect([m, (await call('annA', m, `/studies/${other}/policy`, m === 'PUT' ? { fields: {} } : undefined)).status]).toEqual([m, 404]);
    for (const who of ['annA', 'adj']) expect((await call(who, 'GET', `/studies/${s.ws}/policy`)).status).toBe(403); for (const who of ['aud', 'cust', 'lead', 'owner']) expect((await call(who, 'GET', `/studies/${s.ws}/policy`)).status).toBe(200);
    expect((await edit('lead')).status).toBe(201); expect((await edit('owner')).status).toBe(201); expect((await call('stat', 'PUT', `/studies/${s.ws}/policy`, { kind: 'real_study', fields: { calibrationBins: { value: 7, sourceRef: 'TEST' } }, role: 'x' })).json.code).toBe('forbidden_field');
    const h = await call('aud', 'GET', `/studies/${s.ws}/policy`); expect(h.json.versions.map((v: any) => v.version)).toEqual([1, 2, 3]); expect(h.json.versions[2].prevSha256).toBe(h.json.versions[1].sha256); expect(h.json.chainVerified).toBe(true);
    expect((await call('stat', 'GET', `/studies/${s.ws}/policy?kind=synthetic_test`)).json.versions).toHaveLength(1);                                                  // real-study edits never touch the synthetic chain
  }, 120_000);

  it('policy: a real-study field needs a source reference and a valid value; even a FULLY configured real policy is never active, cannot be activated, and cannot unlock real registration or acceptance', async () => {
    const s = await study('members'); const put = (fields: unknown, extra: object = {}) => call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'real_study', fields, ...extra });
    expect((await put({ confidenceFlagThreshold: { value: 0.5 } })).json.code).toBe('policy_invalid'); expect((await put({ confidenceFlagThreshold: { value: 5, sourceRef: 'TEST' } })).json.code).toBe('policy_invalid'); expect((await put({ bogus: { value: 1, sourceRef: 'x' } })).json.code).toBe('policy_invalid');
    const done = await put(allFields('TEST-REF (recorded, not verified)'), { clinicalLeadDecisionRef: 'EXTERNAL-DECISION-REF', independentReviewRef: 'EXTERNAL-REVIEW-REF' }); expect(done.status).toBe(201); expect(done.json.requiredFieldsUnconfigured).toEqual([]); expect(done.json.effectiveState).toMatch(/draft — not effective/);
    const act = await call('lead', 'POST', `/studies/${s.ws}/policy/activate`, { authorizationRef: 'EXTERNAL-AUTH', independentReviewRef: 'EXTERNAL-REVIEW' }); expect([act.status, act.json.code]).toEqual([409, 'activation_blocked']); expect(act.json.error).toMatch(/approved-protocol gate does not exist/);
    expect((await call('annA', 'POST', `/studies/${s.ws}/policy/activate`, {})).status).toBe(403);
    const reg = await call('cust', 'POST', `/studies/${s.ws}/datasets`, { name: 'x', studyRef: 'S', provenanceKind: 'human_annotated', split: 'development', origin: 'o', annotatorEmails: [email('annA'), email('annB')], sources: sources() }); expect([reg.status, reg.json.code]).toEqual([409, 'policy_not_active']);
    const rep = await call('aud', 'GET', `/studies/${s.ws}/policy/report`); expect(rep.status).toBe(200); expect(rep.json.realStudy.statement).toMatch(/NOT verification or approval/); expect(rep.json.realStudy.fields.every((f: any) => f.status === 'configured' && f.sourceReferencePresent && f.sourceReferenceIsVerification === false)).toBe(true); expect(rep.json.realStudy.policy.effectiveState).toMatch(/not effective/); expect(rep.json.engineeringDefaultsRemaining).toEqual([]);
    expect(rep.text).not.toMatch(/"value":\s*0\.5/);                                                                                                                      // the report selects/echoes no threshold
    const ev = await q(`SELECT action, meta FROM audit_events WHERE target_id = $1 AND action IN ('ocr_study.policy_activation_refused','ocr_study.policy_version_saved','ocr_study.denied')`, [s.ws]); expect(ev.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ocr_study.policy_activation_refused', 'ocr_study.policy_version_saved'])); expect(JSON.stringify(ev)).not.toMatch(/EXTERNAL-|TEST-REF|TEST-SOURCE/);
  }, 120_000);

  it('policy: versions are immutable (database refuses update/delete/truncate; there is no active state) and a tampered history fails closed everywhere it is used', async () => {
    const s = await study('annotated'); await call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'synthetic_test', fields: { severityMap: { value: Object.fromEntries(['value', 'comparator', 'unit', 'refLow', 'refHigh', 'page', 'missed_item', 'extraction_failure', 'extraneous_candidate'].map((t) => [t, 'X'])) } } });
    await expect(q(`DELETE FROM ocr_policies WHERE policy_id LIKE $1`, [`${s.ws}%`])).rejects.toThrow(/immutable/); await expect(q(`UPDATE ocr_policies SET state = 'draft'`)).rejects.toThrow(/immutable/); await expect(q(`TRUNCATE ocr_policies`)).rejects.toThrow(/immutable/);
    await expect(q(`INSERT INTO ocr_policies (policy_id, version, workspace_id, kind, state, content_json, sha256, created_by, created_at) VALUES ('x',1,'w','real_study','active','{}','${'0'.repeat(64)}','u',0)`)).rejects.toThrow(/violates check constraint/);   // no 'active' state can be stored
    await q(`ALTER TABLE ocr_policies DISABLE TRIGGER ocr_policies_immutable`); await q(`UPDATE ocr_policies SET content_json = replace(content_json, '"minDocuments"', '"minDocumentz"') WHERE policy_id = $1 AND version = 2`, [`${s.ws}:synthetic`]); await q(`ALTER TABLE ocr_policies ENABLE TRIGGER ocr_policies_immutable`);
    const g = await call('stat', 'GET', `/studies/${s.ws}/policy?kind=synthetic_test`); expect([g.status, g.json.code]).toEqual([409, 'policy_tampered']);
    for (const [who, m, p, b] of [['adj', 'GET', `/studies/${s.ws}/datasets/${s.ds}/queue`], ['stat', 'GET', `/studies/${s.ws}/datasets/${s.ds}/agreement`], ['stat', 'GET', `/studies/${s.ws}/policy/report`]] as const) expect([p.split('/').pop(), (await call(who, m, p, b)).json.code]).toEqual([p.split('/').pop(), 'policy_tampered']);
    expect((await call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'synthetic_test', fields: { calibrationBins: { value: 4 } } })).json.code).toBe('policy_tampered');          // no new version on a broken chain
  }, 120_000);

  it('policy: a locked dataset is evaluated under the version bound at the lock; drift and missing stamps are refused; the report, manifest and policy report record the exact version', async () => {
    const s = await study('locked'); const bound = await stampOf(s.ws); expect(bound.version).toBe(1);
    await call('lead', 'PUT', `/studies/${s.ws}/severity-map`, { map: { unit: 'after-lock' } }); const newer = await stampOf(s.ws); expect(newer.version).toBe(2);               // policy edited AFTER the lock
    const post = (runId: string, stamp?: unknown) => call('stat', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations`, { runId, mode: 'locked', expectedLockDigest: s.digest, results: resultsFor(s.caseIds, stamp) });
    expect((await post('nostamp')).json.code).toBe('policy_stamp_required'); expect((await post('newer', newer)).json.code).toBe('policy_version_drift');
    const ok = await post('bound', bound); expect(ok.status).toBe(201); expect(ok.json.report.provenance.policy).toMatchObject({ version: 1, sha256: bound.sha256, kind: 'synthetic_test' }); expect(ok.json.report.errorTypes.counts.unit.severity).toBe('unassigned');     // labels of the BOUND version, not the later edit
    const man = await call('aud', 'GET', `/studies/${s.ws}/datasets/${s.ds}/manifest`); expect(man.json.manifest.outputs[0].policy).toMatchObject({ version: 1, sha256: bound.sha256 });
    const rep = await call('aud', 'GET', `/studies/${s.ws}/policy/report`); const run = rep.json.runs.find((r: any) => r.runId === 'bound'); expect(run).toMatchObject({ policyVersion: 1, policySha256: bound.sha256 }); expect(rep.json.synthetic.policy.version).toBe(2); expect(rep.json.synthetic.runs.find((r: any) => r.runId === 'bound').usesThisPolicyVersion).toBe(false);
    const bad = (await q(`SELECT policy_sha256 FROM ocr_study_datasets WHERE workspace_id = $1`, [s.ws]))[0].policy_sha256; expect(bad).toBe(bound.sha256);
    await q(`UPDATE ocr_study_datasets SET policy_sha256 = $1 WHERE workspace_id = $2`, ['9'.repeat(64), s.ws]); expect((await post('tampered', bound)).json.code).toBe('policy_tampered');                  // the binding itself is checked against the immutable version
  }, 120_000);

  it('policy: options are no longer accepted on evaluation (values come only from the policy)', async () => {
    const s = await study('annotated'); expect((await call('stat', 'POST', `/studies/${s.ws}/datasets/${s.ds}/evaluations`, { runId: 'o1', mode: 'development', results: {}, options: { minTruthItems: 1 } })).json.error).toMatch(/options are not accepted/);
  }, 60_000);

  // ── draft-policy review workflow, readiness, second-reader rule ──
  const save = (who: string, ws: string, fields: unknown = { calibrationBins: { value: 7, sourceRef: 'TEST-REF (recorded, not verified)' } }, extra: object = {}) => call(who, 'PUT', `/studies/${ws}/policy`, { kind: 'real_study', fields, ...extra });
  const submit = (who: string, ws: string) => call(who, 'POST', `/studies/${ws}/policy/reviews`, { note: 'SECRET-NOTE-TEXT' });
  const decide = (who: string, ws: string, rid: string, b: object) => call(who, 'POST', `/studies/${ws}/policy/reviews/${rid}/decision`, b);
  const REFS = { externalDecisionRef: 'EXT-DEC-REF-1', externalSignatureRef: 'EXT-SIG-REF-1' };

  it('policy page API: role matrix — owner/lead/statistician prepare drafts; auditor and custodian view only; annotator/adjudicator see nothing; there is no activate/approve/release surface', async () => {
    const s = await study('members');
    for (const who of ['owner', 'lead', 'stat']) { expect([who, (await save(who, s.ws)).status]).toEqual([who, 201]); expect([who, (await call(who, 'GET', `/studies/${s.ws}/policy/readiness`)).status]).toEqual([who, 200]); }
    for (const who of ['aud', 'cust']) { expect([who, (await save(who, s.ws)).status]).toEqual([who, 403]); expect([who, (await submit(who, s.ws)).status]).toEqual([who, 403]); for (const p of ['policy', 'policy/report', 'policy/readiness', 'policy/reviews']) expect([who, p, (await call(who, 'GET', `/studies/${s.ws}/${p}`)).status]).toEqual([who, p, 200]); }
    for (const who of ['annA', 'adj']) for (const p of ['policy', 'policy/report', 'policy/readiness', 'policy/reviews']) expect([who, p, (await call(who, 'GET', `/studies/${s.ws}/${p}`)).status]).toEqual([who, p, 403]);
    const sub = (await submit('stat', s.ws)).json.reviewId; for (const who of ['aud', 'cust', 'annA', 'adj']) expect([who, (await decide(who, s.ws, sub, { decision: 'changes_requested' })).status]).toEqual([who, 403]);
    for (const path of ['policy/approve', 'policy/accept', 'policy/release', 'policy/active']) for (const m of ['POST', 'PUT']) expect([path, m, (await call('lead', m, `/studies/${s.ws}/${path}`, {})).status]).toEqual([path, m, 404]);
    expect((await call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'real_study', fields: {}, state: 'active', active: true })).json.effectiveState).toMatch(/draft — not effective/);
    const spec = JSON.stringify((await import('./openapi')).buildOcrStudyOpenApi().paths); expect(spec).not.toMatch(/policy\/(approve|accept|release|active)/);
  }, 120_000);

  it('policy review: two-person, different member, exact current version, no replay; records references only and never activates or enables real data', async () => {
    const s = await study('members'); expect((await save('stat', s.ws)).status).toBe(201);
    const r1 = await submit('stat', s.ws); expect(r1.status).toBe(201); expect(r1.json.status).toBe('awaiting_review'); expect((await submit('stat', s.ws)).json.code).toBe('already_submitted'); const rid = r1.json.reviewId;
    expect((await decide('stat', s.ws, rid, { decision: 'reviewed', ...REFS })).json.code).toBe('reviewer_must_differ');                                                 // self-review (submitter and author)
    expect((await decide('lead', s.ws, rid, { decision: 'reviewed' })).status).toBe(400); expect((await decide('lead', s.ws, rid, { decision: 'approved', ...REFS })).status).toBe(400);   // refs required; no "approved" value exists
    const ok = await decide('lead', s.ws, rid, { decision: 'reviewed', ...REFS, note: 'x' }); expect(ok.status).toBe(201); expect(ok.json.referencesAreVerification).toBe(false); expect(ok.json.effectiveState).toMatch(/draft — not effective/); expect(ok.json.statement).toMatch(/does not activate, approve, accept or release/);
    expect((await decide('owner', s.ws, rid, { decision: 'reviewed', ...REFS })).json.code).toBe('review_already_decided'); expect((await decide('lead', s.ws, rid, { decision: 'changes_requested' })).json.code).toBe('review_already_decided');   // replay
    const list = (await call('aud', 'GET', `/studies/${s.ws}/policy/reviews`)).json; expect(list.reviews[0]).toMatchObject({ status: 'reviewed', policyVersion: 2 }); expect(list.reviews[0].decision).toMatchObject({ externalDecisionRef: 'EXT-DEC-REF-1', externalSignatureRef: 'EXT-SIG-REF-1', referencesAreVerification: false });
    // stale: the policy moves on after submission
    const v3 = await save('lead', s.ws, allFields('TEST-REF'), { clinicalLeadDecisionRef: 'EXT-CL-DEC', independentReviewRef: 'EXT-IND-REV' }); expect(v3.status).toBe(201); const r3 = (await submit('owner', s.ws)).json.reviewId; expect((await save('stat', s.ws)).status).toBe(201);
    const stale = await decide('owner2', s.ws, r3, { decision: 'reviewed', ...REFS }); expect([stale.status, stale.json.code]).toEqual([409, 'stale_policy_review']);
    // the author of the saved version cannot review it even though a different member submitted it
    const r5 = (await submit('owner', s.ws)).json.reviewId; expect((await decide('stat', s.ws, r5, { decision: 'reviewed', ...REFS })).json.code).toBe('reviewer_must_differ');   // stat saved this version; owner submitted
    expect((await decide('lead', s.ws, r5, { decision: 'reviewed', ...REFS })).status).toBe(201);
    // readiness: still NOT eligible, with infrastructure gates, even with every field, both policy references and a recorded review
    const ready = (await call('lead', 'GET', `/studies/${s.ws}/policy/readiness`)).json; expect(ready.eligibleForActivation).toBe(false); expect(ready.banner).toMatch(/NOT ELIGIBLE FOR ACTIVATION/); expect(ready.items.filter((i: any) => i.category === 'infrastructure_gate').map((i: any) => i.id)).toEqual(expect.arrayContaining(['approved_protocol_gate', 'production_storage', 'identity_mfa', 'penetration_test']));
    expect(ready.items.filter((i: any) => i.category === 'missing_field')).toEqual([]);
    // real-data registration, activation and real evaluation stay blocked after every draft and review action
    const reg = await call('cust', 'POST', `/studies/${s.ws}/datasets`, { name: 'x', studyRef: 'S', provenanceKind: 'human_annotated', split: 'development', origin: 'o', annotatorEmails: [email('annA'), email('annB')], sources: sources() }); expect([reg.status, reg.json.code]).toEqual([409, 'policy_not_active']);
    const act = await call('lead', 'POST', `/studies/${s.ws}/policy/activate`, { authorizationRef: 'EXT-AUTH', independentReviewRef: 'EXT-REV' }); expect([act.status, act.json.code]).toEqual([409, 'activation_blocked']);
    const state = (await call('aud', 'GET', `/studies/${s.ws}/policy`)).json; expect(state.effectiveState).toMatch(/draft — not effective/); expect(state.policy.kind).toBe('real_study');
    const audit = await call('aud', 'GET', `/studies/${s.ws}/audit`); expect(audit.text).not.toMatch(/EXT-DEC-REF|EXT-SIG-REF|EXT-CL-DEC|EXT-IND-REV|SECRET-NOTE|TEST-REF/); expect(audit.json.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ocr_study.policy_review_submitted', 'ocr_study.policy_review_decided', 'ocr_study.policy_activation_refused']));
    await expect(q(`DELETE FROM ocr_policy_review_decisions`)).rejects.toThrow(/immutable/); await expect(q(`UPDATE ocr_policy_review_submissions SET version = version`)).rejects.toThrow(/immutable/); await expect(q(`TRUNCATE ocr_policy_review_decisions`)).rejects.toThrow(/immutable/);
    await expect(q(`INSERT INTO ocr_policy_review_decisions (id, submission_id, reviewer_id, decision, decided_at, policy_sha256, note_sha256, note_length) VALUES ('z','${r1.json.reviewId}','u','approved',0,'${'0'.repeat(64)}','${'0'.repeat(64)}',0)`)).rejects.toThrow(/violates check constraint/);   // no 'approved' state can be stored
  }, 180_000);

  it('policy review: cross-tenant and non-member access is "not found"; a tampered policy chain blocks submission, review, readiness and viewing', async () => {
    const s = await study('members'); expect((await save('stat', s.ws)).status).toBe(201); const rid = (await submit('stat', s.ws)).json.reviewId;
    const other = (await call('outsider', 'POST', '/studies', { name: 'other tenant', purpose: 'isolation' })).json.id;
    for (const [m, p, b] of [['GET', `/studies/${s.ws}/policy`], ['GET', `/studies/${s.ws}/policy/reviews`], ['GET', `/studies/${s.ws}/policy/readiness`], ['POST', `/studies/${s.ws}/policy/reviews`, {}], ['POST', `/studies/${s.ws}/policy/reviews/${rid}/decision`, { decision: 'changes_requested' }], ['PUT', `/studies/${s.ws}/policy`, { fields: {} }]] as const) expect([m, p, (await call('outsider', m, p, b)).status]).toEqual([m, p, 404]);
    expect((await decide('outsider', other, rid, { decision: 'changes_requested' })).status).toBe(404);                                                   // a review id from another study, through the caller's OWN study
    expect((await call('outsider', 'GET', `/studies/${other}/policy/reviews`)).json.reviews).toEqual([]);
    await q(`ALTER TABLE ocr_policies DISABLE TRIGGER ocr_policies_immutable`); await q(`UPDATE ocr_policies SET content_json = replace(content_json, 'real_study', 'real_studx') WHERE policy_id = $1 AND version = 2`, [`${s.ws}:real`]); await q(`ALTER TABLE ocr_policies ENABLE TRIGGER ocr_policies_immutable`);
    for (const [who, m, p, b] of [['lead', 'POST', `/studies/${s.ws}/policy/reviews/${rid}/decision`, { decision: 'reviewed', ...REFS }], ['owner', 'POST', `/studies/${s.ws}/policy/reviews`, {}], ['lead', 'GET', `/studies/${s.ws}/policy/readiness`], ['lead', 'GET', `/studies/${s.ws}/policy`], ['owner', 'PUT', `/studies/${s.ws}/policy`, { fields: { calibrationBins: { value: 3, sourceRef: 'TEST' } } }]] as const) expect([p.split('/').slice(-2).join('/'), (await call(who, m, p, b)).json.code]).toEqual([p.split('/').slice(-2).join('/'), 'policy_tampered']);
    expect((await q(`SELECT COUNT(*)::int AS n FROM ocr_policy_review_decisions d JOIN ocr_policy_review_submissions s ON s.id = d.submission_id WHERE s.workspace_id = $1`, [s.ws]))[0].n).toBe(0);   // nothing was recorded on the broken chain
  }, 120_000);

  it('secondReaderRule: only the mechanical requirement is enforced; unsupported rules are refused explicitly; the synthetic rule cannot reach real-data workflows', async () => {
    const s = await study('annotated'); const setRule = (v: string) => call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'synthetic_test', fields: { secondReaderRule: { value: v } } });
    expect((await call('lead', 'PUT', `/studies/${s.ws}/policy`, { kind: 'synthetic_test', fields: { secondReaderRule: { value: 'maybe' } } })).json.code).toBe('policy_invalid');
    expect((await setRule('flagged_values')).status).toBe(201); const t1 = await call('cust', 'POST', `/studies/${s.ws}/datasets/${s.ds}/truth`); expect([t1.status, t1.json.code]).toEqual([409, 'second_reader_rule_unsupported']);
    expect((await setRule('all_values')).status).toBe(201); const t2 = await call('cust', 'POST', `/studies/${s.ws}/datasets/${s.ds}/truth`); expect(t2.json.code).toBe('unresolved_disagreements');   // the rule was satisfied (full coverage by both annotators); the next, unrelated check fires
    expect((await setRule('none')).status).toBe(201);
    const reg = await call('cust', 'POST', `/studies/${s.ws}/datasets`, { name: 'x', studyRef: 'S', provenanceKind: 'human_annotated', split: 'development', origin: 'o', annotatorEmails: [email('annA'), email('annB')], sources: sources() }); expect(reg.json.code).toBe('policy_not_active');   // synthetic policy edits change nothing for real data
  }, 120_000);
});
