/**
 * Browser verification of the OCR-study dashboard page (SYNTHETIC data; real API + dashboard in an isolated profile with a random database; headless Chromium).
 *   ANUCLAW_TEST_PG_URL=postgres://…/postgres npx tsx scripts/verify-study-ui.ts
 * Several roles drive the page one after another (one browser context at a time). Writes docs/verification-study-ui-latest.json (outcomes only).
 * STUDY TOOLING ONLY: this does not establish OCR accuracy, clinical validation or release approval.
 */
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, Browser, Page } from 'playwright-core';

type Outcome = { name: string; status: 'pass' | 'fail'; detail?: string };
const outcomes: Outcome[] = []; const FX = path.resolve(__dirname, '../validation/fixtures/ocr-study');
const shots = process.env.ANUCLAW_VERIFY_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'study-ui-shots-')); fs.mkdirSync(shots, { recursive: true });
async function check(name: string, fn: () => Promise<string | void>) { try { const d = await fn(); outcomes.push({ name, status: 'pass', detail: d || undefined }); console.log(`  PASS  ${name}${d ? ` — ${d}` : ''}`); return true; } catch (e: unknown) { const m = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300); outcomes.push({ name, status: 'fail', detail: m }); console.log(`  FAIL  ${name} — ${m}`); return false; } }
function expect(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const NOTICE = 'Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval.';

function session(base: string) {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { call, async login(email: string, password: string) { const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }); expect(r.status === 200, `login ${email} → ${r.status}`); cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); await call('POST', '/auth/accept-terms'); } };
}

