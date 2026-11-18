/** Evidence graph persistence (real PostgreSQL): dedup proposals, screening history, excerpt/claim links, and —
 * critically — that revising a source's evidence invalidates downstream TASKS through M1's existing mechanism
 * (plan §4). Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio evidence graph (real PostgreSQL)', () => {
  const dbName = `anuclaw_rse_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let q: (s: string, p?: unknown[]) => Promise<any[]>;
  let evidence: typeof import('./evidence-service'); let search: typeof import('./search-service'); let store: typeof import('./task-store');
  let projectId: string; const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady(); const { db } = await import('../db'); q = (s, p) => db.query(s, p as any[]);
    evidence = await import('./evidence-service'); search = await import('./search-service'); store = await import('./task-store');
    projectId = crypto.randomUUID();
    await q('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [projectId, userId, 'systematic_review', 'Evidence test project', 'draft', '{}', 'x', Date.now()]);
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('search strategies are append-only and versioned', async () => {
    const v1 = await search.createSearchStrategy(projectId, userId, { databases: ['crossref'], queries: ['q1'] });
    expect(v1.version).toBe(1);
    const v2 = await search.createSearchStrategy(projectId, userId, { databases: ['crossref'], queries: ['q1', 'q2'] });
    expect(v2.version).toBe(2);
    expect((await search.listSearchStrategies(projectId, userId)).map((s) => s.version)).toEqual([1, 2]);
    expect((await search.latestSearchStrategy(projectId))?.version).toBe(2);
  });

  it('an exact duplicate (same DOI) is flagged automatically; a near-title match is only PROPOSED, never auto-merged', async () => {
    const a = await evidence.createSource(projectId, userId, { doi: '10.1234/exact', title: 'Effects of X on Y', importProvenance: { origin: 'manual' } });
    expect(a.exactDuplicateOf).toBeNull();
    const dup = await evidence.createSource(projectId, userId, { doi: '10.1234/exact', title: 'A totally different-looking title', importProvenance: { origin: 'manual' } });
    expect(dup.exactDuplicateOf).toBe(a.source.id);
    const near = await evidence.createSource(projectId, userId, { doi: '10.1234/different-but-similar-title', title: 'Effects of X on Y ', year: null, importProvenance: { origin: 'manual' } });
    expect(near.exactDuplicateOf).toBeNull(); expect(near.proposedMatches).toContain(a.source.id);
    const links = await evidence.listSourceLinks(projectId, userId);
    expect(links.some((l) => l.status === 'proposed' && l.relation === 'duplicate')).toBe(true);
  });

  it('a proposed source link is confirmed or rejected by a human decision, exactly once', async () => {
    const a = await evidence.createSource(projectId, userId, { doi: '10.1234/linka', title: 'Link Test A', importProvenance: {} });
    const b = await evidence.createSource(projectId, userId, { doi: '10.1234/linka2', title: 'Link Test A', importProvenance: {} });
    const link = (await evidence.listSourceLinks(projectId, userId)).find((l) => (l.source_id_a === b.source.id && l.source_id_b === a.source.id));
    expect(link).toBeDefined();
    const decided = await evidence.decideSourceLink(link!.id, projectId, userId, 'confirmed');
    expect(decided.status).toBe('confirmed');
    await expect(evidence.decideSourceLink(link!.id, projectId, userId, 'rejected')).rejects.toThrow(/not in a pending/);
  });

  it('an excerpt requires a locator (page/section/table/paragraph) — never trace-less evidence', async () => {
    const s = await evidence.createSource(projectId, userId, { title: 'Locator Test', importProvenance: {} });
    await expect(evidence.createExcerpt(projectId, s.source.id, userId, { locator: {}, text: 'some text', extractedBy: 'human' })).rejects.toThrow(/locator is required/);
    const ex = await evidence.createExcerpt(projectId, s.source.id, userId, { locator: { page: 3 }, text: 'some text', extractedBy: 'human' });
    expect(ex.locator_json).toContain('"page":3');
  });

  it('screening: exclude requires a reason; the "current" view returns only the LATEST decision per source', async () => {
    const s = await evidence.createSource(projectId, userId, { title: 'Screening Test', importProvenance: {} });
    await expect(evidence.recordScreeningDecision(projectId, s.source.id, userId, 'exclude', null)).rejects.toThrow(/exclusionReason is required/);
    await evidence.recordScreeningDecision(projectId, s.source.id, userId, 'include', null);
    await evidence.recordScreeningDecision(projectId, s.source.id, userId, 'exclude', 'wrong population');
    const current = (await evidence.currentScreeningDecisions(projectId, userId)).find((d) => d.source_id === s.source.id);
    expect(current?.decision).toBe('exclude'); expect(current?.exclusion_reason).toBe('wrong population');
    expect((await evidence.screeningHistory(s.source.id, projectId, userId)).length).toBe(2); // full history kept, append-only
  });

  it('a claim-evidence link starts "unresolved" unless explicitly asserted, and contradiction is never hidden by a co-existing supporting link', async () => {
    const s = await evidence.createSource(projectId, userId, { title: 'Claim Test Source', importProvenance: {} });
    const ex1 = await evidence.createExcerpt(projectId, s.source.id, userId, { locator: { page: 1 }, text: 'supports it', extractedBy: 'human' });
    const ex2 = await evidence.createExcerpt(projectId, s.source.id, userId, { locator: { page: 2 }, text: 'contradicts it', extractedBy: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'X causes Y');
    const l1 = await evidence.linkClaimEvidence(projectId, userId, claim.id, ex1.id, 'supports');
    expect(l1.claim_support_status).toBe('unresolved'); // never defaults to "supported" just because the relation is "supports"
    await evidence.linkClaimEvidence(projectId, userId, claim.id, ex2.id, 'contradicts');
    const links = await evidence.listClaimLinks(claim.id, projectId, userId);
    const excerptsById = new Map([ex1, ex2].map((e) => [e.id, e]));
    expect(evidence.summarizeClaimStatus(links, excerptsById)).toBe('contradicted');
  });

  it("reviseSourceMetadata with a material change (e.g. a retraction) invalidates the source's excerpts AND cascades to downstream TASKS via M1's invalidateDownstream — not a parallel invalidation scheme", async () => {
    const s = await evidence.createSource(projectId, userId, { doi: '10.1234/revise-me', title: 'Revision Test', importProvenance: {} });
    const extractTask = await store.createTask(projectId, { type: 'evidence.extract' });
    const claimA = await store.claimNextReady(projectId, ['evidence.extract']);
    await store.commitOutcome(claimA!.task, claimA!.token, { kind: 'completed', result: {} });
    const ex = await evidence.createExcerpt(projectId, s.source.id, userId, { locator: { page: 1 }, text: 'evidence text', extractedBy: 'deterministic', taskId: extractTask.id });

    const matrixTask = await store.createTask(projectId, { type: 'evidence.build_matrix', dependsOn: [extractTask.id] });
    const claimB = await store.claimNextReady(projectId, ['evidence.build_matrix']);
    await store.commitOutcome(claimB!.task, claimB!.token, { kind: 'completed', result: {} });
    expect((await store.getTask(matrixTask.id))?.status).toBe('completed');

    const out = await evidence.reviseSourceMetadata(s.source.id, projectId, userId, { correctionStatus: 'retracted' }, { origin: 'crossref-recheck' });
    expect(out.source.correction_status).toBe('retracted');
    expect(out.invalidatedExcerpts).toContain(ex.id);
    expect(out.invalidatedTasks).toContain(matrixTask.id); // the DOWNSTREAM task is flagged...
    const matrixAfter = await store.getTask(matrixTask.id);
    expect(matrixAfter?.status).toBe('completed'); expect(matrixAfter?.invalidated_at).not.toBeNull(); // ...kept completed, but marked stale, never silently deleted
    const exAfter = await evidence.listExcerpts(projectId, userId, s.source.id);
    expect(exAfter.find((e) => e.id === ex.id)?.invalidated_at).not.toBeNull();

    // a SECOND, non-material revision (no correctionStatus/doi/title change) must NOT invalidate anything further
    const out2 = await evidence.reviseSourceMetadata(s.source.id, projectId, userId, { metadata: { note: 'cosmetic' } }, {});
    expect(out2.invalidatedExcerpts).toEqual([]);
  });

  it('the evidence matrix builder persists a matrix and latestEvidenceMatrix returns the most recent one', async () => {
    const task = await store.createTask(projectId, { type: 'evidence.build_matrix' });
    await evidence.saveEvidenceMatrix(projectId, task.id, { rows: [] });
    const task2 = await store.createTask(projectId, { type: 'evidence.build_matrix' });
    const second = await evidence.saveEvidenceMatrix(projectId, task2.id, { rows: ['newer'] });
    const latest = await evidence.latestEvidenceMatrix(projectId, userId);
    expect(latest?.id).toBe(second.id);
  });
});
