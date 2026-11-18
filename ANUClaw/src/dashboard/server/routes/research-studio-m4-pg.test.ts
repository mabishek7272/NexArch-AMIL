/** Research Studio M4 API (real PostgreSQL, real HTTP): sections, comments, section-claim links, decisions
 * (including the auto re-audit on accept), guidelines/checklist, compliance report, and owner-only isolation.
 * Opt-in: ANUCLAW_TEST_PG_URL. */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../../../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M4 routes (real PostgreSQL)', () => {
  const dbName = `anuclaw_rsm4_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  const ids: Record<string, string> = {}; const cookie: Record<string, string> = {};

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    delete process.env.NODE_ENV;
    vi.resetModules();
    await (await import('../../../db/connection')).ensureDbReady();
    const { db } = await import('../../../db'); const auth = await import('../auth');
    for (const [k, role] of [['opA', 'operator'], ['opB', 'operator']] as const) {
      const id = crypto.randomUUID(); ids[k] = id;
      await db.query(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,$3,'x',0)`, [id, `${k}@research-studio-m4-synthetic.invalid`, role]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    (await import('../../../research-studio/register-all-agents')).registerAllResearchStudioAgents();
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express();
    app.use(cookieParser()); app.use(express.json({ limit: '1mb' }));
    app.use('/api/research-studio', (await import('./research-studio')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research-studio`;
  }, 90_000);
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../../../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { cookie: cookie[who], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json };
  };
  async function project(who: string) {
    const res = await call(who, 'POST', '/projects', { mode: 'research_protocol', title: `M4 route test ${crypto.randomBytes(4).toString('hex')}`, brief: { topic: 'T', question: 'Q?' } });
    return res.json.project.id as string;
  }

  it('creating a manual section, commenting, linking a claim, and reading it back round-trip through the API', async () => {
    const pid = await project('opA');
    // Drive outline.draft + writing.draft_sections for real through /advance, then supply human text via resolve.
    await call('opA', 'POST', `/projects/${pid}/advance`, { maxSteps: 10 });
    const graph1 = (await call('opA', 'GET', `/projects/${pid}/graph`)).json.graph;
    const writeTask = graph1.find((t: any) => t.type === 'writing.draft_sections' && t.status === 'awaiting_user');
    expect(writeTask).toBeDefined();
    await call('opA', 'POST', `/tasks/${writeTask.id}/resolve`, { answer: { sections: [{ sectionKey: 'background', text: 'Real human background text.' }] } });
    await call('opA', 'POST', `/projects/${pid}/advance`, { maxSteps: 10 });
    const current = (await call('opA', 'GET', `/projects/${pid}/sections`)).json.current;
    const bg = current.find((s: any) => s.section_key === 'background'); expect(bg.content_source).toBe('human');

    const comment = await call('opA', 'POST', `/projects/${pid}/sections/${bg.id}/comments`, { body: 'looks good' });
    expect(comment.status).toBe(201);
    const claim = await call('opA', 'POST', `/projects/${pid}/claims`, { statement: 'A claim for the background section' });
    const link = await call('opA', 'POST', `/projects/${pid}/sections/${bg.id}/claims`, { claimId: claim.json.claim.id });
    expect(link.status).toBe(201);
    const detail = await call('opA', 'GET', `/projects/${pid}/sections/${bg.id}`);
    expect(detail.json.comments).toHaveLength(1); expect(detail.json.claims).toHaveLength(1);
  });

  it('the Editorial Agent proposal→accept flow queues a real re-audit task (plan §4: re-run citation checks after an edit)', async () => {
    const pid = await project('opA');
    await call('opA', 'POST', `/projects/${pid}/advance`, { maxSteps: 10 });
    const graph = (await call('opA', 'GET', `/projects/${pid}/graph`)).json.graph;
    const writeTask = graph.find((t: any) => t.type === 'writing.draft_sections' && t.status === 'awaiting_user');
    await call('opA', 'POST', `/tasks/${writeTask.id}/resolve`, { answer: { sections: [{ sectionKey: 'background', text: 'Original human text with the number 7.' }] } });
    await call('opA', 'POST', `/projects/${pid}/advance`, { maxSteps: 10 });
    const bg = (await call('opA', 'GET', `/projects/${pid}/sections`)).json.current.find((s: any) => s.section_key === 'background');

    const edit1 = await call('opA', 'POST', `/projects/${pid}/sections/${bg.id}/editorial-edit`, {});
    expect(edit1.json.task.status).toBe('awaiting_user'); // no editedText supplied yet
    const edit2 = await call('opA', 'POST', `/projects/${pid}/sections/${bg.id}/editorial-edit`, { editedText: 'A rewritten sentence without any numbers.' });
    expect(edit2.json.task.status).toBe('completed');
    const result = JSON.parse(edit2.json.task.result_json);
    expect(result.preservation.numbersDropped).toContain('7');
    expect(result.preservation.interpretationAlteringChange).toBe(true);

    const decision = await call('opA', 'POST', `/projects/${pid}/sections/${result.proposalSectionId}/decision`, { decision: 'accepted', reason: 'approved' });
    expect(decision.status).toBe(201); expect(decision.json.reauditTaskId).toBeTruthy();
    const reaudit = await call('opA', 'GET', `/projects/${pid}/graph`);
    expect(reaudit.json.graph.some((t: any) => t.id === decision.json.reauditTaskId)).toBe(true);
    const current = (await call('opA', 'GET', `/projects/${pid}/sections`)).json.current.find((s: any) => s.section_key === 'background');
    expect(current.content_text).toBe('A rewritten sentence without any numbers.');
  });

  it('guideline checklist confirmation is append-only (new version each time) and the compliance report states it is not an acceptance', async () => {
    const pid = await project('opA');
    const g = await call('opA', 'POST', `/projects/${pid}/guidelines`, { journalOrUniversity: 'Journal of Examples', constraints: { sectionWordLimits: { background: 2 } }, checklist: [{ id: 'c1', label: 'Item one' }] });
    expect(g.status).toBe(201); expect(g.json.guideline.version).toBe(1);
    const confirmed = await call('opA', 'POST', `/projects/${pid}/guidelines/checklist/c1`, { confirmed: true });
    expect(confirmed.json.guideline.version).toBe(2);
    const report = await call('opA', 'POST', `/projects/${pid}/compliance-report`, {});
    expect(report.status).toBe(201); expect(report.json.report.notice).toMatch(/NOT a journal acceptance/);
    expect(report.json.report.checklist[0]).toMatchObject({ id: 'c1', status: 'confirmed' });
    const fetched = await call('opA', 'GET', `/projects/${pid}/compliance-report`);
    expect(fetched.json.report.builtAt ?? fetched.json.builtAt).toBeTruthy();
  });

  it('revising a source cascades invalidation all the way to the manuscript section it produced, via the PATCH /sources route', async () => {
    const pid = await project('opA');
    const { createTask } = await import('../../../research-studio/task-store');
    const { createExcerpt } = await import('../../../research-studio/evidence-service');
    const { createSection } = await import('../../../research-studio/manuscript-service');
    const src = (await call('opA', 'POST', `/projects/${pid}/sources`, { doi: '10.1234/invalidation-route-test', title: 'A source to revise' })).json.source;
    const extractTask = await createTask(pid, { type: 'evidence.extract' });
    await createExcerpt(pid, src.id, ids.opA, { locator: { page: 1 }, text: 'evidence', extractedBy: 'human', taskId: extractTask.id });
    // The section's producing task must be DOWNSTREAM of the extract task — invalidateDownstream flags dependents of
    // the task it's given, not that task itself (the excerpt itself is flagged directly; see evidence-service.ts).
    // invalidateDownstream only flags COMPLETED dependents, so both tasks must actually be claimed and committed.
    const store = await import('../../../research-studio/task-store');
    const claimedExtract = await store.claimNextReady(pid, ['evidence.extract']);
    await store.commitOutcome(claimedExtract!.task, claimedExtract!.token, { kind: 'completed', result: {} });
    const writeTask = await createTask(pid, { type: 'writing.draft_sections', dependsOn: [extractTask.id] });
    const claimedWrite = await store.claimNextReady(pid, ['writing.draft_sections']);
    await store.commitOutcome(claimedWrite!.task, claimedWrite!.token, { kind: 'completed', result: {} });
    const section = await createSection(pid, ids.opA, { sectionKey: 'background', kind: 'section', title: 'Background', contentText: 'text', contentSource: 'human', taskId: writeTask.id });

    const revise = await call('opA', 'PATCH', `/projects/${pid}/sources/${src.id}`, { correctionStatus: 'retracted' });
    expect(revise.status).toBe(200);
    expect(revise.json.invalidatedSections).toContain(section.id);
    const detail = await call('opA', 'GET', `/projects/${pid}/sections/${section.id}`);
    expect(detail.json.section.invalidated_at).toBeTruthy();
  });

  it('sections, comments and guidelines are owner-only (404, never 403)', async () => {
    const pid = await project('opA');
    await call('opA', 'POST', `/projects/${pid}/advance`, { maxSteps: 10 });
    expect((await call('opB', 'GET', `/projects/${pid}/sections`)).status).toBe(404);
    expect((await call('opB', 'POST', `/projects/${pid}/guidelines`, { journalOrUniversity: 'X' })).status).toBe(404);
    expect((await call('opB', 'POST', `/projects/${pid}/compliance-report`, {})).status).toBe(404);
  });
});