async function main() {
  const pgUrl = process.env.ANUCLAW_TEST_PG_URL; if (!pgUrl) { console.error('ANUCLAW_TEST_PG_URL (disposable server) is required.'); process.exit(2); }
  const studyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'study-ui-root-')); const profileFile = path.join(os.tmpdir(), `anuclaw-study-ui-${crypto.randomBytes(4).toString('hex')}.json`);
  let child: ChildProcess | undefined; let browser: Browser | undefined; let out = '';
  try {
    child = spawn('npx', ['tsx', 'scripts/start-local-profile.ts'], { env: { ...process.env, ANUCLAW_PROFILE_FILE: profileFile, ANUCLAW_STUDY_STORAGE: 'local_synthetic', ANUCLAW_STUDY_LOCAL_ROOT: studyRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d) => { out += d; }); child.stderr?.on('data', (d) => { out += d; });
    for (let i = 0; i < 90 && !fs.existsSync(profileFile); i++) await new Promise((r) => setTimeout(r, 1000));
    expect(fs.existsSync(profileFile), `profile did not start:\n${out.slice(-500)}`);
    const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')); const DASH: string = profile.dashboardUrl; console.log(`profile up: ${DASH}`);
    const strong = () => `Vf-${crypto.randomBytes(6).toString('hex')}-Qz9!`; const pw: Record<string, string> = {}; const em = (k: string) => `${k}@study-ui-synthetic.org`;
    const admin = session(DASH); await admin.login(profile.admin.email, profile.admin.password);
    for (const k of ['owner', 'cust', 'annA', 'annB', 'adj', 'stat', 'lead']) { pw[k] = strong(); expect((await admin.call('POST', '/api/users', { email: em(k), password: pw[k], role: 'operator' })).status === 201, `create ${k}`); }
    pw.aud = strong(); expect((await admin.call('POST', '/api/users', { email: em('aud'), password: pw.aud, role: 'auditor' })).status === 201, 'create auditor'); pw.viewer = strong(); expect((await admin.call('POST', '/api/users', { email: em('viewer'), password: pw.viewer, role: 'viewer' })).status === 201, 'create viewer');
    browser = await chromium.launch({ headless: true });
    const as = async (k: string, fn: (p: Page) => Promise<void>) => { const ctx = await browser!.newContext({ viewport: { width: 1400, height: 1100 } }); const page = await ctx.newPage(); page.setDefaultTimeout(30_000); page.on('pageerror', (e) => console.log(`  (page error ${k}: ${String(e.message).slice(0, 120)})`));
      try { await page.goto(`${DASH}/login`); await page.fill('#email', em(k)); await page.fill('#password', pw[k]); await page.click('button[type=submit]'); await page.waitForURL((u) => !u.pathname.startsWith('/login')); await ctx.request.post(`${DASH}/auth/accept-terms`); await page.goto(`${DASH}/ocr-study`); await page.waitForSelector('[data-testid=study-notice]'); await fn(page); } finally { await ctx.close(); } };
    const status = (p: Page, re: RegExp) => p.locator('[role=status]').filter({ hasText: re }).first();
    const noticeEverywhere = async (p: Page) => { expect((await p.locator('[data-testid=study-notice]').innerText()).includes(NOTICE), 'header notice'); expect((await p.locator('[data-testid=study-notice-footer]').innerText()).includes(NOTICE), 'footer notice'); };
    let studyId = ''; let dsId = ''; let digest = ''; let caseIds: string[] = [];
    const openStudy = async (p: Page) => { await p.click('[data-testid^="study-w-"]'); await p.waitForSelector('[data-testid=study-title]'); };
    const openDataset = async (p: Page) => { await p.click(`[data-testid=dataset-${dsId}]`); await p.waitForSelector('[data-testid=dataset-title]'); };

    console.log('\nBrowser: owner and custodian');
    await as('owner', async (p) => {
      await check('page shows the study-tooling notice and the synthetic storage status', async () => { await noticeEverywhere(p); await p.waitForSelector('[data-testid=storage-ready]'); });
      await check('owner creates a study and adds one member per role', async () => {
        await p.fill('[aria-label="Study name"]', 'UI synthetic study'); await p.fill('[aria-label="Study purpose"]', 'browser verification (synthetic)'); await p.click('text=Create study'); await p.waitForSelector('[data-testid=study-title]');
        for (const [k, r] of [['cust', 'dataset_custodian'], ['annA', 'annotator'], ['annB', 'annotator'], ['adj', 'adjudicator'], ['stat', 'statistician'], ['lead', 'clinical_lead'], ['aud', 'auditor']]) { await p.fill('[aria-label="Member email"]', em(k)); await p.selectOption('[aria-label="Study role"]', r); await p.click('text=Add member'); await status(p, /Member added/).waitFor(); }
        await p.screenshot({ path: path.join(shots, 'owner-study.png') });
      });
      await check('owner cannot see custodian, annotation or adjudication controls and has no accept action', async () => {
        for (const t of ['Register synthetic sample dataset', 'Import annotations', 'Disagreement review', 'Build adjudicated truth', 'Lock dataset']) expect((await p.locator(`text=${t}`).count()) === 0, `unexpected: ${t}`);
        expect((await p.locator('text=/accept(ed)? (the )?study/i').count()) === 0, 'an accept action is present');
      });
    });
    const owner = session(DASH); await owner.login(em('owner'), pw.owner); { const r = await owner.call('GET', '/api/ocr-study'); const t = await r.text(); expect(r.status === 200, `overview ${r.status}: ${t.slice(0, 120)}`); studyId = JSON.parse(t).studies[0].id; }
    await as('cust', async (p) => {
      await check('custodian registers the synthetic sample dataset, records the attestation and generates the manifest', async () => {
        await openStudy(p); await p.fill('[aria-label="Dataset name"]', 'UI dataset'); await p.selectOption('[aria-label="Split"]', 'locked_validation'); await p.fill('[aria-label="Annotator 1 email"]', em('annA')); await p.fill('[aria-label="Annotator 2 email"]', em('annB'));
        await p.click('text=Register synthetic sample dataset'); await status(p, /Synthetic dataset registered/).waitFor();
        dsId = (await p.locator('[data-testid^=dataset-]').first().getAttribute('data-testid'))!.replace('dataset-', ''); await openDataset(p);
        await p.click('text=Record attestation'); await status(p, /Attestation recorded/).waitFor(); await p.click('text=Generate manifest'); await status(p, /Manifest generated/).waitFor();
        expect((await p.locator('[data-testid=lock-state]').innerText()).includes('open'), 'lock state open'); await noticeEverywhere(p); await p.screenshot({ path: path.join(shots, 'custodian-manifest.png') });
      });
    });
    const annSession = async (k: string) => { const s = session(DASH); await s.login(em(k), pw[k]); return s; };
    const annA = await annSession('annA'); caseIds = ((await (await annA.call('GET', `/api/ocr-study/studies/${studyId}/datasets/${dsId}/cases`)).json()) as { cases: Array<{ caseId: string }> }).cases.map((c) => c.caseId);
    type AnnFile = { annotatorId?: string; completedCaseIds: string[]; items: Array<Record<string, unknown> & { caseId: string }> };
    const mapIds = (f: AnnFile) => { const m = (k: string) => caseIds[Number(k.slice(1)) - 1]; const { annotatorId, ...rest } = f; void annotatorId; return { ...rest, completedCaseIds: f.completedCaseIds.map(m), items: f.items.map((i) => ({ ...i, caseId: m(i.caseId) })) }; };

    console.log('\nBrowser: annotators (blind)');
    await as('annA', async (p) => {
      await check('annotator sees only their assigned dataset, its cases, and an upload box — no queue, agreement, audit or manifest', async () => {
        await openStudy(p); await openDataset(p); await p.waitForSelector('text=Cases (3)');
        for (const t of ['Disagreement review', 'Agreement (aggregate only)', 'Load audit events', 'manifest sha256', 'Lock dataset', 'Evaluation']) expect((await p.locator(`text=${t}`).count()) === 0, `annotator sees: ${t}`);
      });
      await check('annotator uploads their own annotations; the page confirms a new immutable version', async () => {
        await p.fill('[aria-label="Annotation file JSON"]', JSON.stringify(mapIds(rd('annotator-a.json')))); await p.click('text=Import annotations'); await status(p, /Annotation version imported/).waitFor(); await p.screenshot({ path: path.join(shots, 'annotator-a.png') });
      });
    });
    await as('annB', async (p) => { await openStudy(p); await openDataset(p); await p.fill('[aria-label="Annotation file JSON"]', JSON.stringify(mapIds(rd('annotator-b.json')))); await p.click('text=Import annotations'); await status(p, /Annotation version imported/).waitFor();
      await check('the second annotator cannot see the first annotator’s work', async () => { expect((await p.locator('text=/annotator-a/').count()) === 0, 'saw annotator A'); }); });

    console.log('\nBrowser: adjudicator');
    await as('adj', async (p) => {
      await check('adjudicator reviews the blind queue and adjudicates every item without seeing annotator identities', async () => {
        await openStudy(p); await openDataset(p); await p.waitForSelector('text=Disagreement review'); const body = await p.locator('body').innerText(); expect(!body.includes(em('annA')) && !body.includes(em('annB')), 'annotator identity leaked'); expect(/annotator identities are replaced by A and B/.test(body), 'blind label');
        await p.fill('[aria-label="Adjudication reason"]', 'synthetic: browser check');
        for (let i = 0; i < 6; i++) { const b = p.locator('button:text-is("A")').first(); if (!(await b.count())) break; await b.click(); await status(p, /Adjudication recorded/).waitFor(); await p.waitForTimeout(250); }
        await p.screenshot({ path: path.join(shots, 'adjudicator.png') }); expect((await p.locator('button:text-is("A")').count()) === 0, 'items left open');
      });
      await check('adjudicator has no annotation import, manifest or evaluation controls', async () => { for (const t of ['Import annotations', 'Evaluation', 'Lock dataset']) expect((await p.locator(`text=${t}`).count()) === 0, t); });
    });

    console.log('\nBrowser: custodian locks, statistician evaluates, lead and auditor');
    await as('cust', async (p) => {
      await check('custodian builds the truth and locks; the lock digest is shown with the instruction to record it OUTSIDE the system', async () => {
        await openStudy(p); await openDataset(p); await p.click('text=Build adjudicated truth'); await status(p, /truth built/).waitFor(); await p.click('text=Lock dataset'); await status(p, /Dataset locked/).waitFor();
        const t = await p.locator('[data-testid=lock-result]').innerText(); const m = t.match(/Lock digest ([0-9a-f]{64})/); expect(m, 'digest shown'); digest = m![1]; expect(/OUTSIDE this system/.test(t), 'custody instruction');
        expect((await p.locator('[data-testid=lock-state]').innerText()).includes('locked'), 'lock state'); await p.screenshot({ path: path.join(shots, 'custodian-locked.png') });
      });
    });
    await as('stat', async (p) => {
      await check('verification of a locked dataset demands the external digest; a wrong digest fails; the right one passes', async () => {
        await openStudy(p); await openDataset(p); await p.click('button:text-is("Verify")'); await status(p, /(?:expected_lock_digest|expectedLockDigest)/i).waitFor();
        await p.fill('[aria-label="Expected lock digest"]', '1'.repeat(64)); await p.click('button:text-is("Verify")'); await p.waitForSelector('[data-testid=verify-result]'); expect((await p.locator('[data-testid=verify-result]').innerText()).startsWith('FAILED'), 'wrong digest should fail');
        await p.fill('[aria-label="Expected lock digest"]', digest); await p.click('button:text-is("Verify")'); await p.waitForFunction(() => /Integrity checks passed/.test(document.querySelector('[data-testid=verify-result]')?.textContent ?? ''));
      });
      await check('statistician runs a locked evaluation and exports the report; the page states no acceptance is made', async () => {
        const r = rd('results.json'); const stamp = JSON.parse((await p.locator('[data-testid=policy-stamp]').innerText()).replace(/^[^{]*/, '')); const results = { ...r, policy: stamp, documents: r.documents.map((d: { documentId: string }) => ({ ...d, documentId: caseIds[Number(d.documentId.slice(1)) - 1] })) };
        await p.fill('[aria-label="Run id"]', 'ui-run-1'); await p.selectOption('[aria-label="Mode"]', 'locked'); await p.fill('[aria-label="Expected lock digest for evaluation"]', digest); await p.fill('[aria-label="Extraction results JSON"]', JSON.stringify(results));
        await p.click('text=Run evaluation'); await status(p, /Evaluation recorded/).waitFor(); expect(/not_assessed_by_this_tool/.test(await p.locator('[data-testid=report-hash]').innerText()), 'acceptance state');
        const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Export ui-run-1")')]); expect(/ocr-study-report-ui-run-1\.json/.test(dl.suggestedFilename()), 'download name');
        const file = await dl.path(); const text = fs.readFileSync(file!, 'utf8'); expect(JSON.parse(text).studyToolingNotice === NOTICE, 'export notice'); await p.screenshot({ path: path.join(shots, 'statistician.png') });
      });
    });
    await as('lead', async (p) => {
      await check('clinical lead can set severity labels but has no evaluation, lock or accept controls', async () => {
        await openStudy(p); await p.fill('[aria-label="Severity map JSON"]', '{"unit":"review-first"}'); await p.click('text=Save labels'); await status(p, /Severity labels saved/).waitFor();
        for (const t of ['Run evaluation', 'Lock dataset', 'Import annotations']) expect((await p.locator(`text=${t}`).count()) === 0, t);
      });
    });
    await as('aud', async (p) => {
      await check('auditor reads the audit log (ids/hashes only) and has no write controls', async () => {
        await openStudy(p); await p.click('text=Load audit events'); await p.waitForSelector('[data-testid=audit-table] tr'); const t = await p.locator('[data-testid=audit-table]').innerText();
        expect(/ocr_study\.locked_evaluation_run/.test(t) && /ocr_study\.adjudicated/.test(t), 'expected events'); expect(!/Sodium|SYNTHETIC FIXTURE|synthetic: browser check|mmol/i.test(t), 'content leaked into the audit view');
        for (const t2 of ['Register synthetic sample dataset', 'Import annotations', 'Lock dataset', 'Run evaluation', 'Add member']) expect((await p.locator(`text=${t2}`).count()) === 0, t2);
        await p.screenshot({ path: path.join(shots, 'auditor-audit.png') });
      });
    });

    console.log('\nBrowser: draft OCR policy panel');
    const policyOpen = async (p: Page) => { await openStudy(p); await p.waitForSelector('[data-testid=policy-panel]'); await p.waitForSelector('[data-testid=policy-field-confidenceFlagThreshold]'); };
    const FORBIDDEN_CONTROL = /\b(activate|approve|accept|release)\b/i;
    const noDangerousControls = async (p: Page) => { const labels = await p.locator('[data-testid=policy-panel] button').allInnerTexts(); for (const l of labels) expect(!FORBIDDEN_CONTROL.test(l), `forbidden control label: ${l}`); };
    await as('stat', async (p) => {
      await check('policy panel: banner, 13 fields all unconfigured, hash-chain integrity, no pre-filled value, no activate/approve/accept/release control', async () => {
        await policyOpen(p); expect((await p.locator('[data-testid=policy-banner]').innerText()) === 'DRAFT ONLY — REAL-STUDY ACTIVATION BLOCKED', 'banner'); expect((await p.locator('[data-testid^=policy-field-]').count()) === 13, '13 fields');
        for (const st of await p.locator('[data-testid^=policy-status-]').allInnerTexts()) expect(st === 'unconfigured', 'status'); expect(/hash chain verified/.test(await p.locator('[data-testid=policy-chain]').innerText()), 'chain');
        for (const v of await p.locator('[data-testid=policy-fields] input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))) expect(v === '', 'pre-filled input'); await noDangerousControls(p);
        expect(/NOT ELIGIBLE FOR ACTIVATION/.test(await p.locator('[data-testid=policy-ineligible]').innerText()), 'ineligible banner'); expect(/infrastructure gate/.test(await p.locator('[data-testid=policy-readiness]').innerText()), 'gates listed');
      });
      await check('statistician prepares a draft (value + source reference), saves it and submits it for review', async () => {
        await p.fill('[aria-label="Value for calibrationBins"]', '5'); await p.fill('[aria-label="Source reference for calibrationBins"]', 'UI-TEST-REF'); await p.click('text=Save draft version'); await status(p, /Draft version saved/).waitFor();
        await p.waitForFunction(() => document.querySelector('[data-testid=policy-status-calibrationBins]')?.textContent === 'configured'); await p.click('text=Submit current draft for review'); await status(p, /submitted for two-person review/).waitFor();
      });
      await check('self-review is refused with a clear message and the policy stays a draft', async () => {
        await p.fill('[aria-label="External decision reference"]', 'EXT-D'); await p.fill('[aria-label="External signature reference"]', 'EXT-S'); await p.click('text=Record review (reference only)'); await status(p, /reviewer must be a different study member/i).waitFor(); await noDangerousControls(p);
      });
    });
    await as('lead', async (p) => {
      await check('a different member records the review (references only); the panel still says draft / ineligible and shows no activation control', async () => {
        await policyOpen(p); await p.fill('[aria-label="External decision reference"]', 'EXT-DECISION-REF'); await p.fill('[aria-label="External signature reference"]', 'EXT-SIGNATURE-REF'); await p.click('text=Record review (reference only)'); await status(p, /Review recorded \(references only\)/).waitFor();
        const t = await p.locator('[data-testid=policy-reviews]').innerText(); expect(/reviewed/.test(t) && /not verified/.test(t), 'review shown as recorded, not verified'); expect(/NOT ELIGIBLE FOR ACTIVATION/.test(await p.locator('[data-testid=policy-ineligible]').innerText()), 'still ineligible'); await noDangerousControls(p);
        await p.screenshot({ path: path.join(shots, 'policy-panel-lead.png') });
      });
    });
    for (const who of ['aud', 'cust']) await as(who, async (p) => {
      await check(`${who}: policy panel is visible but read-only (no value inputs, no save, no submit, no review buttons)`, async () => {
        await policyOpen(p); expect((await p.locator('[data-testid=policy-readonly]').count()) === 1, 'read-only note'); expect((await p.locator('[data-testid=policy-fields] input').count()) === 0, 'no inputs'); for (const t of ['Save draft version', 'Submit current draft for review', 'Record review']) expect((await p.locator(`[data-testid=policy-panel] >> text=${t}`).count()) === 0, t); await noDangerousControls(p);
      });
    });
    await as('annA', async (p) => { await check('annotator sees no policy panel at all', async () => { await openStudy(p); await p.waitForSelector('[data-testid=study-title]'); expect((await p.locator('[data-testid=policy-panel]').count()) === 0, 'panel visible'); }); });
    await check('an unauthorised viewer account is refused by the API and sees no study data', async () => { const v = session(DASH); await v.login(em('viewer'), pw.viewer); expect((await v.call('GET', '/api/ocr-study')).status === 403, 'viewer should get 403'); });
  } finally {
    try { await browser?.close(); } catch { /* ignore */ } if (child && !child.killed) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 2500)); }
    fs.rmSync(studyRoot, { recursive: true, force: true });
  }
  const failed = outcomes.filter((o) => o.status === 'fail').length;
  fs.writeFileSync(path.resolve('docs/verification-study-ui-latest.json'), JSON.stringify({ ranAt: new Date().toISOString(), notice: NOTICE, syntheticDataOnly: true, outcomes, passed: outcomes.length - failed, failed }, null, 1) + '\n');
  console.log(`\n${outcomes.length - failed} passed, ${failed} failed; screenshots in ${shots}`); process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
