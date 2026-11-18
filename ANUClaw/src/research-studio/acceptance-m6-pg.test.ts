/**
 * M6 integrated acceptance (real PostgreSQL + real HTTP). ONE continuous rehearsal of the entire Research Studio
 * pipeline for a systematic_review project, driven through the real API exactly as the dashboard would: brief →
 * planner → search strategy → local literature import → identifier normalisation/dedup → screening → excerpts with
 * locators → claims/support links → evidence matrix → outline → manuscript sections (human-authored +
 * deterministic-digest provenance preserved) → citation audit → scientific critique → editorial review (no
 * detector evasion) → PRISMA flow from real stored counts → one conceptual visual → one data-derived visual from a
 * verified research-run artifact → export in every real format → hash/manifest verification → owner/tenant
 * isolation. Only synthetic/offline fixtures are used; no live provider, no paid call, no real patient data.
 * Opt-in: ANUCLAW_TEST_PG_URL.
 */
import * as crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe.skipIf(!URL_)('Research Studio M6 integrated acceptance (real PostgreSQL, real HTTP)', () => {
  const dbName = `anuclaw_rsacc_${crypto.randomBytes(6).toString('hex')}`;
  let admin: Client; let server: Server; let base: string;
  const cookie: Record<string, string> = {};
  let research: typeof import('../research/service');
  let sourceVerifier: typeof import('./agents/source-verifier');

  beforeAll(async () => {
    const u = new URL(URL_!); admin = new Client({ connectionString: URL_ }); await admin.connect(); await admin.query(`CREATE DATABASE ${dbName}`);
    Object.assign(process.env, { PG_HOST: u.hostname, PG_PORT: u.port, PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName, DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    delete process.env.NODE_ENV; delete process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR;
    vi.resetModules();
    await (await import('../db/connection')).ensureDbReady();
    const { db } = await import('../db'); const auth = await import('../dashboard/server/auth');
    for (const k of ['owner', 'other']) {
      const id = crypto.randomUUID();
      await db.query(`INSERT INTO dash_users (id, email, role, password_hash, created_at) VALUES ($1,$2,'operator','x',0)`, [id, `${k}@research-studio-m6-acceptance.invalid`]);
      cookie[k] = `dash_token=${(await auth.issueTokens(id)).accessToken}`;
    }
    research = await import('../research/service');
    sourceVerifier = await import('./agents/source-verifier');
    (await import('./register-all-agents')).registerAllResearchStudioAgents();
    const express = (await import('express')).default; const cookieParser = (await import('cookie-parser')).default; const app = express();
    app.use(cookieParser()); app.use(express.json({ limit: '2mb' }));
    app.use('/api/research-studio', (await import('../dashboard/server/routes/research-studio')).default);
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/research-studio`;
  }, 90_000);
  afterAll(async () => {
    sourceVerifier.setConnectorForTesting(null); delete process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    try { (await import('../db/connection')).getDb().end(); } catch { /* ignore */ }
    if (admin) { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [dbName]); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); }
  });

  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { cookie: cookie[who], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text };
  };
  const expectOk = (r: { status: number; text: string }, label: string) => { if (r.status < 200 || r.status >= 300) throw new Error(`${label} failed (${r.status}): ${r.text.slice(0, 300)}`); };

  it('runs the complete synthetic pipeline end to end, then proves owner isolation', async () => {
    // 1) A complete, validated brief for a systematic review.
    const projectRes = await call('owner', 'POST', '/projects', {
      mode: 'systematic_review',
      title: 'M6 acceptance rehearsal: synthetic systematic review',
      brief: {
        topic: 'Synthetic acceptance-test topic', question: 'Does the pipeline work end to end?',
        searchMethod: 'manual offline fixture import', screeningMethod: 'single-reviewer synthetic screening',
        searchStrategy: { databases: ['crossref'], queries: ['synthetic acceptance query'] },
        referenceTarget: 5, inclusionCriteria: 'synthetic fixtures only', exclusionCriteria: 'none excluded by design',
        maxRevisionRounds: 1,
      },
    });
    expectOk(projectRes, 'create project'); expect(projectRes.json.project.mode).toBe('systematic_review');
    const projectId = projectRes.json.project.id as string;
    expect(projectRes.json.graph.length).toBeGreaterThan(5); // the full literature→evidence→manuscript→export graph exists immediately

    // 2) The Research Planner's search-strategy task and literature.search_execute, resolved via LOCAL import
    //    (never the live connector — it stays opt-in and disabled for this rehearsal).
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 10 });
    let graph = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph;
    const searchExecTask = graph.find((t: any) => t.type === 'literature.search_execute' && t.status === 'awaiting_user');
    expect(searchExecTask, 'expected literature.search_execute to be awaiting_user (no live connector)').toBeDefined();

    // 3) Local, offline bibliography import — deterministic identifier normalisation and exact-duplicate detection.
    const ris = [
      'TY  - JOUR\nAU  - Rivera, Ana\nTI  - A Synthetic Trial Of Something\nPY  - 2021\nDO  - 10.1234/m6-real\nJO  - J Synth\nER  - ',
      'TY  - JOUR\nAU  - No Title Here\nPY  - 2020\nER  - ', // malformed — must be reported, never dropped silently
    ].join('\n\n');
    const importRes = await call('owner', 'POST', `/projects/${projectId}/sources/import`, { text: ris });
    expectOk(importRes, 'import bibliography');
    expect(importRes.json.imported).toBe(1); expect(importRes.json.parseFailures).toHaveLength(1);
    // An exact-duplicate manual add of the SAME DOI is auto-flagged, never silently merged.
    const dup = await call('owner', 'POST', `/projects/${projectId}/sources`, { doi: '10.1234/m6-real', title: 'A differently-worded duplicate title' });
    expect(dup.json.exactDuplicateOf).toBeTruthy();
    const links = await call('owner', 'GET', `/projects/${projectId}/source-links`);
    const link = links.json.links.find((l: any) => l.status === 'proposed');
    expect(link, 'expected a proposed dedup link').toBeDefined();
    await call('owner', 'POST', `/projects/${projectId}/source-links/${link.id}/decision`, { decision: 'confirmed' });

    await call('owner', 'POST', `/tasks/${searchExecTask.id}/resolve`, { answer: { imported: true } });
    // literature.verify_sources checks the DOI against Crossref's own metadata record. With no live connector
    // configured the task honestly stays awaiting_user rather than guessing — proven by an earlier run of this
    // test. To exercise the real, deterministic metadata-verification logic (DOI normalisation, title/year match,
    // correction-status propagation) without ever calling a real network or a paid provider, inject the exact
    // same offline fake-fetcher fixture this repo's own agents-m2-pg.test.ts uses for Crossref: a public
    // bibliographic metadata lookup, not a model/account connector — the Section-5 "never automate a live
    // provider" boundary concerns Gemini/GLM/browser automation, not this.
    const { CrossrefConnector } = await import('./connectors/crossref');
    process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR = '1';
    sourceVerifier.setConnectorForTesting(new CrossrefConnector({
      fetcher: { async request(url: string) {
        const body = { message: { DOI: '10.1234/m6-real', title: ['A Synthetic Trial Of Something'], author: [{ given: 'Ana', family: 'Rivera' }], 'published-print': { 'date-parts': [[2021]] }, 'container-title': ['J Synth'], type: 'journal-article' } };
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), finalUrl: url, attempts: 1 };
      } },
    }));
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 10 });
    graph = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph;
    const verifyTask = graph.find((t: any) => t.type === 'literature.verify_sources');
    expect(verifyTask.status).toBe('completed');
    const verifyResult = JSON.parse(verifyTask.result_json);
    expect(verifyResult.verified).toBeGreaterThanOrEqual(1); // the real DOI genuinely matched Crossref's (fixture) record
    sourceVerifier.setConnectorForTesting(null); delete process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR;

    // 4) Screening with an explicit, required reason.
    const sources = (await call('owner', 'GET', `/projects/${projectId}/sources`)).json.sources;
    const realSource = sources.find((s: any) => s.doi === '10.1234/m6-real');
    const screenRes = await call('owner', 'POST', `/projects/${projectId}/sources/${realSource.id}/screening`, { decision: 'include' });
    expectOk(screenRes, 'screening');

    // 5) An excerpt with an exact locator, via the evidence.extract task itself (it deliberately refuses to
    //    fabricate excerpts and asks the user instead — the exact mechanism being exercised here).
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 10 });
    graph = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph;
    const extractTask = graph.find((t: any) => t.type === 'evidence.extract');
    expect(extractTask.status).toBe('awaiting_user');
    const extractResolve = await call('owner', 'POST', `/tasks/${extractTask.id}/resolve`, { answer: { excerpts: [{ sourceId: realSource.id, locator: { page: 4, section: 'Results' }, text: 'The synthetic intervention showed a measurable effect in this fixture.' }] } });
    expectOk(extractResolve, 'resolve evidence.extract');
    // Exactly ONE step: run evidence.extract itself, but not its downstream evidence.build_matrix — the claim and
    // support link below must exist before the matrix is built, or it will honestly (and correctly) show no rows.
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 1 });
    const extractTaskDone = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph.find((t: any) => t.type === 'evidence.extract');
    expect(extractTaskDone.status).toBe('completed');
    const extractResult = JSON.parse(extractTaskDone.result_json);
    const excerptId = extractResult.excerptIds[0] as string;
    const claimRes = await call('owner', 'POST', `/projects/${projectId}/claims`, { statement: 'The synthetic intervention showed a measurable effect' });
    const linkRes = await call('owner', 'POST', `/projects/${projectId}/claims/${claimRes.json.claim.id}/links`, { excerptId, relation: 'supports', supportStatus: 'supported' });
    expectOk(linkRes, 'link claim to evidence');

    // 6) Advance through evidence.build_matrix → evidence.synthesize → outline.draft; resolve writing.draft_sections
    //    with human-authored text, preserving content-source provenance.
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 20 });
    const matrixRes = await call('owner', 'GET', `/projects/${projectId}/evidence-matrix`);
    expect(matrixRes.json.matrix.rows.length).toBeGreaterThan(0);
    expect(matrixRes.json.matrix.rows[0].overallStatus).toBe('supported'); // the real, recorded support — never inferred from a resolved DOI alone

    graph = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph;
    const writeTask = graph.find((t: any) => t.type === 'writing.draft_sections' && t.status === 'awaiting_user');
    expect(writeTask, 'expected writing.draft_sections awaiting human text').toBeDefined();
    await call('owner', 'POST', `/tasks/${writeTask.id}/resolve`, { answer: { sections: [
      { sectionKey: 'introduction', text: 'This synthetic review introduces the acceptance-test topic.' },
      { sectionKey: 'results', text: 'The synthetic intervention showed a measurable effect in this fixture.' },
    ] } });
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 20 });

    const currentSections = (await call('owner', 'GET', `/projects/${projectId}/sections`)).json.current;
    const introduction = currentSections.find((s: any) => s.section_key === 'introduction');
    const discussion = currentSections.find((s: any) => s.section_key === 'discussion');
    expect(introduction.content_source).toBe('human'); // human-authored content preserved as such
    expect(discussion?.content_source).toBe('deterministic_digest'); // unsupplied content is an honest placeholder, never fabricated prose
    await call('owner', 'POST', `/projects/${projectId}/sections/${introduction.id}/claims`, { claimId: claimRes.json.claim.id });

    // 7) Editorial review — the author supplies their own edit; never an AI-detector-evasion request.
    const editRes = await call('owner', 'POST', `/projects/${projectId}/sections/${introduction.id}/editorial-edit`, { editedText: 'This synthetic review introduces the acceptance-test topic and its scope.' });
    expectOk(editRes, 'editorial edit');
    if (editRes.json.task.status === 'completed') {
      const editResult = JSON.parse(editRes.json.task.result_json);
      await call('owner', 'POST', `/projects/${projectId}/sections/${editResult.proposalSectionId}/decision`, { decision: 'accepted', reason: 'approved for the acceptance rehearsal' });
    }

    // 8) Citation audit + scientific critique should by now show no unresolved issues (the one claim IS supported with a real locator).
    await call('owner', 'POST', `/projects/${projectId}/advance`, { maxSteps: 20 });
    graph = (await call('owner', 'GET', `/projects/${projectId}/graph`)).json.graph;
    const critique = graph.filter((t: any) => t.type === 'critique.review').pop();
    expect(critique.status).toBe('completed');

    // 9) Visuals: a REAL PRISMA flow from real stored counts, one conceptual visual, and one data-derived visual
    //    from a verified research-run artifact (never invented numbers).
    const prisma = await call('owner', 'POST', `/projects/${projectId}/visuals`, { type: 'prisma_flow' });
    expectOk(prisma, 'build prisma flow'); expect(prisma.json.visual.svg).toContain('n = 1'); // one real included source
    const conceptual = await call('owner', 'POST', `/projects/${projectId}/visuals`, { visualKey: 'overview', type: 'conceptual_diagram', kind: 'conceptual', title: 'Review overview', spec: { nodes: [{ id: 'a', label: 'Search' }, { id: 'b', label: 'Screen' }, { id: 'c', label: 'Synthesise' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } });
    expectOk(conceptual, 'build conceptual visual');
    // The HTTP session's user id isn't known to this test file directly; create the dataset/run via the service
    // using the project's real owner id instead (same owner the dashboard session resolves to).
    const { db } = await import('../db');
    const ownerIdRow = await db.queryOne<{ owner_id: string }>('SELECT owner_id FROM research_studio_projects WHERE id = $1', [projectId]);
    const dataset = await research.createDataset({ userId: ownerIdRow!.owner_id, name: 'M6 acceptance dataset', purpose: 'unit test fixture for the data-derived visual', csv: 'value\n1\n2\n3\n4\n5\n9', dictionary: { value: 'a number' }, attestation: { deidentified: true, authorised: true, statement: 'synthetic test data, no real subjects' } });
    const run = await research.runAnalysis({ userId: ownerIdRow!.owner_id, datasetId: dataset.datasetId, analysis: 'descriptive', params: { columns: ['value'] } });
    const dataVisual = await call('owner', 'POST', `/projects/${projectId}/visuals`, { visualKey: 'descriptive', type: 'data_plot', kind: 'data_derived', title: 'Descriptive stat', spec: { runId: run.runId, fields: ['value.mean'] } });
    expectOk(dataVisual, 'build data-derived visual');
    expect(dataVisual.json.visual.svg).toMatch(/<svg/);

    // 10) Export every real format, verify hashes and the provenance manifest.
    const exportRes = await call('owner', 'POST', `/projects/${projectId}/export`, {});
    expectOk(exportRes, 'export'); expect(exportRes.json.task.status).toBe('completed');
    const exportResult = JSON.parse(exportRes.json.task.result_json);
    expect(exportResult.formats.sort()).toEqual(['bibtex', 'docx', 'latex', 'markdown', 'pdf', 'provenance_manifest', 'ris']);
    const exportsList = (await call('owner', 'GET', `/projects/${projectId}/exports`)).json.exports;
    for (const e of exportsList) {
      const dl = await fetch(base + `/projects/${projectId}/exports/${e.id}/download`, { headers: { cookie: cookie.owner } });
      const bytes = Buffer.from(await dl.arrayBuffer());
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(e.content_sha256);
    }

    // 11) Owner/tenant isolation: a different operator can reach NOTHING about this project.
    const probes = [
      ['GET', `/projects/${projectId}`], ['GET', `/projects/${projectId}/sources`], ['GET', `/projects/${projectId}/sections`],
      ['GET', `/projects/${projectId}/visuals`], ['GET', `/projects/${projectId}/exports`], ['GET', `/projects/${projectId}/evidence-matrix`],
    ] as const;
    for (const [method, p] of probes) expect((await call('other', method, p)).status, `${method} ${p} should 404 for another tenant`).toBe(404);
    expect((await call('other', 'GET', '/projects')).json.projects.some((pr: any) => pr.id === projectId)).toBe(false);
  }, 60_000);
});
