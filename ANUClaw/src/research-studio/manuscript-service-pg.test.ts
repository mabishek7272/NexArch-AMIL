/** Manuscript/thesis persistence (real PostgreSQL): append-only sections, the "current" content rule (accepted
 * direct writes vs. accepted editorial proposals vs. rejected proposals that never become current), comments,
 * author decisions, section-claim links, and task-triggered invalidation. Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio manuscript service (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsms_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let ms: typeof import('./manuscript-service'); let evidence: typeof import('./evidence-service');
  let projectId: string; const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady(); const { db } = await import('../db');
    ms = await import('./manuscript-service'); evidence = await import('./evidence-service');
    projectId = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [projectId, userId, 'research_protocol', 'Manuscript service test', 'draft', '{}', 'x', Date.now()]);
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  it('sections are append-only and versioned per key; a direct "accepted" write is immediately current', async () => {
    const v1 = await ms.createSection(projectId, userId, { sectionKey: 'intro', kind: 'section', title: 'Introduction', contentText: 'v1 text', contentSource: 'human' });
    expect(v1.version).toBe(1); expect(v1.status).toBe('accepted');
    const v2 = await ms.createSection(projectId, userId, { sectionKey: 'intro', kind: 'section', title: 'Introduction', contentText: 'v2 text', contentSource: 'human' });
    expect(v2.version).toBe(2);
    const current = await ms.currentSections(projectId, userId);
    expect(current.find((s) => s.section_key === 'intro')?.content_text).toBe('v2 text');
    expect((await ms.listSectionVersions(projectId, userId, 'intro')).length).toBe(2); // full history kept
  });

  it('an editorial PROPOSAL does not become current until accepted; a rejected one never does', async () => {
    const base = await ms.createSection(projectId, userId, { sectionKey: 'methods', kind: 'section', title: 'Methods', contentText: 'original methods text', contentSource: 'human' });
    const proposal = await ms.createSection(projectId, userId, { sectionKey: 'methods', kind: 'section', title: 'Methods', contentText: 'edited methods text', contentSource: 'editorial_proposal', status: 'proposed', parentVersionId: base.id });
    let current = await ms.currentSections(projectId, userId);
    expect(current.find((s) => s.section_key === 'methods')?.content_text).toBe('original methods text'); // proposal not yet decided
    await expect(ms.decideSection(projectId, proposal.id, userId, 'accepted', null)).resolves.toBeDefined();
    current = await ms.currentSections(projectId, userId);
    expect(current.find((s) => s.section_key === 'methods')?.content_text).toBe('edited methods text');
    await expect(ms.decideSection(projectId, proposal.id, userId, 'rejected', 'changed my mind')).rejects.toThrow(/already has a decision/);

    const rejectedProposal = await ms.createSection(projectId, userId, { sectionKey: 'methods', kind: 'section', title: 'Methods', contentText: 'a WORSE edit', contentSource: 'editorial_proposal', status: 'proposed', parentVersionId: proposal.id });
    await ms.decideSection(projectId, rejectedProposal.id, userId, 'rejected', 'worse than current');
    current = await ms.currentSections(projectId, userId);
    expect(current.find((s) => s.section_key === 'methods')?.content_text).toBe('edited methods text'); // the rejected proposal never became current
  });

  it('comments attach to a specific section version and are listed in order', async () => {
    const s = await ms.createSection(projectId, userId, { sectionKey: 'discussion', kind: 'section', title: 'Discussion', contentText: 'text', contentSource: 'human' });
    await ms.addComment(projectId, s.id, userId, 'first comment');
    await ms.addComment(projectId, s.id, userId, 'second comment');
    const comments = await ms.listComments(s.id, projectId, userId);
    expect(comments.map((c) => c.body)).toEqual(['first comment', 'second comment']);
  });

  it('a section can be linked to a claim, and a non-existent claim/section is refused', async () => {
    const s = await ms.createSection(projectId, userId, { sectionKey: 'results', kind: 'section', title: 'Results', contentText: 'text', contentSource: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'A claim the results section cites');
    const link = await ms.linkSectionClaim(projectId, s.id, claim.id);
    expect((await ms.listSectionClaims(s.id, projectId)).map((l) => l.id)).toEqual([link.id]);
    await expect(ms.linkSectionClaim(projectId, s.id, crypto.randomUUID())).rejects.toThrow(/not found/);
  });

  it('invalidateSectionsForTasks flags sections produced by the given tasks, and only those', async () => {
    const taskId = crypto.randomUUID();
    const tagged = await ms.createSection(projectId, userId, { sectionKey: 'tagged', kind: 'section', title: 'Tagged', contentText: 'x', contentSource: 'human', taskId });
    const untagged = await ms.createSection(projectId, userId, { sectionKey: 'untagged', kind: 'section', title: 'Untagged', contentText: 'x', contentSource: 'human' });
    const flagged = await ms.invalidateSectionsForTasks([taskId], 'evidence changed');
    expect(flagged).toEqual([tagged.id]);
    expect((await ms.getSection(tagged.id, projectId))?.invalidated_at).not.toBeNull();
    expect((await ms.getSection(untagged.id, projectId))?.invalidated_at).toBeNull();
  });
});
