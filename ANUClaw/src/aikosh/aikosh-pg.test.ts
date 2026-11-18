/** AIKosh registry + routes (real PostgreSQL, real sessions). Test accounts are throw-away; no approval here is real. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('AIKosh registry (real PostgreSQL)', () => {
  const dbName = `anuclaw_aik_${crypto.randomBytes(6).toString('hex')}`; let admin: Client; let server: Server; let base: string; let q: (s: string, p?: unknown[]) => Promise<any[]>;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {}; let FILE: any; let reg: typeof import('./registry'); let inv: import('./inventory').Inventory; let identity: any;
  const USERS: Array<[string, string]> = [['adminA', 'admin'], ['compB', 'compliance'], ['adminC', 'admin'], ['op', 'operator'], ['aud', 'auditor'], ['viewer', 'viewer']];

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady(); const { db } = await import('../db'); q = (s, p) => db.query(s, p as any[]);
    const auth = await import('../dashboard/server/auth'); for (const [k, role] of USERS) { const id = crypto.randomUUID(); ids[k] = id; await q(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@aik-synthetic.invalid`, role]); cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`; }
    reg = await import('./registry'); const im = await import('./inventory'); inv = im.loadInventory(); FILE = inv.files.find((f) => f.path === 'pharmacology/indian_drug_brand_salts.csv')!; identity = im.identityOf(FILE);
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express(); app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
    app.use('/api/aikosh', (await import('../dashboard/server/routes/aikosh')).default); server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/aikosh`;
  }, 90_000);
  afterAll(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); } });

  const call = async (who: string | null, method: string, p: string, body?: unknown, h: Record<string, string> = {}) => { const r = await fetch(base + p, { method, headers: { ...(who ? { cookie: cookie[who] } : {}), 'content-type': 'application/json', ...h }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text }; };
  const proposal = (over: Record<string, unknown> = {}) => ({ path: FILE.path, sha256: FILE.sha256, provenance: 'TEST provenance statement', licenceName: 'TEST licence', licenceRef: 'TEST-LICENCE-REF', licencePermitsUses: ['rag', 'model_prompt', 'embeddings'], permittedUses: ['rag'], sensitivity: 'public_reference', ...over });

  it('before any approval: registry shows the default status, every non-local use is blocked, sync is immutable and idempotent', async () => {
    expect((await call('adminA', 'POST', '/sync', {})).json).toMatchObject({ registered: 20, unchanged: 0 }); expect((await call('adminA', 'POST', '/sync', {})).json).toMatchObject({ registered: 0, unchanged: 20 });
    const view = await call('op', 'GET', '/'); expect(view.status).toBe(200); expect(view.json.defaultStatus).toBe('unknown — blocked from external processing'); expect(view.json.canApprove).toBe(false); expect(view.json.files).toHaveLength(20); expect(view.json.files.every((f: any) => f.status === 'unknown — blocked from external processing')).toBe(true);
    for (const use of ['rag', 'embeddings', 'model_prompt', 'fine_tuning', 'clinical_evidence', 'external_provider']) { const c = await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=${use}`); expect([use, c.json.allowed]).toEqual([use, false]); }
    expect((await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=local_evaluation`)).json.allowed).toBe(true);
    expect((await call(null, 'GET', '/')).status).toBe(401); expect((await call('viewer', 'GET', '/')).status).toBe(403);
    for (const t of ['aikosh_files', 'aikosh_approval_records', 'aikosh_approval_decisions']) { await expect(q(`DELETE FROM ${t}`)).rejects.toThrow(/immutable/); await expect(q(`UPDATE ${t} SET id = id`.replace('SET id = id', t === 'aikosh_files' ? 'SET path = path' : 'SET id = id'))).rejects.toThrow(/immutable/); await expect(q(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(/immutable/); }
  }, 60_000);

  it('recording needs admin/compliance and complete evidence; approval needs a DIFFERENT person; the approval then applies to exactly these bytes', async () => {
    expect((await call('op', 'POST', '/approvals', proposal())).status).toBe(403); expect((await call('aud', 'POST', '/approvals', proposal())).status).toBe(403);
    expect((await call('adminA', 'POST', '/approvals', { ...proposal(), provenance: '' })).json.code).toBe('incomplete_approval'); expect((await call('adminA', 'POST', '/approvals', proposal({ sha256: 'f'.repeat(64) }))).json.code).toBe('unknown_file');
    expect((await call('adminA', 'POST', '/approvals', { ...proposal(), role: 'admin' })).json.code).toBe('forbidden_field'); expect((await call('adminA', 'POST', '/approvals', { ...proposal(), userId: ids.compB })).json.code).toBe('forbidden_field');
    const rec = await call('adminA', 'POST', '/approvals', proposal()); expect(rec.status).toBe(201); const id = rec.json.id; expect(rec.json.state).toBe('awaiting_second_person');
    expect((await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=rag`)).json.allowed).toBe(false);                                                       // proposal alone grants nothing
    expect((await call('adminA', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: 'self' })).json.code).toBe('approver_must_differ'); expect((await call('op', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: 'x' })).status).toBe(403);
    expect((await call('compB', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: '' })).status).toBe(400);
    expect((await call('compB', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: 'TEST approval reason QUOKKA' })).status).toBe(201);
    const ok = await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=rag`); expect(ok.json).toMatchObject({ allowed: true, status: 'approved_for_use' });
    for (const use of ['embeddings', 'model_prompt', 'fine_tuning', 'clinical_evidence', 'external_provider']) expect((await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=${use}`)).json.allowed).toBe(false);   // only the permitted use
    expect((await call('adminC', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: 'again' })).json.code).toBe('already_approved');
    // checksum tampering: the registry-backed checker refuses once the bytes differ from the approved hash
    expect((await reg.checkUse(identity, 'e'.repeat(64), 'rag')).allowed).toBe(false); expect((await reg.checkUse(identity, 'e'.repeat(64), 'rag')).reasons.join()).toMatch(/file changed since the approval/);
    expect((await reg.checkUse(identity, FILE.sha256, 'local_evaluation')).allowed).toBe(true); expect((await reg.checkUse(identity, 'e'.repeat(64), 'local_evaluation')).status).toBe('integrity_failure');
    expect((await call('aud', 'GET', `/approvals/${id}/chain`)).json).toMatchObject({ ok: true, entries: 1 });
    const rv = await call('adminC', 'POST', `/approvals/${id}/decision`, { decision: 'revoke', reason: 'withdrawn' }); expect(rv.status).toBe(201); expect((await call('op', 'GET', `/check?path=${encodeURIComponent(FILE.path)}&use=rag`)).json.allowed).toBe(false);
    expect((await call('adminC', 'POST', `/approvals/${id}/decision`, { decision: 'approve', reason: 'revive' })).json.code).toBe('revoked'); expect((await call('adminC', 'POST', `/approvals/${id}/decision`, { decision: 'revoke', reason: 'twice' })).json.code).toBe('not_approved');
    expect((await call('aud', 'GET', `/approvals/${id}/chain`)).json).toMatchObject({ ok: true, entries: 2 });
    // a tampered record (trigger disabled by the table owner to simulate DB-level tampering) is ignored: fails closed
    const id2 = (await call('adminA', 'POST', '/approvals', proposal())).json.id; await call('compB', 'POST', `/approvals/${id2}/decision`, { decision: 'approve', reason: 'ok' }); expect((await reg.checkUse(identity, FILE.sha256, 'rag')).allowed).toBe(true);
    await q(`ALTER TABLE aikosh_approval_records DISABLE TRIGGER aikosh_records_immutable`); await q(`UPDATE aikosh_approval_records SET content_json = replace(content_json, 'rag', 'rag","fine_tuning') WHERE id = $1`, [id2]); await q(`ALTER TABLE aikosh_approval_records ENABLE TRIGGER aikosh_records_immutable`);
    expect((await reg.checkUse(identity, FILE.sha256, 'rag')).allowed).toBe(false);                                                                                           // content hash no longer matches
    await q(`ALTER TABLE aikosh_approval_decisions DISABLE TRIGGER aikosh_decisions_immutable`); await q(`UPDATE aikosh_approval_decisions SET decided_by = 'someone-else' WHERE record_id = $1`, [id]); await q(`ALTER TABLE aikosh_approval_decisions ENABLE TRIGGER aikosh_decisions_immutable`);
    expect((await call('aud', 'GET', `/approvals/${id}/chain`)).json.ok).toBe(false);                                                                                          // decision log tampering is detected
  }, 90_000);

  it('external use and pathology-style narrative fields stay blocked even with an approval, unless every extra requirement and field release is recorded', async () => {
    const path = 'pathology/sample_pathology_cases.json'; const f = inv.files.find((x) => x.path === path)!; const { identityOf } = await import('./inventory'); const id = identityOf(f);
    const ext = { path, sha256: f.sha256, provenance: 'TEST', licenceName: 'TEST', licenceRef: 'T', licencePermitsUses: ['model_prompt', 'rag'], permittedUses: ['model_prompt'], sensitivity: 'identifiable', externalProcessing: 'approved', dpaRef: 'DPA-TEST' };
    expect((await call('adminA', 'POST', '/approvals', ext)).json.code).toBe('incomplete_approval');                                                                            // identifiable cannot be external
    const rec = await call('adminA', 'POST', '/approvals', { ...ext, sensitivity: 'public_reference' }); expect(rec.status).toBe(201); await call('compB', 'POST', `/approvals/${rec.json.id}/decision`, { decision: 'approve', reason: 'TEST' });
    const c1 = await reg.checkUse(id, f.sha256, 'model_prompt', ['microscopic_examination', 'clinical_history']); expect(c1.allowed).toBe(false); expect(c1.blockedFields).toEqual(expect.arrayContaining(['microscopic_examination', 'clinical_history']));
    expect((await reg.checkUse(id, f.sha256, 'model_prompt', ['histological_type'])).allowed).toBe(true);
    const rec2 = await call('adminA', 'POST', '/approvals', { ...ext, sensitivity: 'public_reference', externalFieldsReleased: ['microscopic_examination', 'clinical_history'] }); await call('compB', 'POST', `/approvals/${rec2.json.id}/decision`, { decision: 'approve', reason: 'TEST' });
    expect((await reg.checkUse(id, f.sha256, 'model_prompt', ['microscopic_examination'])).allowed).toBe(true);
    const ft = await call('adminA', 'POST', '/approvals', { ...ext, sensitivity: 'public_reference', permittedUses: ['fine_tuning'], licencePermitsUses: ['fine_tuning'] }); expect(ft.json.code).toBe('incomplete_approval'); expect(ft.json.error).toMatch(/consentRef, deidentificationRef and datasetCardSha256/);
  }, 60_000);

  it('audit entries hold paths, hashes and counts only; recorder and approver identities are session-derived', async () => {
    const rows = await q(`SELECT actor_id, action, meta FROM audit_events WHERE target_type = 'aikosh_file'`); expect(rows.length).toBeGreaterThan(3); const all = JSON.stringify(rows);
    expect(all).not.toMatch(/QUOKKA|TEST provenance|TEST licence|withdrawn|revive/); expect(rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(['aikosh.inventory_synced', 'aikosh.approval_recorded', 'aikosh.approval_approved', 'aikosh.approval_revoked']));
    expect(rows.find((r: any) => r.action === 'aikosh.approval_recorded').actor_id).toBe(ids.adminA);
    const c = await call('op', 'POST', '/sync', {}); expect(c.status).toBe(403);
    const origin = await call('adminA', 'POST', '/sync', {}, { origin: 'http://evil.example' }); expect(origin.json.code).toBe('csrf_refused');
  }, 60_000);
});

describe('AIKosh OpenAPI contract', () => {
  it('every implemented route is documented and the spec carries the governance notice', async () => {
    process.env.DASHBOARD_JWT_SECRET ??= crypto.randomBytes(32).toString('hex'); const router = (await import('../dashboard/server/routes/aikosh')).default as any; const { AIKOSH_OPS, buildAikoshOpenApi } = await import('./openapi');
    const impl = new Set<string>(); for (const l of router.stack) if (l.route) for (const m of Object.keys(l.route.methods)) impl.add(`${m} ${String(l.route.path).replace(/:(\w+)/g, '{$1}')}`);
    expect([...impl].sort()).toEqual(AIKOSH_OPS.map((o) => `${o.method} ${o.path}`).sort()); expect(buildAikoshOpenApi().info.description).toMatch(/AIKosh data governance only/);
  });
});
