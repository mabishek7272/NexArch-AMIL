/** The four M2 agents (Literature Scout, Source Verifier, Evidence Extractor, Evidence Matrix Builder) running through
 * the REAL orchestrator against real PostgreSQL, with an injected fake Crossref fetcher (no network). Covers the
 * acceptance fixtures: fabricated/unresolvable identifier, mismatched metadata, correction/retraction, budget
 * exhaustion, and the full brief → search → verify → extract → matrix pipeline. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M2 agents (real PostgreSQL, fake connector)', () => {
  const dbName = `anuclaw_rsa_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let store: typeof import('./task-store'); let orchestrator: typeof import('./orchestrator'); let evidence: typeof import('./evidence-service');
  let registry: typeof import('./agent-registry'); let lit: typeof import('./agents/literature-scout'); let ver: typeof import('./agents/source-verifier');
  let CrossrefConnector: typeof import('./connectors/crossref').CrossrefConnector;
  let registerAll: typeof import('./register-all-agents').registerAllResearchStudioAgents;
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady();
    store = await import('./task-store'); orchestrator = await import('./orchestrator'); evidence = await import('./evidence-service'); registry = await import('./agent-registry');
    lit = await import('./agents/literature-scout'); ver = await import('./agents/source-verifier');
    CrossrefConnector = (await import('./connectors/crossref')).CrossrefConnector;
    registerAll = (await import('./register-all-agents')).registerAllResearchStudioAgents;
    registry.clearRegistry(); registerAll();
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });
  afterEach(() => { lit.setConnectorForTesting(null); ver.setConnectorForTesting(null); delete process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR; });

  async function newProject(mode = 'narrative_review', brief: Record<string, unknown> = {}): Promise<string> {
    const { db } = await import('../db'); const id = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [id, userId, mode, 'M2 agent test', 'draft', JSON.stringify(brief), 'x', Date.now()]);
    return id;
  }
  const WORK = (over: Record<string, unknown> = {}) => ({ DOI: '10.1234/found', title: ['A Found Study'], author: [{ given: 'A', family: 'Author' }], 'published-print': { 'date-parts': [[2022]] }, 'container-title': ['J'], type: 'journal-article', ...over });
  function fakeFetcher(handler: (url: string) => { status: number; body: unknown } | Error) {
    return { async request(url: string) { const r = handler(url); if (r instanceof Error) throw r; return { status: r.status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(r.body)), finalUrl: url, attempts: 1 }; } };
  }

  it('literature.search_strategy derives a strategy from the brief deterministically, no network', async () => {
    const projectId = await newProject('narrative_review', { topic: 'T', question: 'Q', searchMethod: 'manual PubMed search' });
    const task = await store.createTask(projectId, { type: 'literature.search_strategy' });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('completed');
    expect((await store.getTask(task.id))?.status).toBe('completed');
  });

  it('literature.search_execute without the live flag asks the user, rather than silently falling back to a paid model', async () => {
    const projectId = await newProject('narrative_review', { topic: 'T', question: 'Q', searchMethod: 'm' });
    await store.createTask(projectId, { type: 'literature.search_strategy' });
    await orchestrator.tick(projectId);
    await store.createTask(projectId, { type: 'literature.search_execute' });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('awaiting_user');
  });

  it('literature.search_execute with an injected connector creates REAL sources via the orchestrator, bounded by the task budget', async () => {
    process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR = '1';
    lit.setConnectorForTesting(new CrossrefConnector({ fetcher: fakeFetcher(() => ({ status: 200, body: { message: { items: [WORK()], 'total-results': 1 } } })) }));
    const projectId = await newProject('narrative_review', { topic: 'T', question: 'Q', searchMethod: 'm' });
    await store.createTask(projectId, { type: 'literature.search_strategy' }); await orchestrator.tick(projectId);
    const task = await store.createTask(projectId, { type: 'literature.search_execute', budget: { maxActions: 10 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('completed');
    const sources = await evidence.listSources(projectId, userId);
    expect(sources.some((s) => s.doi === '10.1234/found')).toBe(true);
    void task;
  });

  it('a task action budget of 0 fails the search-execute task closed instead of silently calling the connector anyway', async () => {
    process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR = '1';
    lit.setConnectorForTesting(new CrossrefConnector({ fetcher: fakeFetcher(() => ({ status: 200, body: { message: { items: [WORK()] } } })) }));
    const projectId = await newProject('narrative_review', { topic: 'T', question: 'Q', searchMethod: 'm' });
    await store.createTask(projectId, { type: 'literature.search_strategy' }); await orchestrator.tick(projectId);
    await store.createTask(projectId, { type: 'literature.search_execute', budget: { maxActions: 0 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('failed');
  });

  it('source-verifier: a fabricated/unresolvable DOI is marked "mismatch" (a verification FAILURE, never silently "unknown")', async () => {
    process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR = '1';
    ver.setConnectorForTesting(new CrossrefConnector({ fetcher: fakeFetcher(() => ({ status: 404, body: {} })) }));
    const projectId = await newProject('research_protocol');
    await evidence.createSource(projectId, userId, { doi: '10.9999/fabricated-does-not-exist', title: 'A Fabricated Reference', importProvenance: {} });
    await store.createTask(projectId, { type: 'literature.verify_sources', budget: { maxActions: 5 } });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('completed');
    const sources = await evidence.listSources(projectId, userId);
    expect(sources.find((s) => s.doi === '10.9999/fabricated-does-not-exist')?.metadata_verification_status).toBe('mismatch');
  });

  it('source-verifier: resolving metadata that does not match what was stated is "mismatch"; a true match is "verified"; retraction is recorded', async () => {
    process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR = '1';
    ver.setConnectorForTesting(new CrossrefConnector({ fetcher: fakeFetcher((url) => {
      if (url.includes('mismatched')) return { status: 200, body: { message: WORK({ DOI: '10.1234/mismatched', title: ['A Completely Different Paper About Something Else'], 'published-print': { 'date-parts': [[1999]] } }) } };
      if (url.includes('retracted')) return { status: 200, body: { message: WORK({ DOI: '10.1234/retracted', title: ['A Retracted Study'], 'update-to': [{ type: 'retraction' }] }) } };
      return { status: 200, body: { message: WORK({ DOI: '10.1234/match', title: ['A Found Study'] }) } };
    }) }));
    const projectId = await newProject('research_protocol');
    await evidence.createSource(projectId, userId, { doi: '10.1234/match', title: 'A Found Study', year: 2022, importProvenance: {} });
    await evidence.createSource(projectId, userId, { doi: '10.1234/mismatched', title: 'What I Think This Paper Is Called', importProvenance: {} });
    await evidence.createSource(projectId, userId, { doi: '10.1234/retracted', title: 'A Retracted Study', importProvenance: {} });
    await store.createTask(projectId, { type: 'literature.verify_sources', budget: { maxActions: 10 } });
    await orchestrator.tick(projectId);
    const sources = await evidence.listSources(projectId, userId);
    expect(sources.find((s) => s.doi === '10.1234/match')?.metadata_verification_status).toBe('verified');
    expect(sources.find((s) => s.doi === '10.1234/mismatched')?.metadata_verification_status).toBe('mismatch');
    const retracted = sources.find((s) => s.doi === '10.1234/retracted');
    expect(retracted?.correction_status).toBe('retracted');
  });

  it('source-verifier without the live flag still honestly marks DOI-less sources "unverified" and leaves DOI-bearing ones "unknown" (never guessed)', async () => {
    const projectId = await newProject('research_protocol');
    await evidence.createSource(projectId, userId, { title: 'No identifier at all', importProvenance: {} });
    await evidence.createSource(projectId, userId, { doi: '10.1234/needs-connector', title: 'Has a DOI', importProvenance: {} });
    await store.createTask(projectId, { type: 'literature.verify_sources' });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('awaiting_user');
    const sources = await evidence.listSources(projectId, userId);
    expect(sources.find((s) => s.title === 'No identifier at all')?.metadata_verification_status).toBe('unverified');
    expect(sources.find((s) => s.title === 'Has a DOI')?.metadata_verification_status).toBe('unknown');
  });

  it('evidence.extract asks for human-supplied excerpts, then creates them once resolved via the existing awaiting_user mechanism — never fabricating a reading of the paper', async () => {
    const projectId = await newProject('research_protocol');
    const s = await evidence.createSource(projectId, userId, { title: 'Extract Test', importProvenance: {} });
    const task = await store.createTask(projectId, { type: 'evidence.extract' });
    const r1 = await orchestrator.tick(projectId);
    expect(r1.outcome).toBe('awaiting_user');
    await store.resolveAwaitingUser(task.id, { excerpts: [{ sourceId: s.source.id, locator: { page: 1 }, text: 'a real excerpt from a real page' }] });
    const r2 = await orchestrator.tick(projectId);
    expect(r2.outcome).toBe('completed');
    expect((await evidence.listExcerpts(projectId, userId, s.source.id)).length).toBe(1);
  });

  it('evidence.build_matrix deterministically aggregates claims/excerpts/sources with no model call', async () => {
    const projectId = await newProject('research_protocol');
    const s = await evidence.createSource(projectId, userId, { title: 'Matrix Test', importProvenance: {} });
    const ex = await evidence.createExcerpt(projectId, s.source.id, userId, { locator: { page: 1 }, text: 'evidence', extractedBy: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'Some claim');
    await evidence.linkClaimEvidence(projectId, userId, claim.id, ex.id, 'supports', 'supported');
    await store.createTask(projectId, { type: 'evidence.build_matrix' });
    const r = await orchestrator.tick(projectId);
    expect(r.outcome).toBe('completed');
    const matrix = await evidence.latestEvidenceMatrix(projectId, userId);
    const parsed = JSON.parse(matrix!.matrix_json);
    expect(parsed.rows[0]).toMatchObject({ claimId: claim.id, overallStatus: 'supported' });
  });
});
