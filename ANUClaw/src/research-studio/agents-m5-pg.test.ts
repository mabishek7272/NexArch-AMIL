/** The M5 agents (Visual Agent, Export Agent) running through the REAL orchestrator against real PostgreSQL.
 * Covers: PRISMA-flow generation through the task, the final export.manuscript task producing every real text
 * format plus a real rendered PDF, the hash-chained provenance manifest, and the real inspection catching a
 * missing citation. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M5 agents (real PostgreSQL)', () => {
  const dbName = `anuclaw_rs5_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let store: typeof import('./task-store'); let orchestrator: typeof import('./orchestrator'); let registry: typeof import('./agent-registry');
  let ms: typeof import('./manuscript-service'); let evidence: typeof import('./evidence-service'); let exportSvc: typeof import('./export-service');
  let registerAll: typeof import('./register-all-agents').registerAllResearchStudioAgents;
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady();
    store = await import('./task-store'); orchestrator = await import('./orchestrator'); registry = await import('./agent-registry');
    ms = await import('./manuscript-service'); evidence = await import('./evidence-service'); exportSvc = await import('./export-service');
    registerAll = (await import('./register-all-agents')).registerAllResearchStudioAgents;
    registry.clearRegistry(); registerAll();
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  async function newProject(mode = 'research_protocol'): Promise<string> {
    const { db } = await import('../db'); const id = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [id, userId, mode, 'M5 agent test', 'draft', '{}', 'x', Date.now()]);
    return id;
  }

  it('visuals.build creates a PRISMA flow from real evidence-graph counts through the orchestrator', async () => {
    const projectId = await newProject('systematic_review');
    const { createSearchStrategy, startSearchRun, completeSearchRun } = await import('./search-service');
    const strat = await createSearchStrategy(projectId, userId, { databases: ['crossref'], queries: ['q'] });
    const run = await startSearchRun(projectId, { strategyId: strat.id, source: 'crossref', query: {} });
    await completeSearchRun(run.id, { status: 'completed', resultCount: 5 });
    const task = await store.createTask(projectId, { type: 'visuals.build', params: { includePrisma: true } });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const { currentVisuals } = await import('./visual-service');
    const flow = (await currentVisuals(projectId, userId)).find((v) => v.visual_key === 'prisma_flow');
    expect(flow).toBeDefined(); expect(flow!.svg).toContain('n = 5');
    void task;
  }, 20_000);

  it('visuals.build with no request asks the user rather than fabricating a visual', async () => {
    const projectId = await newProject();
    await store.createTask(projectId, { type: 'visuals.build' });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('awaiting_user');
  }, 20_000);

  it('export.manuscript produces every real format, a real rendered PDF, and a real inspection that catches a missing citation', async () => {
    const projectId = await newProject();
    const section = await ms.createSection(projectId, userId, { sectionKey: 'background', kind: 'section', title: 'Background', contentText: 'This section never mentions the claim text at all.', contentSource: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'A very specific finding that should appear verbatim in the export');
    await ms.linkSectionClaim(projectId, section.id, claim.id);

    await store.createTask(projectId, { type: 'export.manuscript' });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const task = (await store.listTasks(projectId)).find((t) => t.type === 'export.manuscript')!;
    const result = JSON.parse(task.result_json!);
    expect(result.formats.sort()).toEqual(['bibtex', 'docx', 'latex', 'markdown', 'pdf', 'provenance_manifest', 'ris']);
    expect(result.inspection.citationConsistency.missing).toContain(claim.id); // the claim's text really isn't in the export
    expect(result.inspection.pagination.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.inspection.docx.wellFormed).toBe(true);

    const exports = await exportSvc.listExports(projectId, userId);
    const pdfExport = exports.find((e) => e.format === 'pdf')!;
    const pdfBytes = (await import('fs')).readFileSync(pdfExport.storage_path);
    expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // the stored file is a REAL PDF, not a stub
    const docxExport = exports.find((e) => e.format === 'docx')!;
    const docxBytes = (await import('fs')).readFileSync(docxExport.storage_path);
    expect(docxBytes.subarray(0, 2).toString('latin1')).toBe('PK'); // the stored file is a REAL Open XML package, not a renamed text file
    const { inspectDocxStructure } = await import('./export-service'); expect(inspectDocxStructure(docxBytes)).toBe(true);
    const manifestExport = exports.find((e) => e.format === 'provenance_manifest')!;
    const manifest = JSON.parse((await import('fs')).readFileSync(manifestExport.storage_path, 'utf8'));
    expect(manifest.manifestSha256).toBe(result.manifestSha256);
  }, 20_000);

  it('export.manuscript fails cleanly when there is nothing to export yet', async () => {
    const projectId = await newProject();
    await store.createTask(projectId, { type: 'export.manuscript' });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('failed');
  }, 20_000);
});
