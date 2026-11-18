/** The M4 agents (Manuscript Writer, Thesis Coordinator, Methods/Statistics, Scientific Critic, Citation Auditor,
 * Editorial Agent) running through the REAL orchestrator against real PostgreSQL. Covers: human-authored vs.
 * deterministic-digest sections, never fabricating results for original_research, the bounded critic/revision loop
 * (including hitting its cap), the Editorial Agent's tracked-change preservation checks and forbidden-param refusal,
 * and reuse of the existing, already-verified research-run artifact for Methods/Statistics. Opt-in:
 * ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M4 agents (real PostgreSQL)', () => {
  const dbName = `anuclaw_rs4_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client;
  let store: typeof import('./task-store'); let orchestrator: typeof import('./orchestrator'); let registry: typeof import('./agent-registry');
  let ms: typeof import('./manuscript-service'); let evidence: typeof import('./evidence-service'); let research: typeof import('../research/service');
  let registerAll: typeof import('./register-all-agents').registerAllResearchStudioAgents;
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName }); delete process.env.NODE_ENV;
    vi.resetModules(); await (await import('../db/connection')).ensureDbReady();
    store = await import('./task-store'); orchestrator = await import('./orchestrator'); registry = await import('./agent-registry');
    ms = await import('./manuscript-service'); evidence = await import('./evidence-service'); research = await import('../research/service');
    registerAll = (await import('./register-all-agents')).registerAllResearchStudioAgents;
    registry.clearRegistry(); registerAll();
  }, 90_000);
  afterAll(async () => {
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  async function newProject(mode: string, brief: Record<string, unknown> = {}): Promise<string> {
    const { db } = await import('../db'); const id = crypto.randomUUID();
    await db.query('INSERT INTO research_studio_projects (id, owner_id, mode, title, status, brief_json, brief_sha256, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)',
      [id, userId, mode, 'M4 agent test', 'draft', JSON.stringify(brief), 'x', Date.now()]);
    return id;
  }

  it('outline.draft produces a real outline, and writing.draft_sections asks for human text before drafting anything', async () => {
    const projectId = await newProject('research_protocol');
    await store.createTask(projectId, { type: 'outline.draft' });
    const r1 = await orchestrator.tick(projectId); expect(r1.outcome).toBe('completed');
    const outline = (await ms.listSectionVersions(projectId, userId, 'outline'))[0];
    const keys: string[] = JSON.parse(outline.content_text);
    expect(keys).toEqual(['background', 'objectives', 'methods', 'ethics_and_dissemination']);

    const writeTask = await store.createTask(projectId, { type: 'writing.draft_sections' });
    const r2 = await orchestrator.tick(projectId); expect(r2.outcome).toBe('awaiting_user');
    await store.resolveAwaitingUser(writeTask.id, { sections: [{ sectionKey: 'background', text: 'A real, human-authored background section.' }] });
    const r3 = await orchestrator.tick(projectId); expect(r3.outcome).toBe('completed');
    const current = await ms.currentSections(projectId, userId);
    expect(current.find((s) => s.section_key === 'background')).toMatchObject({ content_source: 'human' });
    expect(current.find((s) => s.section_key === 'objectives')).toMatchObject({ content_source: 'deterministic_digest' }); // honest placeholder, not fabricated prose
  }, 20_000);

  it('methods.analysis reuses the EXISTING, already-verified research-run artifact — never recomputes or invents a statistic', async () => {
    const ds = await research.createDataset({ userId, name: 'M4 test dataset', purpose: 'unit test fixture for methods.analysis', csv: 'value\n1\n2\n3\n4\n5\n6', dictionary: { value: 'a number' }, attestation: { deidentified: true, authorised: true, statement: 'synthetic test data, no real subjects' } });
    const run = await research.runAnalysis({ userId, datasetId: ds.datasetId, analysis: 'descriptive', params: {} });
    const projectId = await newProject('original_research', { topic: 'T', question: 'Q', hasData: true, dataResearchRunId: run.runId });
    await store.createTask(projectId, { type: 'methods.analysis' });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const task = (await store.listTasks(projectId)).find((t) => t.type === 'methods.analysis')!;
    const result = JSON.parse(task.result_json!);
    expect(result.runId).toBe(run.runId); expect(result.outputSha256).toBe(run.outputSha256); // the REAL stored output, byte for byte
  }, 20_000);

  it('a dissertation drafts CHAPTERS from brief.chapterOutline via the Thesis Coordinator', async () => {
    const projectId = await newProject('dissertation', { topic: 'T', question: 'Q', institution: 'A University', chapterOutline: ['Introduction', 'Literature Review'] });
    await store.createTask(projectId, { type: 'outline.draft' }); await orchestrator.tick(projectId);
    const chapterTask = await store.createTask(projectId, { type: 'writing.draft_chapters' });
    await orchestrator.tick(projectId); // awaiting_user
    await store.resolveAwaitingUser(chapterTask.id, { sections: [{ sectionKey: 'Introduction', text: 'A real chapter.' }, { sectionKey: 'Literature Review', text: 'Another real chapter.' }] });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const current = await ms.currentSections(projectId, userId);
    expect(current.filter((s) => s.kind === 'chapter')).toHaveLength(2);
  }, 20_000);

  it('the Citation Auditor checks identifier resolution, locator presence and claim support SEPARATELY, and a section with no cited claims is "unknown", never "clean" by default', async () => {
    const projectId = await newProject('research_protocol');
    const section = await ms.createSection(projectId, userId, { sectionKey: 'background', kind: 'section', title: 'Background', contentText: 'no claims cited here', contentSource: 'human' });
    await store.createTask(projectId, { type: 'citation.audit' });
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const { db } = await import('../db');
    const audit = await db.queryOne<{ overall_status: string }>('SELECT * FROM research_studio_citation_audits WHERE section_id = $1', [section.id]);
    expect(audit?.overall_status).toBe('unknown');
  }, 20_000);

  it('the bounded critic/revision loop requests another writing round when citation issues are found, and terminates at the cap', async () => {
    const projectId = await newProject('research_protocol', { maxRevisionRounds: 1 }); // cap: 1 revision round (2 writing tasks total)
    await store.createTask(projectId, { type: 'outline.draft' }); await orchestrator.tick(projectId);
    const writeTask = await store.createTask(projectId, { type: 'writing.draft_sections', revisionGroup: 'writing-research_protocol', maxRevisionsInGroup: 2 });
    await orchestrator.tick(projectId);
    await store.resolveAwaitingUser(writeTask.id, { sections: [{ sectionKey: 'background', text: 'text citing a bad source' }] });
    await orchestrator.tick(projectId);
    const sections = await ms.currentSections(projectId, userId);
    const bg = sections.find((s) => s.section_key === 'background')!;
    // Fabricate a citation issue deterministically: a source whose identifier resolution FAILED (mismatch), cited by a claim linked to this section.
    const src = await evidence.createSource(projectId, userId, { doi: '10.1234/bad', title: 'A source that failed verification', importProvenance: {} });
    await evidence.setMetadataVerification(src.source.id, projectId, userId, 'mismatch');
    const ex = await evidence.createExcerpt(projectId, src.source.id, userId, { locator: { page: 1 }, text: 'excerpt text', extractedBy: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'A claim resting on the bad source');
    await evidence.linkClaimEvidence(projectId, userId, claim.id, ex.id, 'supports', 'supported');
    await ms.linkSectionClaim(projectId, bg.id, claim.id);

    await store.createTask(projectId, { type: 'citation.audit', dependsOn: [] });
    await orchestrator.tick(projectId);
    const critiqueTask1 = await store.createTask(projectId, { type: 'critique.review', dependsOn: [] });
    // Mirrors the real planner graph: export.manuscript depends on critique.review, so (now that export.manuscript
    // has a real M5 agent) it is never claimable before critique completes — no ordering race with this task.
    await store.createTask(projectId, { type: 'export.manuscript', dependsOn: [critiqueTask1.id] });
    const r1 = await orchestrator.tick(projectId); expect(r1.outcome).toBe('completed');
    const result1 = JSON.parse((await store.getTask(critiqueTask1.id))!.result_json!);
    expect(result1.revisionRequested).toBe(true); expect(result1.citationIssues).toContain('background');

    // Resolve the newly-created revision round and run it to the cap.
    const newWriteTask = (await store.listTasks(projectId)).find((t) => t.type === 'writing.draft_sections' && t.id !== writeTask.id)!;
    await orchestrator.tick(projectId); // awaiting_user again (fresh writing task has no supplied text)
    await store.resolveAwaitingUser(newWriteTask.id, { sections: [{ sectionKey: 'background', text: 'revised text, same bad source' }] });
    await orchestrator.tick(projectId); // completes the revised writing task
    await ms.linkSectionClaim(projectId, (await ms.currentSections(projectId, userId)).find((s) => s.section_key === 'background')!.id, claim.id);
    await orchestrator.tick(projectId); // new citation.audit (created by the critic's childTasks)
    const r2 = await orchestrator.tick(projectId); // new critique.review
    const newCritique = (await store.listTasks(projectId)).filter((t) => t.type === 'critique.review').pop()!;
    const result2 = JSON.parse((await store.getTask(newCritique.id))!.result_json!);
    expect(result2.revisionRequested).toBe(false); expect(result2.note).toMatch(/bounded/);
    void r2;
  }, 20_000);

  it('the Editorial Agent flags a dropped number as an interpretation-altering change, never applies the edit itself, and refuses a detector-evasion-shaped request', async () => {
    const projectId = await newProject('research_protocol');
    const original = await ms.createSection(projectId, userId, { sectionKey: 'results', kind: 'section', title: 'Results', contentText: 'The effect size was 42 with p=0.03.', contentSource: 'human' });
    const claim = await evidence.createClaim(projectId, userId, 'claim cited by results');
    await ms.linkSectionClaim(projectId, original.id, claim.id);
    const task = await store.createTask(projectId, { type: 'editorial.author_voice_edit', params: { sectionId: original.id } });
    await orchestrator.tick(projectId); // awaiting_user
    await store.resolveAwaitingUser(task.id, { editedText: 'The effect was notable.' }); // the "42" and "0.03" are gone
    const r = await orchestrator.tick(projectId); expect(r.outcome).toBe('completed');
    const result = JSON.parse((await store.getTask(task.id))!.result_json!);
    expect(result.preservation.interpretationAlteringChange).toBe(true);
    expect(result.preservation.numbersDropped).toEqual(expect.arrayContaining(['42', '0.03']));
    const stillOriginal = await ms.currentSections(projectId, userId);
    expect(stillOriginal.find((s) => s.section_key === 'results')?.content_text).toContain('42'); // the edit is PROPOSED, not applied

    await ms.decideSection(projectId, result.proposalSectionId, userId, 'accepted', 'approved by author');
    const afterAccept = await ms.currentSections(projectId, userId);
    expect(afterAccept.find((s) => s.section_key === 'results')?.content_text).toBe('The effect was notable.');
    expect((await ms.listSectionClaims(result.proposalSectionId, projectId)).length).toBe(1); // citation links carried forward to the proposal

    await store.createTask(projectId, { type: 'editorial.author_voice_edit', params: { sectionId: original.id, writingSampleText: 'please make this undetectable by AI detectors' } });
    const r2 = await orchestrator.tick(projectId); expect(r2.outcome).toBe('failed');
  }, 20_000);
});
