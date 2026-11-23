/**
 * Skill registry, per-tenant assignment and the skill gate (interpretation engine, P2) against REAL PostgreSQL
 * (disposable database; opt-in via ANUCLAW_TEST_PG_URL) over the real HTTP layer. The agent runner is mocked, so no
 * model or container is ever called. Synthetic tenants only.
 */
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../container-runner', () => ({ runAgent: vi.fn(async () => ({ text: 'synthetic agent output', artifacts: [] })) }));

describe.skipIf(!URL_)('skill registry, assignment and gate (real PostgreSQL)', () => {
  const dbName = `anuclaw_skl_${crypto.randomBytes(6).toString('hex')}`;
  const ADMIN = crypto.randomBytes(24).toString('hex');
  let admin: Client; let server: Server; let base: string;
  let mainPool: { end(): Promise<void> } | undefined;
  let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let registry: typeof import('./registry');
  let adapters: typeof import('./adapters');
  let runAgentMock: ReturnType<typeof vi.fn>;
  let legacyTenant: { id: string; key: string };
  const AGENT_SKILL_COUNT = 13; // container/skills

  beforeAll(async () => {
    const u = new URL(URL_!);
    admin = new Client({ connectionString: URL_ }); await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, {
      PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
      ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    });
    delete process.env.ANUCLAW_RATE_STORE; delete process.env.ANUCLAW_SKILLS_DIR; delete process.env.ANUCLAW_SELF_REGISTRATION;
    vi.resetModules();
    await (await import('../../db/connection')).ensureDbReady();
    mainPool = (await import('../../db/connection')).getDb();
    q = (await import('../../db')).db.query as any;
    registry = await import('./registry'); adapters = await import('./adapters');
    runAgentMock = (await import('../../container-runner')).runAgent as any;

    // A tenant that exists BEFORE the registry has ever started: it must be grandfathered.
    const store = await import('../../api/tenant-store');
    const t = await store.registerTenant('Synthetic Legacy Co', 'legacy-co@synthetic.invalid');
    legacyTenant = { id: t.tenant_id, key: t.api_key };

    const express = (await import('express')).default;
    const app = express(); app.use(express.json());
    app.use((await import('../tenancy/admin-routes')).createTenantAdminRouter({ adminKey: ADMIN }));
    app.use((await import('./admin-routes')).createSkillAdminRouter({ adminKey: ADMIN }));
    app.use((await import('../../api/routes/admin')).createAdminRouter({ adminKey: ADMIN }));
    app.use('/api/v1/skills', (await import('../../api/routes/skills')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await mainPool?.end().catch(() => { /* already closed */ });
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const adm = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const asTenant = (key: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const newTenant = async (name: string) => {
    const r = await adm('POST', '/api/v1/admin/tenants', { company_name: name, email: `${name.toLowerCase().replace(/\W+/g, '-')}-${crypto.randomBytes(3).toString('hex')}@synthetic.invalid` });
    const b = await r.json(); expect(r.status).toBe(201);
    return { id: b.tenant_id as string, key: b.api_key as string };
  };
  const auditTypes = async (id: string) => (await (await adm('GET', `/api/v1/admin/tenants/${id}/audit`)).json()).entries.map((e: any) => e.event_type);
  const manifest = (over: Record<string, unknown> = {}) => ({
    id: 'test-skill', version: '1.0.0', title: 'Test Skill', acceptsAnalysisTypes: ['face_scan_vitals'], adapterId: 'beaive-v1',
    inputSchema: 'interpretation-request/v1', prompts: { clinical: 'clinical-vitals/v1' }, riskTier: 'ruo', requiresRelease: false, ...over,
  });
  const makeBeaiveAvailable = () => adapters.declareAdapter({ id: 'beaive-v1', available: true, analysisTypes: ['face_scan_vitals'] });
  const makeBeaiveUnavailable = () => adapters.declareAdapter({ id: 'beaive-v1', available: false, analysisTypes: ['face_scan_vitals'] });

  // ── seeding and one-time grandfathering ──────────────────────────────────────────────────────

  it('a tenant that existed before the registry started keeps access to every agent skill (grandfathered once, audited)', async () => {
    await registry.ensureSkillRegistry();
    const skills = await q(`SELECT skill_id, kind FROM skills`);
    expect(skills.filter((s) => s.kind === 'agent')).toHaveLength(AGENT_SKILL_COUNT);
    expect(skills.filter((s) => s.kind === 'interpretation').map((s) => s.skill_id).sort()).toEqual(
      ['clinical-report-generation', 'patient-friendly-explanation', 'physiological-signal-interpretation', 'posture-analysis-interpretation']);

    const assigned = await q(`SELECT skill_id, assigned_by FROM tenant_skills WHERE tenant_id = $1`, [legacyTenant.id]);
    expect(assigned).toHaveLength(AGENT_SKILL_COUNT);
    expect(new Set(assigned.map((a) => a.assigned_by))).toEqual(new Set(['migration']));
    expect(await auditTypes(legacyTenant.id)).toContain('tenant.skills.grandfathered');
    expect((await q(`SELECT 1 FROM registry_state WHERE key = 'grandfather_agent_skills_v1'`))).toHaveLength(1);

    const list = await (await asTenant(legacyTenant.key, 'GET', '/api/v1/skills')).json();
    expect(list.skills).toHaveLength(AGENT_SKILL_COUNT);
    expect(list.skills[0]).toHaveProperty('name');
    expect(list.skills[0]).toHaveProperty('description');
  });

  it('a tenant created afterwards starts with NO skills', async () => {
    const t = await newTenant('Synthetic New Co');
    expect(await q(`SELECT 1 FROM tenant_skills WHERE tenant_id = $1`, [t.id])).toHaveLength(0);
    expect((await (await asTenant(t.key, 'GET', '/api/v1/skills')).json()).skills).toEqual([]);
    expect(await auditTypes(t.id)).toEqual(['tenant.created']);
  });

  it('seeding is idempotent, and a skill an administrator removed stays removed after a restart', async () => {
    const del = await adm('DELETE', `/api/v1/admin/tenants/${legacyTenant.id}/skills/anuclaw-genomics`);
    expect(del.status).toBe(204);
    const before = (await q(`SELECT COUNT(*)::int AS n FROM cds_audit_log_mt WHERE tenant_id = $1`, [legacyTenant.id]))[0].n;
    registry.resetSkillRegistryForTests();
    await registry.ensureSkillRegistry(); // "restart"
    expect(await q(`SELECT 1 FROM tenant_skills WHERE tenant_id = $1 AND skill_id = 'anuclaw-genomics'`, [legacyTenant.id])).toHaveLength(0);
    expect((await q(`SELECT COUNT(*)::int AS n FROM tenant_skills WHERE tenant_id = $1`, [legacyTenant.id]))[0].n).toBe(AGENT_SKILL_COUNT - 1);
    expect((await q(`SELECT COUNT(*)::int AS n FROM cds_audit_log_mt WHERE tenant_id = $1`, [legacyTenant.id]))[0].n).toBe(before); // nothing re-grandfathered
    expect((await q(`SELECT COUNT(*)::int AS n FROM skills`))[0].n).toBe(AGENT_SKILL_COUNT + 4);
    await adm('PUT', `/api/v1/admin/tenants/${legacyTenant.id}/skills/anuclaw-genomics`, {}); // restore for later tests
  });

  // ── the gate on the existing skill-run endpoints ─────────────────────────────────────────────

  it('an assigned skill runs; an unassigned, unknown or traversal-style skill id is refused with the same answer and never reaches the agent', async () => {
    runAgentMock.mockClear();
    const t = await newTenant('Synthetic Gate Co');
    const ok = await asTenant(legacyTenant.key, 'POST', '/api/v1/skills/anuclaw-genomics/run', { prompt: 'synthetic task' });
    expect(ok.status).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0][0].prompt).toContain('You are running the anuclaw-genomics skill');

    runAgentMock.mockClear();
    for (const id of ['anuclaw-genomics', 'does-not-exist', '..%2f..%2fetc', 'ANUCLAW-GENOMICS', 'x'.repeat(80)]) {
      const r = await asTenant(t.key, 'POST', `/api/v1/skills/${id}/run`, { prompt: 'synthetic task' });
      expect(r.status, id).toBe(403);
      const b = await r.json();
      expect(b.code, id).toBe('skill_not_assigned');
      expect(JSON.stringify(b), id).not.toMatch(/available|anuclaw-/); // the old response listed every skill name
    }
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('the body-style endpoint is gated identically and rejects a non-string skill', async () => {
    runAgentMock.mockClear();
    const t = await newTenant('Synthetic Body Co');
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/run', { skill: 'anuclaw-genomics', prompt: 'x' })).status).toBe(403);
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/run', { skill: { $ne: 1 }, prompt: 'x' })).status).toBe(400);
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/run', { prompt: 'x' })).status).toBe(400);
    expect((await asTenant(legacyTenant.key, 'POST', '/api/v1/skills/run', { skill: 'anuclaw-genomics', prompt: 'x' })).status).toBe(200);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('the gate answers before the request body is looked at (a missing prompt does not reveal anything to an unassigned tenant)', async () => {
    const t = await newTenant('Synthetic Order Co');
    const r = await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-genomics/run', {});
    expect(r.status).toBe(403);
    const mine = await asTenant(legacyTenant.key, 'POST', '/api/v1/skills/anuclaw-genomics/run', {});
    expect(mine.status).toBe(400);
  });

  it('a refused call costs the tenant nothing (no quota, no usage record, no agent slot) while a successful call still counts', async () => {
    const t = await newTenant('Synthetic Cost Co');
    const usage = async () => ({
      month: Number((await q('SELECT usage_this_month AS n FROM tenants WHERE tenant_id = $1', [t.id]))[0].n),
      logged: Number((await q('SELECT COUNT(*)::int AS n FROM api_usage_log WHERE tenant_id = $1', [t.id]))[0].n),
      leases: Number((await q(`SELECT COUNT(*)::int AS n FROM run_leases WHERE key LIKE $1`, [`%${t.id}%`]))[0].n),
    });
    const before = await usage();
    // Many refused calls, fired together: none may be throttled by the concurrency limit or counted.
    const refused = await Promise.all(Array.from({ length: 12 }, () => asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-genomics/run', { prompt: 'x' })));
    for (const r of refused) expect(r.status).toBe(403);
    expect(await usage()).toEqual(before);

    await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-genomics`, {});
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-genomics/run', { prompt: 'x' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100)); // usage is recorded when the response finishes
    const after = await usage();
    expect(after.month + after.logged).toBeGreaterThan(before.month + before.logged);
  });

  it('assign, run, unassign: each takes effect immediately and each is audited', async () => {
    runAgentMock.mockClear();
    const t = await newTenant('Synthetic Assign Co');
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-protein/run', { prompt: 'x' })).status).toBe(403);

    const put = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-protein`, { config: { note: 'pilot' } });
    expect(put.status).toBe(201);
    expect((await put.json()).created).toBe(true);
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-protein/run', { prompt: 'x' })).status).toBe(200);
    expect((await (await asTenant(t.key, 'GET', '/api/v1/skills')).json()).skills.map((s: any) => s.name)).toEqual(['anuclaw-protein']);

    await adm('DELETE', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-protein`);
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-protein/run', { prompt: 'x' })).status).toBe(403);
    expect(await auditTypes(t.id)).toEqual(['tenant.created', 'tenant.skill.assigned', 'tenant.skill.unassigned']);
  });

  it('a disabled assignment, or a globally disabled skill, stops the run and hides it from the tenant list', async () => {
    const t = await newTenant('Synthetic Disable Co');
    await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-lab-xr`, {});
    await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-lab-xr`, { enabled: false });
    const r1 = await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-lab-xr/run', { prompt: 'x' });
    expect(r1.status).toBe(403);
    expect((await r1.json()).code).toBe('skill_not_assigned');

    await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-lab-xr`, { enabled: true });
    expect((await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-lab-xr/run', { prompt: 'x' })).status).toBe(200);

    expect((await adm('PATCH', '/api/v1/admin/skills/anuclaw-lab-xr', { enabled: false })).status).toBe(200);
    const r2 = await asTenant(t.key, 'POST', '/api/v1/skills/anuclaw-lab-xr/run', { prompt: 'x' });
    expect(r2.status).toBe(403);
    expect((await r2.json()).code).toBe('skill_disabled');
    expect((await (await asTenant(t.key, 'GET', '/api/v1/skills')).json()).skills).toEqual([]);
    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-lab-xr`, {})).status).toBe(409); // cannot assign a disabled skill
    await adm('PATCH', '/api/v1/admin/skills/anuclaw-lab-xr', { enabled: true });
  });

  it('tenants are isolated: one tenant\'s assignment grants nothing to another', async () => {
    const a = await newTenant('Synthetic IsoA'); const b = await newTenant('Synthetic IsoB');
    await adm('PUT', `/api/v1/admin/tenants/${a.id}/skills/anuclaw-regulatory`, {});
    expect((await asTenant(a.key, 'POST', '/api/v1/skills/anuclaw-regulatory/run', { prompt: 'x' })).status).toBe(200);
    expect((await asTenant(b.key, 'POST', '/api/v1/skills/anuclaw-regulatory/run', { prompt: 'x' })).status).toBe(403);
    expect(await auditTypes(b.id)).toEqual(['tenant.created']);
  });

  // ── administrator API: the registry ──────────────────────────────────────────────────────────

  it('the admin plane requires the admin key and lists skills with their tenant counts and the adapter slots', async () => {
    expect((await fetch(`${base}/api/v1/admin/skills`)).status).toBe(401);
    const list = await (await adm('GET', '/api/v1/admin/skills')).json();
    const genomics = list.skills.find((s: any) => s.skill_id === 'anuclaw-genomics');
    expect(genomics.kind).toBe('agent');
    expect(genomics.tenants_assigned).toBeGreaterThanOrEqual(1);
    const ad = (await (await adm('GET', '/api/v1/admin/adapters')).json()).adapters;
    expect(ad.map((x: any) => x.id)).toEqual(expect.arrayContaining(['beaive-v1', 'posturepulse-v1']));
  });

  it('registers an interpretation skill from a valid manifest; refuses duplicates, invalid manifests and agent-style ids', async () => {
    const ok = await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'vitals-extra' }) });
    expect(ok.status).toBe(201);
    expect((await ok.json()).skill).toMatchObject({ skill_id: 'vitals-extra', kind: 'interpretation', enabled: true, version: '1.0.0' });
    const dup = await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'vitals-extra' }) });
    expect(dup.status).toBe(409); expect((await dup.json()).error.code).toBe('skill_exists');
    const clash = await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'anuclaw-genomics' }) });
    expect(clash.status).toBe(409); // cannot shadow an agent skill

    const bad = await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'bad one', adapterId: 'nope', surprise: true }) });
    expect(bad.status).toBe(400);
    const e = await bad.json();
    expect(e.error.code).toBe('invalid_manifest');
    expect(e.error.message).toMatch(/unknown field "surprise"/);
    expect(e.error.message).toMatch(/unknown adapterId/);
    expect((await adm('POST', '/api/v1/admin/skills', {})).status).toBe(400);
  });

  it('a manifest change needs a new version of the same skill; agent skills have no manifest to change', async () => {
    await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'versioned-skill' }) });
    const same = await adm('PATCH', '/api/v1/admin/skills/versioned-skill', { manifest: manifest({ id: 'versioned-skill' }) });
    expect(same.status).toBe(400); expect((await same.json()).error.code).toBe('version_unchanged');
    const wrongId = await adm('PATCH', '/api/v1/admin/skills/versioned-skill', { manifest: manifest({ id: 'another-id', version: '2.0.0' }) });
    expect(wrongId.status).toBe(400);
    const next = await adm('PATCH', '/api/v1/admin/skills/versioned-skill', { manifest: manifest({ id: 'versioned-skill', version: '2.0.0', title: 'Second' }) });
    expect(next.status).toBe(200);
    expect((await next.json()).skill).toMatchObject({ version: '2.0.0', title: 'Second' });
    expect((await adm('PATCH', '/api/v1/admin/skills/anuclaw-genomics', { manifest: manifest({ id: 'anuclaw-genomics', version: '9.9.9' }) })).status).toBe(400);
    expect((await adm('PATCH', '/api/v1/admin/skills/versioned-skill', {})).status).toBe(400);
    expect((await adm('PATCH', '/api/v1/admin/skills/versioned-skill', { enabled: 'yes' })).status).toBe(400);
    expect((await adm('PATCH', '/api/v1/admin/skills/no-such-skill', { enabled: false })).status).toBe(404);
    expect((await adm('PATCH', '/api/v1/admin/skills/BAD%20ID', { enabled: false })).status).toBe(404);
  });

  it('registry changes are recorded on the platform audit chain, which verifies', async () => {
    const { readTenantAudit } = await import('../tenancy/audit');
    const { entries, verification } = await readTenantAudit(registry.PLATFORM_AUDIT_ID);
    expect(verification.valid).toBe(true);
    const types = entries.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['skill.registered', 'skill.updated']));
    const updated = entries.find((e) => e.event_type === 'skill.updated' && (e.payload as any).skill_id === 'versioned-skill')!;
    expect((updated.payload as any).before.version).toBe('1.0.0');
    expect((updated.payload as any).after.version).toBe('2.0.0');
  });

  // ── assignment rules ─────────────────────────────────────────────────────────────────────────

  it('an interpretation skill cannot be assigned while its adapter is not implemented; once it is, it can', async () => {
    makeBeaiveUnavailable();
    const t = await newTenant('Synthetic Adapter Co');
    const refused = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/physiological-signal-interpretation`, {});
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('adapter_not_available');
    expect(await q(`SELECT 1 FROM tenant_skills WHERE tenant_id = $1`, [t.id])).toHaveLength(0);

    makeBeaiveAvailable();
    try {
      const ok = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/physiological-signal-interpretation`, {});
      expect(ok.status).toBe(201);
      const tenant = await (await import('../../api/tenant-store')).getTenantById(t.id);
      const access = await registry.checkSkillAccess(tenant!, 'physiological-signal-interpretation');
      expect(access.ok).toBe(true);
      makeBeaiveUnavailable(); // the adapter goes away: an existing assignment stops working rather than failing oddly
      expect(await registry.checkSkillAccess(tenant!, 'physiological-signal-interpretation')).toMatchObject({ ok: false, status: 503, code: 'skill_unavailable' });
    } finally { makeBeaiveUnavailable(); }
  });

  it('an interpretation skill is not runnable through the agent endpoint (400 not_an_agent_skill)', async () => {
    makeBeaiveAvailable();
    try {
      const t = await newTenant('Synthetic Kind Co');
      await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/physiological-signal-interpretation`, {});
      const r = await asTenant(t.key, 'POST', '/api/v1/skills/physiological-signal-interpretation/run', { prompt: 'x' });
      expect(r.status).toBe(400);
      expect((await r.json()).code).toBe('not_an_agent_skill');
      expect((await (await asTenant(t.key, 'GET', '/api/v1/skills')).json()).skills).toEqual([]); // agent list excludes it
    } finally { makeBeaiveUnavailable(); }
  });

  it('re-assigning updates (200, created:false, audited as an update); config and ids are validated', async () => {
    const t = await newTenant('Synthetic Upsert Co');
    const first = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { config: { a: 1 } });
    expect(first.status).toBe(201);
    const again = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { config: { a: 2 }, enabled: false });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, assignment: { enabled: false, config: { a: 2 } } });
    expect(await auditTypes(t.id)).toEqual(['tenant.created', 'tenant.skill.assigned', 'tenant.skill.updated']);

    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { config: [1, 2] })).status).toBe(400);
    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { config: { big: 'x'.repeat(5000) } })).status).toBe(400);
    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { enabled: 'no' })).status).toBe(400);
    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/not-a-skill`, {})).status).toBe(404);
    expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/BAD%20ID`, {})).status).toBe(404);
    expect((await adm('PUT', `/api/v1/admin/tenants/${crypto.randomUUID()}/skills/anuclaw-clinical`, {})).status).toBe(404);
    expect((await adm('DELETE', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-protein`)).status).toBe(404); // never assigned
    expect((await adm('GET', `/api/v1/admin/tenants/${crypto.randomUUID()}/skills`)).status).toBe(404);
    const list = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/skills`)).json();
    expect(list.skills.map((s: any) => s.skill.skill_id)).toEqual(['anuclaw-clinical']);
  });

  it('configuration VALUES never reach the audit chain (only the key names)', async () => {
    const t = await newTenant('Synthetic Secret Co');
    await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, { config: { webhook_token: 'super-secret-config-value' } });
    const audit = JSON.stringify(await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json());
    expect(audit).not.toContain('super-secret-config-value');
    expect(audit).toContain('webhook_token');
  });

  // ── tiers ────────────────────────────────────────────────────────────────────────────────────

  it('a clinical-tier skill needs the clinical scope, an active BAA and the enabled domain — at assignment AND at every use', async () => {
    makeBeaiveAvailable();
    try {
      await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'cardio-clinical', riskTier: 'clinical', clinicalDomain: 'cardiometabolic' }) });
      const t = await newTenant('Synthetic Clinical Co');
      const refused = await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/cardio-clinical`, {});
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe('clinical_access_required');

      const wrongDomain = await adm('POST', `/api/v1/admin/tenants/${t.id}/clinical-grant`, { domains: ['oncology'] });
      expect(wrongDomain.status).toBe(200);
      expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/cardio-clinical`, {})).status).toBe(409); // right scope + BAA, wrong domain

      await adm('POST', `/api/v1/admin/tenants/${t.id}/clinical-grant`, { domains: ['oncology', 'cardiometabolic'] });
      expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/cardio-clinical`, {})).status).toBe(201);
      const store = await import('../../api/tenant-store');
      expect((await registry.checkSkillAccess((await store.getTenantById(t.id))!, 'cardio-clinical')).ok).toBe(true);

      await adm('POST', `/api/v1/admin/tenants/${t.id}/baa`, { status: 'expired' }); // the BAA lapses after assignment
      expect(await registry.checkSkillAccess((await store.getTenantById(t.id))!, 'cardio-clinical')).toMatchObject({ ok: false, status: 403, code: 'clinical_access_required' });
    } finally { makeBeaiveUnavailable(); }
  });

  it('a skill that requires release is refused at use even when assigned (fail closed; no release mechanism exists yet)', async () => {
    makeBeaiveAvailable();
    try {
      await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'needs-release', requiresRelease: true }) });
      const t = await newTenant('Synthetic Release Co');
      expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/needs-release`, {})).status).toBe(201);
      const tenant = await (await import('../../api/tenant-store')).getTenantById(t.id);
      expect(await registry.checkSkillAccess(tenant!, 'needs-release')).toMatchObject({ ok: false, status: 403, code: 'skill_not_released' });
    } finally { makeBeaiveUnavailable(); }
  });

  // ── integrity ────────────────────────────────────────────────────────────────────────────────

  it('simultaneous assignments to one tenant all succeed and keep the audit chain contiguous and valid', async () => {
    const t = await newTenant('Synthetic Race Co');
    const ids = ['anuclaw-clinical', 'anuclaw-protein', 'anuclaw-genomics', 'anuclaw-regulatory', 'anuclaw-lab-xr', 'anuclaw-digital-twin'];
    const results = await Promise.all(ids.map((id) => adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/${id}`, {})));
    for (const r of results) expect(r.status).toBe(201);
    const audit = await (await adm('GET', `/api/v1/admin/tenants/${t.id}/audit`)).json();
    expect(audit.chain.valid).toBe(true);
    expect(audit.entries.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('if the audit entry cannot be written, the assignment is rolled back', async () => {
    const t = await newTenant('Synthetic Atomic Co');
    await q('ALTER TABLE cds_audit_log_mt RENAME TO cds_audit_log_mt_broken');
    try {
      expect((await adm('PUT', `/api/v1/admin/tenants/${t.id}/skills/anuclaw-clinical`, {})).status).toBe(500);
      expect((await adm('POST', '/api/v1/admin/skills', { manifest: manifest({ id: 'ghost-skill' }) })).status).toBe(500);
    } finally { await q('ALTER TABLE cds_audit_log_mt_broken RENAME TO cds_audit_log_mt'); }
    expect(await q(`SELECT 1 FROM tenant_skills WHERE tenant_id = $1`, [t.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM skills WHERE skill_id = 'ghost-skill'`)).toHaveLength(0);
  });

  it('a skill that is in use cannot be deleted out from under tenants (no delete path; the table enforces it)', async () => {
    await expect(q(`DELETE FROM skills WHERE skill_id = 'anuclaw-genomics'`)).rejects.toThrow(/foreign key|violates/i);
  });

  it('refuses to start grandfathering when no agent skills are found, so a wrong working directory cannot burn the one-time step', async () => {
    const isolatedName = `anuclaw_skl_empty_${crypto.randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${isolatedName}`);
    const saved = { db: process.env.PG_DATABASE, dir: process.env.ANUCLAW_SKILLS_DIR };
    try {
      process.env.PG_DATABASE = isolatedName; process.env.ANUCLAW_SKILLS_DIR = '/nonexistent-skills-dir';
      vi.resetModules();
      const conn = await import('../../db/connection');
      await conn.ensureDbReady();
      const store = await import('../../api/tenant-store');
      const t = await store.registerTenant('Synthetic Empty Co', 'empty@synthetic.invalid');
      const reg = await import('./registry');
      await reg.ensureSkillRegistry();
      const { db } = await import('../../db');
      expect(await db.query(`SELECT 1 FROM registry_state WHERE key = 'grandfather_agent_skills_v1'`)).toHaveLength(0); // marker NOT burned
      expect(await db.query(`SELECT 1 FROM tenant_skills WHERE tenant_id = $1`, [t.tenant_id])).toHaveLength(0);
      await conn.getDb().end();
    } finally {
      process.env.PG_DATABASE = saved.db!; if (saved.dir === undefined) delete process.env.ANUCLAW_SKILLS_DIR; else process.env.ANUCLAW_SKILLS_DIR = saved.dir;
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [isolatedName]);
      await admin.query(`DROP DATABASE IF EXISTS ${isolatedName}`);
    }
  });
});
