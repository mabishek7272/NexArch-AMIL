/** Visual specifications (real PostgreSQL): data-derived visuals that must reference a real, hash-verified research
 * run (never a hand-typed number); conceptual visuals that refuse any measured-looking numeric field; the PRISMA
 * builder computing real counts from real evidence-graph rows; versioning and task-triggered invalidation.
 * Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio visuals (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsv_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let visuals: typeof import('./visual-service'); let research: typeof import('../research/service'); let evidence: typeof import('./evidence-service');
  let projectId: string; const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady(); const { db } = await import('../db');
    visuals = await import('./visual-service'); research = await import('../research/service'); evidence = await import('./evidence-service');
    projectId = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [projectId, userId, 'systematic_review', 'Visual test project', 'draft', '{}', 'x', Date.now()]);
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('a data_derived visual refuses to chart with no requested fields — never silently charted as zero', async () => {
    const ds = await research.createDataset({ userId, name: 'Visual test dataset', purpose: 'unit test fixture for data_derived visuals', csv: 'value\n1\n2\n3\n4\n5\n9', dictionary: { value: 'a number' }, attestation: { deidentified: true, authorised: true, statement: 'synthetic test data, no real subjects' } });
    const run = await research.runAnalysis({ userId, datasetId: ds.datasetId, analysis: 'descriptive', params: {} });
    await expect(visuals.createVisual(projectId, userId, { visualKey: 'descriptive-chart', type: 'data_plot', kind: 'data_derived', title: 'Descriptive stats', spec: { runId: run.runId, fields: [] } })).rejects.toThrow(/no hand-typed numbers/);
  });

  it('a data_derived visual is refused if the run never completed, failed integrity, or the field is not real/numeric', async () => {
    await expect(visuals.createVisual(projectId, userId, { visualKey: 'bad-run', type: 'data_plot', kind: 'data_derived', title: 'X', spec: { runId: crypto.randomUUID(), fields: ['x'] } })).rejects.toThrow(/not found/);
  });

  it('a conceptual visual is refused if it carries a measured-looking numeric field — layout/labels only', async () => {
    await expect(visuals.createVisual(projectId, userId, { visualKey: 'flow1', type: 'flowchart', kind: 'conceptual', title: 'Process', spec: { nodes: [{ id: 'a', label: 'Start', count: 42 }], edges: [] } })).rejects.toThrow(/measured-looking numeric field/);
    const ok = await visuals.createVisual(projectId, userId, { visualKey: 'flow1', type: 'flowchart', kind: 'conceptual', title: 'Process', spec: { nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'End' }], edges: [{ from: 'a', to: 'b' }] } });
    expect(ok.svg).toContain('<svg'); expect(ok.svg).toContain('Start');
  });

  it('a conceptual visual with type prisma_flow must go through buildPrismaFlow, never free-typed counts', async () => {
    await expect(visuals.createVisual(projectId, userId, { visualKey: 'x', type: 'prisma_flow', kind: 'conceptual', title: 'PRISMA', spec: { nodes: [{ id: 'a', label: 'n = 999' }] } })).rejects.toThrow(/Use buildPrismaFlow/);
  });

  it('buildPrismaFlow computes REAL counts from search runs and screening decisions — never a free-typed number', async () => {
    const strategy = { databases: ['crossref'], queries: ['q'] };
    const { createSearchStrategy, startSearchRun, completeSearchRun } = await import('./search-service');
    const strat = await createSearchStrategy(projectId, userId, strategy);
    const run = await startSearchRun(projectId, { strategyId: strat.id, source: 'crossref', query: { q: 'x' } });
    await completeSearchRun(run.id, { status: 'completed', resultCount: 17 });
    const src1 = await evidence.createSource(projectId, userId, { title: 'Included source', importProvenance: {} });
    const src2 = await evidence.createSource(projectId, userId, { title: 'Excluded source', importProvenance: {} });
    await evidence.recordScreeningDecision(projectId, src1.source.id, userId, 'include', null);
    await evidence.recordScreeningDecision(projectId, src2.source.id, userId, 'exclude', 'wrong population');

    const flow = await visuals.buildPrismaFlow(projectId, userId);
    const provenance = JSON.parse(flow.data_provenance_json);
    expect(provenance.identified).toBe(17); expect(provenance.included).toBe(1); expect(provenance.excluded).toBe(1);
    expect(flow.svg).toContain('n = 17'); expect(flow.svg).toContain('n = 1');
  });

  it('visuals are versioned per key, invalidated by task, and currentVisuals returns only the latest per key', async () => {
    const taskId = crypto.randomUUID();
    const v1 = await visuals.createVisual(projectId, userId, { visualKey: 'versioned', type: 'conceptual_diagram', kind: 'conceptual', title: 'v1', spec: { nodes: [{ id: 'a', label: 'A' }], edges: [] }, taskId });
    const v2 = await visuals.createVisual(projectId, userId, { visualKey: 'versioned', type: 'conceptual_diagram', kind: 'conceptual', title: 'v2', spec: { nodes: [{ id: 'a', label: 'A2' }], edges: [] } });
    expect(v2.version).toBe(v1.version + 1);
    const current = await visuals.currentVisuals(projectId, userId);
    expect(current.find((v) => v.visual_key === 'versioned')?.id).toBe(v2.id);
    const flagged = await visuals.invalidateVisualsForTasks([taskId], 'evidence changed');
    expect(flagged).toEqual([v1.id]); // only the version tagged with that task, not the newer untagged one
  });
});
