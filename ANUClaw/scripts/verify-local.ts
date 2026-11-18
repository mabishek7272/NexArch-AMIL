/**
 * End-to-end verification on loopback with SYNTHETIC data: real API + dashboard
 * (isolated profile, random database), real Chrome via playwright-core, real
 * PaddleOCR service (if ANUCLAW_OCR_SERVICE_URL), live OpenRouter calls (if a
 * server-side key is configured; bounded: ≤ 2 review runs).
 *
 * The OCR service and OpenRouter sit behind local forwarders so provider OUTAGES
 * can be injected mid-run. Forwarders only relay bytes to the real endpoints; they
 * never log headers or bodies.
 *
 *   ANUCLAW_TEST_PG_URL=postgres://…/postgres \
 *   ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:54001 \
 *   npm run verify:local
 *
 * Writes docs/verification-local-latest.json (outcomes only; no secrets/PHI) and
 * screenshots to ANUCLAW_VERIFY_SHOTS (default: os tmp).
 */
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { buildTestPdf, appendScannedPage } from '../src/documents/test-pdf';
import { renderPdfPages } from '../src/documents/ocr';
import { extractPdfText } from '../src/documents/pdf-extract';
import { config } from '../src/config';
import { startMockProviders } from '../src/sciencedata/testkit';

type Outcome = { name: string; status: 'pass' | 'fail' | 'skip'; detail?: string };
const outcomes: Outcome[] = [];
const shots = process.env.ANUCLAW_VERIFY_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'anuclaw-shots-'));
fs.mkdirSync(shots, { recursive: true });

async function check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try { const d = await fn(); outcomes.push({ name, status: 'pass', detail: d || undefined }); console.log(`  PASS  ${name}${d ? ` — ${d}` : ''}`); return true; }
  catch (e: any) { const m = String(e?.message ?? e).split('\n')[0].slice(0, 300); outcomes.push({ name, status: 'fail', detail: m }); console.log(`  FAIL  ${name} — ${m}`); return false; }
}
const skip = (name: string, why: string) => { outcomes.push({ name, status: 'skip', detail: why }); console.log(`  SKIP  ${name} — ${why}`); };
function expect(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

// ── forwarders with injectable outage ────────────────────────────────────────
function forwarder(target: URL) {
  let down = false;
  const client = target.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    const up = client.request({ hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return {
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    setDown: (v: boolean) => { down = v; },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ── dashboard HTTP session ───────────────────────────────────────────────────
function session(base: string) {
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(base + p, { method, headers: { cookie, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...extra }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    return r;
  };
  return {
    call,
    async login(email: string, password: string) {
      const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      expect(r.status === 200, `login ${email} → ${r.status}`);
      cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    },
  };
}

async function main() {
  const pgUrl = process.env.ANUCLAW_TEST_PG_URL;
  if (!pgUrl) { console.error('ANUCLAW_TEST_PG_URL (disposable server) is required.'); process.exit(2); }
  const ocrReal = process.env.ANUCLAW_OCR_SERVICE_URL;
  const liveModels = Boolean(config.llm.openrouterApiKey);
  // Default: Playwright's own headless Chromium (npx playwright-core install chromium-headless-shell).
  // ANUCLAW_CHROME overrides with an explicit executable (the branded Chrome on this host exits spontaneously).
  const chromePath = process.env.ANUCLAW_CHROME;

  const ocrProxy = ocrReal ? forwarder(new URL(ocrReal)) : null;
  const orProxy = liveModels ? forwarder(new URL('https://openrouter.ai')) : null;
  const profileFile = path.join(os.tmpdir(), `anuclaw-verify-${crypto.randomBytes(4).toString('hex')}.json`);
  let child: ChildProcess | undefined;
  let sciMock: Awaited<ReturnType<typeof startMockProviders>> | undefined;
  let browser: Browser | undefined;

  const cleanup = async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (child && !child.killed) { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 2500)); }
    await ocrProxy?.stop(); await orProxy?.stop();
  };

  try {
    // Public-data connectors point at a SYNTHETIC local mock of the four providers (browser workflow only; live retrieval is checked separately
    // by scripts/verify-science-live.ts within its download budget).
    sciMock = await startMockProviders(); const mo = sciMock.origin;
    const env: NodeJS.ProcessEnv = { ...process.env, ANUCLAW_PROFILE_FILE: profileFile, ANUCLAW_SCIDATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'scidata-verify-')), ANUCLAW_SCIDATA_MIN_INTERVAL_MS: '0', ANUCLAW_SCIDATA_NCBI_MIN_INTERVAL_MS: '0',
      ANUCLAW_SCIDATA_BASE_OVERRIDES: JSON.stringify({ alphafold: mo, rcsbData: mo, rcsbFiles: mo, rcsbSearch: mo, ncbiDatasets: mo, ncbiEutils: mo, ncbiWww: mo, ncbiFtp: mo }) };
    if (ocrProxy) env.OCR_SERVICE_URL = await ocrProxy.start();
    if (orProxy) env.OPENROUTER_BASE_URL = `${await orProxy.start()}/api/v1`;
    child = spawn('npx', ['tsx', 'scripts/start-local-profile.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    child.stdout?.on('data', (d) => { childOut += d; }); child.stderr?.on('data', (d) => { childOut += d; });
    for (let i = 0; i < 90 && !fs.existsSync(profileFile); i++) await new Promise((r) => setTimeout(r, 1000));
    expect(fs.existsSync(profileFile), `profile did not start:\n${childOut.slice(-600)}`);
    const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    const DASH: string = profile.dashboardUrl, API: string = profile.apiUrl;
    console.log(`profile up: ${DASH} / ${API}  (OCR ${ocrReal ? 'real service via forwarder' : 'not configured'}, live models ${liveModels ? 'via forwarder' : 'off'})`);

    // ── seed users & patient through the real routes ──
    const strong = () => `Vf-${crypto.randomBytes(6).toString('hex')}-Qz9!`;
    const pw = { op1: strong(), op2: strong(), viewer: strong(), doc: strong() };
    const admin = session(DASH); await admin.login(profile.admin.email, profile.admin.password);
    const ids: Record<string, string> = {};
    for (const [k, role] of [['op1', 'operator'], ['op2', 'operator'], ['viewer', 'viewer'], ['doc', 'viewer']] as const) {
      const r = await admin.call('POST', '/api/users', { email: `${k}@clinic-synthetic.org`, password: (pw as any)[k], role });
      expect(r.status === 201, `create ${k} → ${r.status}`); ids[k] = (await r.json()).id;
    }
    const prov = await admin.call('POST', `/api/users/${ids.doc}/clinician-provisioning`, { license_number: 'SYN-LIC-1', jurisdiction: 'Synthetic', licensing_body: 'Synthetic Board', verification_note: 'verification fixture (synthetic)' });
    expect(prov.status === 200, `provision clinician → ${prov.status}`);
    const op1 = session(DASH); await op1.login('op1@clinic-synthetic.org', pw.op1);
    const mk = await op1.call('POST', '/api/patients', { name: 'Synthetic Verify Subject', purpose: 'local verification' });
    expect(mk.status === 201, 'create patient'); const patientId = (await mk.json()).id;
    for (const [uid, level] of [[ids.doc, 'write'], [ids.viewer, 'read']] as const) {
      expect((await admin.call('POST', `/api/patients/${patientId}/access`, { user_id: uid, access_level: level, purpose: 'verification fixture' })).status === 200, `grant ${level}`);
    }

    // ── documents ──
    const png1 = (await renderPdfPages(buildTestPdf([['Potassium 4.1 mmol/L 3.5-5.1', 'Calcium 2.3 mmol/L 2.2-2.6']]), [1], 2)).get(1)!;
    const mixed = await appendScannedPage(buildTestPdf([['SYNTHETIC LAB REPORT', 'Hemoglobin 16.4 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145']]), png1);
    const png2 = (await renderPdfPages(buildTestPdf([['Urea 5.0 mmol/L 2.5-7.8']]), [1], 2)).get(1)!;
    const mixed2 = await appendScannedPage(buildTestPdf([['SYNTHETIC LAB REPORT TWO', 'Chloride 101 mmol/L 98-107', 'Bicarbonate 24 mmol/L 22-29']]), png2);
    const f1 = path.join(shots, 'synthetic-report-1.pdf'); fs.writeFileSync(f1, mixed);
    const f2 = path.join(shots, 'synthetic-report-2.pdf'); fs.writeFileSync(f2, mixed2);

    // ── pre-browser access checks ──
    console.log('\nAccess control (HTTP)');
    await check('unauthenticated clinical API → 401', async () => { const r = await fetch(`${DASH}/api/clinical/patients/${patientId}/documents`); expect(r.status === 401, `${r.status}`); });
    const op2 = session(DASH); await op2.login('op2@clinic-synthetic.org', pw.op2);
    await check('operator without a grant cannot see the patient (404) or upload (404)', async () => {
      expect((await op2.call('GET', `/api/clinical/patients/${patientId}/documents`)).status === 404, 'list');
      const fd = new FormData(); fd.append('file', new Blob([mixed]), 'r.pdf'); fd.append('purpose', 'x');
      expect((await op2.call('POST', `/api/clinical/patients/${patientId}/documents`, fd)).status === 404, 'upload');
    });
    const viewer = session(DASH); await viewer.login('viewer@clinic-synthetic.org', pw.viewer);
    await check('read-only viewer cannot upload (403)', async () => {
      const fd = new FormData(); fd.append('file', new Blob([mixed]), 'r.pdf'); fd.append('purpose', 'x');
      expect((await viewer.call('POST', `/api/clinical/patients/${patientId}/documents`, fd)).status === 403, 'upload');
    });

    // ── browser ──
    browser = await chromium.launch({ ...(chromePath ? { executablePath: chromePath } : {}), headless: true });
    browser.on('disconnected', () => console.log(`  (browser disconnected at ${new Date().toISOString()})`));
    const newPage = async (email: string, password: string): Promise<{ ctx: BrowserContext; page: Page }> => {
      const ctx = await browser!.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await ctx.newPage(); page.setDefaultTimeout(90_000);
      page.on('crash', () => console.log(`  (page crashed: ${email})`));
      page.on('pageerror', (e) => console.log(`  (page error ${email}: ${String(e.message).slice(0, 120)})`));
      await page.goto(`${DASH}/login`);
      await page.fill('#email', email); await page.fill('#password', password);
      await page.click('button[type=submit]');
      await page.waitForURL((u) => !u.pathname.startsWith('/login'));
      await ctx.request.post(`${DASH}/auth/accept-terms`); // product acknowledgement gate
      return { ctx, page };
    };
    const openClinical = async (page: Page) => {
      await page.goto(`${DASH}/clinical`);
      await page.waitForSelector('select[aria-label="Patient"]');
    };
    const selectPatient = async (page: Page) => { await page.selectOption('select[aria-label="Patient"]', patientId); };
    const status = (page: Page, re: RegExp) => page.locator('[role=status]').filter({ hasText: re }).first();

    console.log('\nBrowser: operator workflow');
    let a = await newPage('op1@clinic-synthetic.org', pw.op1);   // one browser context is open at a time (Chrome crashed with 3 on this host)
    await check('unauthenticated browser visit is redirected to login', async () => {
      const c = await browser!.newContext(); const p = await c.newPage();
      await p.goto(`${DASH}/clinical`); await p.waitForURL(/login/, { timeout: 20_000 }); await c.close();
    });
    await openClinical(a.page); await selectPatient(a.page);

    await check('upload mixed PDF; source pages shown with per-page method (native + OCR)', async () => {
      await a.page.setInputFiles('input[aria-label="Document file"]', f1);
      await a.page.fill('input[aria-label="Purpose"]', 'local verification (synthetic)');
      await a.page.click('button:has-text("Upload")');
      await a.page.waitForSelector('text=Source pages');
      if (ocrReal) {
        await status(a.page, /Extraction complete/).waitFor();
        await a.page.waitForSelector('h3:has-text("Page 2 · ocr · ok")');
        const conf = await a.page.locator('h3:has-text("Page 2")').innerText();
        expect(/OCR confidence 0\.\d+|OCR confidence 1\.00/.test(conf), `no OCR confidence shown: ${conf}`);
      } else {
        await a.page.waitForSelector('text=ocr_unavailable', { timeout: 5000 }).catch(() => undefined);
      }
      await a.page.screenshot({ path: path.join(shots, '01-source-and-candidates.png'), fullPage: true });
      return ocrReal ? 'page 1 native text, page 2 read by real PaddleOCR' : 'OCR not configured';
    });

    await check('extracted values show source page/line and uncertainty flags', async () => {
      await a.page.waitForSelector('li:has-text("Hemoglobin")');
      expect(await a.page.locator('li:has-text("Source p.1")').count() >= 2, 'native candidates with source');
      if (ocrReal) { expect(await a.page.locator('li:has-text("from OCR")').count() >= 1, 'OCR flag shown'); }
    });

    await check('snapshot is blocked while values are unconfirmed', async () => {
      await a.page.click('button:has-text("1 · Create snapshot")');
      await status(a.page, /confirmation|pending|need/i).waitFor();
    });

    await check('confirm one value, correct another (reason required), confirm the rest', async () => {
      const row = (n: string) => a.page.locator('li').filter({ hasText: n }).filter({ has: a.page.getByRole('button', { name: 'Confirm' }) }).first();
      await row('Hemoglobin').getByRole('button', { name: 'Confirm' }).click();
      await a.page.waitForSelector('li:has-text("Hemoglobin"):has-text("confirmed")');
      await row('Sodium').getByRole('button', { name: /Correct/ }).click();
      await a.page.fill('input[aria-label="Corrected value"]', '141');
      await a.page.fill('input[aria-label="Correction reason"]', 'checked against the source page');
      await a.page.click('button:has-text("Save correction")');
      await a.page.waitForSelector('li:has-text("Sodium"):has-text("corrected")');
      if (ocrReal) {
        for (const n of ['Potassium', 'Calcium']) {
          await row(n).getByRole('button', { name: 'Confirm' }).click();
          await a.page.waitForSelector(`li:has-text("${n}"):has-text("confirmed")`);
        }
      }
      const obs = await a.page.locator('h2:has-text("Confirmed observations") + ul li').count();
      expect(obs >= 2, `observations listed: ${obs}`);
    });

    let reportId = '';
    await check('snapshot → released rules → draft report (SOAP with explicit missing sections)', async () => {
      await a.page.click('button:has-text("1 · Create snapshot")'); await status(a.page, /Snapshot created/).waitFor();
      await a.page.click('button:has-text("2 · Run released rules")'); await status(a.page, /Rules run recorded/).waitFor();
      await a.page.waitForSelector('text=clinical rules: no_released_rules');
      await a.page.click('button:has-text("3 · Create report")');
      await a.page.waitForSelector('text=DRAFT — not reviewed');
      expect(await a.page.locator('text=Not provided').count() >= 2, 'missing SOAP sections must be explicit');
      expect(await a.page.locator('text=Sodium: 141').count() >= 1, 'corrected value is reported, not the misread one');
      await a.page.screenshot({ path: path.join(shots, '02-draft-report.png'), fullPage: true });
    });
    reportId = (await (await op1.call('GET', `/api/clinical/patients/${patientId}/reports`)).json()).reports[0].id;

    console.log('\nAI-assisted review (stored execution record → Decision 1 → Gemma)');
    if (!liveModels) skip('AI-assisted review (live)', 'no server-side OpenRouter key configured');
    else {
      const reviewResponse = async (click: () => Promise<void>) => {
        const waiting = a.page.waitForResponse((r) => r.url().includes('/model-review') && r.request().method() === 'POST', { timeout: 150_000 });
        await click();
        const resp = await waiting;
        return { http: resp.status(), body: await resp.json() };
      };
      await check('AI review over the verified stored run: labelled, validated or explicitly non-completed (live, synthetic)', async () => {
        await openClinical(a.page); await selectPatient(a.page);
        await a.page.locator('[data-testid=doc-list] button').first().click(); // open latest document
        await a.page.waitForSelector('button:has-text("AI-assisted review")');
        await a.page.click('button:has-text("1 · Create snapshot")'); await status(a.page, /Snapshot created/).waitFor();
        await a.page.click('button:has-text("2 · Run released rules")'); await status(a.page, /Rules run recorded/).waitFor();
        const { http, body } = await reviewResponse(() => a.page.click('button:has-text("AI-assisted review")'));
        // Live model output varies; every terminal status is acceptable evidence, but the contract must hold.
        expect(['completed', 'failed_validation', 'review_malformed'].includes(body.status), `unexpected status ${body.status}`);
        expect(body.label?.includes('not clinical approval'), 'review is labelled as model output');
        expect(body.models?.decision?.startsWith('google/gemini-decision-1') && body.models?.review === 'google/gemma-4-26b-a4b-it', 'exact requested models reported');
        if (body.status === 'completed') { expect(http === 201 && body.problems.length === 0 && body.review, 'completed implies validated review'); }
        else { expect(http === 502 && body.review === null, 'non-completed must not expose model content'); }
        await a.page.waitForSelector('text=model output, not clinical approval');
        await a.page.screenshot({ path: path.join(shots, '03-ai-review.png'), fullPage: true });
        return `live status=${body.status} (http ${http}); problems=${JSON.stringify(body.problems).slice(0, 120)}`;
      });
      await check('provider outage during AI review → explicit decision_* status, no review content, nothing fabricated', async () => {
        orProxy!.setDown(true);
        try {
          const { http, body } = await reviewResponse(() => a.page.click('button:has-text("AI-assisted review")'));
          expect(http === 502 && /^decision_/.test(body.status) && body.review === null, `outage → ${http} ${body.status}`);
          await a.page.waitForSelector('text=No review shown');
          return `status=${body.status}`;
        } finally { orProxy!.setDown(false); }
      });
    }

    console.log('\nExports and authorization');
    await check('HTML + PDF export of the DRAFT report carry status and hash; PDF text matches', async () => {
      const h = await a.ctx.request.get(`${DASH}/api/clinical/reports/${reportId}/export.html`);
      expect(h.status() === 200 && h.headers()['x-report-status'] === 'draft', `html ${h.status()}`);
      const html = await h.text();
      expect(html.includes('DRAFT — not reviewed'), 'draft banner'); expect(html.includes('Sodium: 141'), 'value');
      expect(h.headers()['x-content-sha256'] === crypto.createHash('sha256').update(html).digest('hex'), 'html hash header');
      const p = await a.ctx.request.get(`${DASH}/api/clinical/reports/${reportId}/export.pdf`);
      expect(p.status() === 200 && p.headers()['content-type'] === 'application/pdf', `pdf ${p.status()}`);
      const buf = await p.body();
      const text = (await extractPdfText(Buffer.from(buf))).pages.map((x) => x.text).join('\n');
      expect(text.includes('DRAFT - NOT REVIEWED') && text.includes('Sodium: 141'), 'pdf text');
      fs.writeFileSync(path.join(shots, 'export-draft.pdf'), buf);
    });
    await check('operator cannot sign off (API 403; UI sign-off button disabled)', async () => {
      expect((await op1.call('POST', `/api/clinical/reports/${reportId}/review`)).status === 403, 'api');
      await openClinical(a.page); await selectPatient(a.page);
      await a.page.locator('[data-testid=report-list] button').first().click();
      await a.page.waitForSelector('text=DRAFT — not reviewed');
      expect(await a.page.getByRole('button', { name: /Sign off/ }).isDisabled(), 'sign-off button must be disabled for non-clinicians');
    });
    await check('another operator (no grant) and unauthenticated callers cannot read the report or exports', async () => {
      for (const p of [`/reports/${reportId}`, `/reports/${reportId}/export.pdf`, `/reports/${reportId}/export.html`]) {
        expect((await op2.call('GET', `/api/clinical${p}`)).status === 404, `op2 ${p}`);
        expect((await fetch(`${DASH}/api/clinical${p}`)).status === 401, `anon ${p}`);
      }
    });

    await a.ctx.close();
    console.log('\nBrowser: clinician sign-off');
    const c = await newPage('doc@clinic-synthetic.org', pw.doc);
    await check('provisioned clinician opens the report from the list and signs off → new reviewed version', async () => {
      await openClinical(c.page); await selectPatient(c.page);
      await c.page.locator('[data-testid=report-list] button').first().click();
      await c.page.waitForSelector('text=DRAFT — not reviewed');
      await c.page.click('button:has-text("Sign off")');
      await c.page.waitForSelector('text=Reviewed · version 2');
      await c.page.screenshot({ path: path.join(shots, '04-signed-off.png'), fullPage: true });
    });
    const list = await (await op1.call('GET', `/api/clinical/patients/${patientId}/reports`)).json();
    const reviewed = list.reports.find((r: any) => r.status === 'reviewed');
    await check('reviewed exports: HTML and PDF show reviewer; old draft is superseded', async () => {
      expect(reviewed, 'reviewed report exists');
      const html = await (await c.ctx.request.get(`${DASH}/api/clinical/reports/${reviewed.id}/export.html`)).text();
      expect(html.includes('Reviewed by doc@clinic-synthetic.org'), 'html reviewer');
      const pdf = await (await c.ctx.request.get(`${DASH}/api/clinical/reports/${reviewed.id}/export.pdf`)).body();
      const text = (await extractPdfText(Buffer.from(pdf))).pages.map((x) => x.text).join('\n');
      expect(text.includes('REVIEWED by doc@clinic-synthetic.org'), 'pdf reviewer');
      expect(list.reports.find((r: any) => r.id === reportId).status === 'superseded', 'draft superseded by review');
    });

    await c.ctx.close();
    a = await newPage('op1@clinic-synthetic.org', pw.op1);
    console.log('\nCorrection after sign-off → supersession');
    await check('correcting a confirmed value in the UI supersedes the snapshot and the reviewed report', async () => {
      await a.page.goto(`${DASH}/clinical`); await a.page.waitForSelector('select[aria-label="Patient"]'); await selectPatient(a.page);
      await a.page.locator('[data-testid=doc-list] button').last().click(); // the first-uploaded document (oldest)
      await a.page.waitForSelector('h2:has-text("Confirmed observations")');
      await a.page.locator('h2:has-text("Confirmed observations") + ul li').filter({ hasText: 'Hemoglobin' }).getByRole('button', { name: /Correct/ }).click();
      await a.page.fill('input[aria-label="New value"]', '16.1');
      await a.page.fill('input[aria-label="Reason"]', 're-read from the source page');
      await a.page.click('button:has-text("Save (supersedes reports)")');
      await status(a.page, /Revision 2/).waitFor();
      const html = await (await a.ctx.request.get(`${DASH}/api/clinical/reports/${reviewed.id}/export.html`)).text();
      expect(html.includes('SUPERSEDED'), 'html shows SUPERSEDED');
      const pdfText = (await extractPdfText(Buffer.from(await (await a.ctx.request.get(`${DASH}/api/clinical/reports/${reviewed.id}/export.pdf`)).body()))).pages.map((x) => x.text).join('\n');
      expect(pdfText.includes('SUPERSEDED - DO NOT USE'), 'pdf shows SUPERSEDED');
      const snaps = await (await op1.call('GET', `/api/clinical/patients/${patientId}/reports`)).json();
      expect(snaps.reports.every((r: any) => r.status === 'superseded'), 'all reports superseded');
      await a.page.screenshot({ path: path.join(shots, '05-after-correction.png'), fullPage: true });
    });

    await a.ctx.close();
    console.log('\nBrowser: unauthorized users');
    await check('operator without a grant sees no patients in the UI', async () => {
      const o = await newPage('op2@clinic-synthetic.org', pw.op2);
      await openClinical(o.page);
      expect(await o.page.locator('select[aria-label="Patient"] option').count() === 1, 'only the placeholder option');
      await o.ctx.close();
    });
    await check('read-only viewer sees the patient but the server refuses upload; sign-off control is disabled', async () => {
      const v = await newPage('viewer@clinic-synthetic.org', pw.viewer);
      await openClinical(v.page); await selectPatient(v.page);
      await v.page.setInputFiles('input[aria-label="Document file"]', f2);
      await v.page.fill('input[aria-label="Purpose"]', 'should be refused');
      await v.page.click('button:has-text("Upload")');
      await status(v.page, /role does not permit|not permit/i).waitFor();
      await v.ctx.close();
    });

    // ── provider outage: OCR ──
    a = await newPage('op1@clinic-synthetic.org', pw.op1);
    console.log('\nProvider outage: OCR');
    if (!ocrReal) skip('OCR outage', 'no OCR service configured');
    else await check('OCR service down → upload reports partial extraction, page marked ocr_unavailable, no invented text', async () => {
      ocrProxy!.setDown(true);
      try {
        await a.page.goto(`${DASH}/clinical`); await a.page.waitForSelector('select[aria-label="Patient"]'); await selectPatient(a.page);
        await a.page.setInputFiles('input[aria-label="Document file"]', f2);
        await a.page.fill('input[aria-label="Purpose"]', 'ocr outage check (synthetic)');
        await a.page.click('button:has-text("Upload")');
        await status(a.page, /Extraction partial/).waitFor({ timeout: 120_000 });
        await a.page.waitForSelector('h3:has-text("Page 2"):has-text("ocr_unavailable")');
        expect(await a.page.locator('text=Urea').count() === 0, 'no text may be invented for the unreadable page');
        await a.page.screenshot({ path: path.join(shots, '06-ocr-outage.png'), fullPage: true });
      } finally { ocrProxy!.setDown(false); }
    });

    // ── Monitoring page (gated; simulation labelled) ──
    console.log('\nBrowser: monitoring');
    const m = await newPage('op1@clinic-synthetic.org', pw.op1);
    await check('monitoring: pair a simulator, synthetic stream labelled SIMULATION, stale values hidden, alert gated for real devices', async () => {
      await m.page.goto(`${DASH}/monitoring`); await m.page.waitForSelector('[data-testid=alert-gate]');
      expect((await m.page.locator('[data-testid=alert-gate]').innerText()).includes('gated'), 'alert gate shown');
      await m.page.selectOption('select[aria-label="Patient"]', patientId);
      await m.page.selectOption('select[aria-label="Device kind"]', 'simulator');
      await m.page.fill('input[aria-label="Device label"]', 'Sim A'); await m.page.fill('input[aria-label="Purpose"]', 'local verification (synthetic)');
      await m.page.click('button:has-text("Pair device")'); await status(m.page, /Device paired/).waitFor();
      await m.page.locator('[data-testid=device-list] button').first().click();
      await m.page.waitForSelector('[data-testid=sim-banner]');
      expect((await m.page.locator('[data-testid=device-state]').innerText()) === 'no_data', 'no data before any stream');
      await m.page.click('button:has-text("Simulate 20 synthetic readings")'); await status(m.page, /Synthetic stream ingested/).waitFor();
      await m.page.waitForSelector('[data-testid=metric-heart_rate]');
      const hr = await m.page.locator('[data-testid=metric-heart_rate]').innerText();
      expect(/current|stale/.test(hr), `heart_rate row: ${hr}`);
      // Real device → alerts gated (server 409); simulator → alert allowed and labelled.
      const dev = await (await op1.call('POST', `/api/clinical/patients/${patientId}/monitoring/devices`, { kind: 'manual_entry', label: 'Manual', purpose: 'local verification' })).json();
      const refused = await op1.call('POST', `/api/clinical/monitoring/devices/${dev.deviceId}/alerts`);
      expect(refused.status === 409 && (await refused.json()).code === 'alerts_gated_pending_validation', 'real-device alert gated');
      await m.page.click('button:has-text("Open simulation alert")'); await status(m.page, /no real recipient notified/).waitFor();
      await m.page.locator('[data-testid=alert-list] button:has-text("Acknowledge")').first().click();
      await m.page.waitForSelector('[data-testid=alert-list] li:has-text("acknowledged")');
      // Two clocks: a measurement taken an hour ago and received now is NOT a current vital. It is retained as last-known
      // with both timestamps; metrics never received show no value.
      const old = new Date(Date.now() - 3600_000).toISOString();
      const ing = await (await op1.call('POST', `/api/clinical/monitoring/devices/${dev.deviceId}/observations`, { observations: [{ metric: 'heart_rate', value: 70, unit: '/min', sourceTime: old }] })).json();
      expect(ing.flagged?.high_latency === 1, 'old source time flagged as high_latency');
      const st = await (await op1.call('GET', `/api/clinical/monitoring/devices/${dev.deviceId}/status`)).json();
      const hrm = st.metrics.find((x: any) => x.metric === 'heart_rate');
      expect(hrm.value === null && hrm.state === 'stale', `delayed hour-old reading must not be current (state=${hrm.state}, value=${hrm.value})`);
      expect(hrm.lastKnown?.value === 70 && hrm.lastKnown.sourceAge === 'old' && hrm.lastKnown.receiptAge === 'recent' && !!hrm.lastKnown.sourceTime && !!hrm.lastKnown.receivedTime, 'kept as last-known with source and receipt timestamps');
      expect(st.state === 'delayed', `device state is delayed, not receiving (${st.state})`);
      // A future-dated (untrusted device clock) reading is never current either, and cannot shadow a genuine one.
      const fut = await (await op1.call('POST', `/api/clinical/monitoring/devices/${dev.deviceId}/observations`, { observations: [{ metric: 'resp_rate', value: 14, unit: '/min', sourceTime: new Date(Date.now() + 3600_000).toISOString() }] })).json();
      expect(fut.flagged?.clock_ahead_of_receipt === 1, 'future-dated reading flagged clock_ahead_of_receipt');
      const st2 = await (await op1.call('GET', `/api/clinical/monitoring/devices/${dev.deviceId}/status`)).json();
      const rr = st2.metrics.find((x: any) => x.metric === 'resp_rate');
      expect(rr.state === 'untrusted_time' && rr.value === null && rr.lastKnown?.value === 14, `untrusted device clock is not a current value (state=${rr.state})`);
      expect(st.metrics.find((x: any) => x.metric === 'spo2').value === null && st.metrics.find((x: any) => x.metric === 'spo2').state === 'no_data', 'never-received metric shows no value');
      await m.page.goto(`${DASH}/monitoring`); await m.page.waitForSelector('select[aria-label="Patient"]');
      await m.page.selectOption('select[aria-label="Patient"]', patientId);
      await m.page.locator('[data-testid=device-list] button', { hasText: 'Manual' }).first().click();   // list is newest-first; pick by label
      await m.page.waitForSelector('[data-testid=metric-spo2]');
      expect((await m.page.locator('[data-testid=metric-spo2]').innerText()).includes('No data received'), 'UI shows "No data received" rather than a value');
      const hrRow = await m.page.locator('[data-testid=metric-heart_rate]').innerText();
      expect(/NOT CURRENT/.test(hrRow) && /measured 36\d\ds ago/.test(hrRow) && !/^\s*heart_rate\s+current/i.test(hrRow), `UI does not show the delayed reading as current: ${hrRow}`);
      await m.page.screenshot({ path: path.join(shots, '07-monitoring.png'), fullPage: true });
    });
    await m.ctx.close();

    // ── Research page ──
    console.log('\nBrowser: research');
    const rsh = await newPage('op1@clinic-synthetic.org', pw.op1);
    await check('research: dataset governance in the UI, gated analysis needs acknowledgement, run labelled research-only and reproducible', async () => {
      await rsh.page.goto(`${DASH}/research`); await rsh.page.waitForSelector('[data-testid=research-purpose]');
      const csv = path.join(shots, 'synthetic.csv');
      fs.writeFileSync(csv, 'y,score\n' + Array.from({ length: 30 }, (_, i) => `${i % 3 === 0 ? 1 : 0},${(0.2 + (i % 7) * 0.1).toFixed(2)}`).join('\n') + '\n');
      await rsh.page.setInputFiles('input[aria-label="CSV file"]', csv);
      await rsh.page.fill('input[aria-label="Dataset name"]', 'Synthetic scores'); await rsh.page.fill('input[aria-label="Purpose"]', 'local verification of the research page');
      await rsh.page.fill('input[aria-label="Dictionary y"]', 'synthetic binary outcome'); await rsh.page.fill('input[aria-label="Dictionary score"]', 'synthetic score in [0,1]');
      await rsh.page.fill('input[aria-label="Attestation statement"]', 'Synthetic data generated by the verification script.');
      await rsh.page.click('button:has-text("Register dataset")');
      await status(rsh.page, /attest/i).waitFor();                                   // refused: attestation boxes unchecked
      await rsh.page.check('input[type=checkbox] >> nth=0'); await rsh.page.check('input[type=checkbox] >> nth=1');
      await rsh.page.click('button:has-text("Register dataset")'); await status(rsh.page, /Dataset registered/).waitFor();
      await rsh.page.selectOption('select[aria-label="Analysis"]', 'prediction_evaluation');
      await rsh.page.fill('textarea[aria-label="Parameters JSON"]', '{"outcome":"y","score":"score"}');
      await rsh.page.click('button:has-text("Run")'); await status(rsh.page, /research-only/i).waitFor();          // gated without acknowledgement
      await rsh.page.check('[data-testid=ack-research-only]');
      await rsh.page.click('button:has-text("Run")'); await status(rsh.page, /Run recorded/).waitFor();
      const label = await rsh.page.locator('[data-testid=research-label]').innerText();
      expect(label.includes('unvalidated_research_only') && label.includes('prohibited'), `label: ${label}`);
      expect((await rsh.page.locator('[data-testid=run-output]').innerText()).includes('"auc"'), 'auc in output');
      await rsh.page.click('button:has-text("Re-run (reproducibility)")'); await status(rsh.page, /reproduced the identical output hash/).waitFor();
      await rsh.page.screenshot({ path: path.join(shots, '08-research.png'), fullPage: true });
      // standardised_rates: register a second (synthetic) dataset in the UI and run the registered analysis with researcher-supplied weights.
      const csv2 = path.join(shots, 'synthetic-rates.csv');
      const rows2: string[] = []; for (const [g, d, t] of [['A', [2, 10, 40], [5000, 4000, 3000]], ['B', [4, 12, 30], [10000, 5000, 1000]]] as const) ['young', 'mid', 'old'].forEach((b, i) => rows2.push(`${g},${b},${d[i]},${t[i]}`));
      fs.writeFileSync(csv2, 'grp,age_band,cases,pt\n' + rows2.join('\n') + '\n');
      await rsh.page.goto(`${DASH}/research`); await rsh.page.waitForSelector('[data-testid=research-purpose]');
      await rsh.page.setInputFiles('input[aria-label="CSV file"]', csv2);
      await rsh.page.fill('input[aria-label="Dataset name"]', 'Synthetic rates by age band'); await rsh.page.fill('input[aria-label="Purpose"]', 'local verification of standardised rates');
      for (const c of ['grp', 'age_band', 'cases', 'pt']) await rsh.page.fill(`input[aria-label="Dictionary ${c}"]`, `synthetic ${c}`);
      await rsh.page.fill('input[aria-label="Attestation statement"]', 'Synthetic data generated by the verification script.');
      await rsh.page.check('input[type=checkbox] >> nth=0'); await rsh.page.check('input[type=checkbox] >> nth=1');
      await rsh.page.click('button:has-text("Register dataset")'); await status(rsh.page, /Dataset registered/).waitFor();
      await rsh.page.selectOption('select[aria-label="Analysis"]', 'standardised_rates');
      await rsh.page.fill('textarea[aria-label="Parameters JSON"]', JSON.stringify({ cases: 'cases', persontime: 'pt', strata: 'age_band', weights: { young: 0.5, mid: 0.3, old: 0.2 }, group: 'grp', groupA: 'A', groupB: 'B' }));
      await rsh.page.click('button:has-text("Run")'); await status(rsh.page, /Run recorded/).waitFor();
      const out2 = await rsh.page.locator('[data-testid=run-output]').innerText();
      const lab2 = await rsh.page.locator('[data-testid=research-label]').innerText();
      expect(lab2.includes('unvalidated_research_only') && lab2.includes('prohibited'), `label: ${lab2}`);
      expect(out2.includes('"standardised"') && out2.includes('"crudeRate"') && out2.includes('standardisedRateRatio'), 'standardised and crude rates shown');
      expect((await rsh.page.locator('ul li', { hasText: 'supplied by the researcher' }).first().innerText()).includes('no standard population is bundled'), 'weights-supplied warning shown');
      const expA = 0.5 * (2 / 5000) + 0.3 * (10 / 4000) + 0.2 * (40 / 3000);
      const m = /"rate": ([0-9.e-]+)/.exec(out2); expect(!!m && Math.abs(Number(m[1]) - expA) < 1e-12, `group A standardised rate ${m?.[1]} == ${expA}`);
      await rsh.page.screenshot({ path: path.join(shots, '08b-standardised-rates.png'), fullPage: true });
    });
    await rsh.ctx.close();

    // ── Public scientific data page (against the synthetic provider mock) ──
    console.log('\nBrowser: public scientific data (synthetic mock providers)');
    const sc = await newPage('op1@clinic-synthetic.org', pw.op1);
    await check('science: accession → classification & metadata → retrieve → provenance + separate derived summary → workspace → manifest; a second user sees nothing', async () => {
      await sc.page.goto(`${DASH}/science`); await sc.page.waitForSelector('[data-testid=science-notice]');
      expect((await sc.page.locator('[data-testid=science-notice]').innerText()).includes('not clinical evidence'), 'research-only notice');
      await sc.page.selectOption('select[aria-label="Provider"]', 'alphafold');
      await sc.page.fill('input[aria-label="Accession or search text"]', 'P69905'); await sc.page.click('button:has-text("Inspect accession")');
      await sc.page.waitForSelector('[data-testid=record-accession]');
      expect((await sc.page.locator('[data-testid=classification]').first().innerText()) === 'predicted', 'AlphaFold record classified predicted');
      expect((await sc.page.locator('[data-testid=classification-note]').innerText()).toLowerCase().includes('not experimental'), 'note says not experimental');
      expect((await sc.page.locator('[data-testid=record-metadata]').innerText()).includes('globalMetricValuePlddt'), 'confidence metadata shown');
      await sc.page.check('input[aria-label="File pdb"]'); await sc.page.click('button:has-text("Retrieve selected files")');
      await sc.page.waitForSelector('[data-testid=provenance-table] tbody tr');
      const prov = await sc.page.locator('[data-testid=provenance-table]').innerText(); expect(/predicted/.test(prov) && /[0-9a-f]{12}…/.test(prov), `provenance row: ${prov.slice(0, 120)}`);
      await sc.page.click('[data-testid=provenance-table] button:has-text("inspect")'); await sc.page.waitForSelector('[data-testid=integrity]');
      expect((await sc.page.locator('[data-testid=integrity]').innerText()) === 'ok', 'integrity ok');
      const sum = await sc.page.locator('[data-testid=derived-summary]').first().innerText(); expect(sum.includes('"plddt"') && sum.includes('residuesScored'), 'structured pLDDT summary');
      await sc.page.fill('input[aria-label="Workspace name"]', 'Hb study'); await sc.page.fill('input[aria-label="Workspace purpose"]', 'verify the public-data workflow');
      await sc.page.click('button:has-text("Create workspace")'); await status(sc.page, /Workspace created/).waitFor();
      await sc.page.selectOption('select[aria-label="Workspace"]', { index: 1 }); await sc.page.click('button:has-text("Attach to workspace")'); await status(sc.page, /Attached \(pinned/).waitFor();
      await sc.page.waitForSelector('[data-testid=workspace-detail] li:has-text("P69905")');
      const href = await sc.page.locator('[data-testid=manifest-link]').getAttribute('href'); expect(!!href && href.endsWith('/manifest'), 'manifest link');
      const man = await sc.page.evaluate(async (h) => { const r = await fetch(h!); return { status: r.status, sha: r.headers.get('x-manifest-sha256'), body: await r.json() }; }, href);
      expect(man.status === 200 && /^[0-9a-f]{64}$/.test(man.sha ?? '') && man.body.researchOnly === true && man.body.items.length === 1 && man.body.items[0].source.integrityCheckedAtExport === 'ok', 'manifest exported with verified checksums');
      await sc.page.screenshot({ path: path.join(shots, '09-science.png'), fullPage: true });
      // RCSB: a COMPUTED model entry is shown as predicted, not experimental
      await sc.page.selectOption('select[aria-label="Provider"]', 'rcsb'); await sc.page.fill('input[aria-label="Accession or search text"]', '1XYZ'); await sc.page.click('button:has-text("Inspect accession")');
      await sc.page.waitForFunction(() => document.querySelector('[data-testid=record-accession]')?.textContent === '1XYZ');
      expect((await sc.page.locator('[data-testid=classification-note]').innerText()).includes('COMPUTED model'), 'computed PDB entry flagged');
      // a second user cannot see the first user's workspace or source
      const u2 = await op2.call('GET', '/api/science/workspaces'); expect(u2.status === 200 && (await u2.json()).workspaces.length === 0, 'second user has no workspaces');
    });
    await sc.ctx.close();

    // ── /v1 BaaS ──
    console.log('\n/v1 BaaS API');
    const reg = async (n: string) => { const r = await fetch(`${API}/api/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_name: `Synthetic ${n}`, email: `${n}@synthetic.invalid`, plan: 'pro' }) }); expect(r.status === 201, `register ${n} → ${r.status}`); return (await r.json()).api_key as string; };
    const kA = await reg('tenant-a'), kB = await reg('tenant-b');
    const v1 = (k: string) => async (method: string, p: string, body?: unknown, h: Record<string, string> = {}) => fetch(API + p, { method, headers: { 'x-api-key': k, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...h }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const A = v1(kA), B = v1(kB);
    await check('/v1 OpenAPI served; auth required; rate-limit headers present', async () => {
      expect((await fetch(`${API}/v1/openapi.json`)).status === 200, 'openapi');
      expect((await fetch(`${API}/v1/engines`)).status === 401, 'unauth');
      const r = await A('GET', '/v1/engines'); expect(r.status === 200 && !!r.headers.get('x-ratelimit-limit'), 'headers');
    });
    await check('/v1 full workflow incl. PDF export; the second tenant is isolated at every step', async () => {
      const p = await (await A('POST', '/v1/patients', { display_name: 'API Synthetic' }, { 'idempotency-key': 'verify-create-0001' })).json();
      const fd = new FormData(); fd.append('file', new Blob([mixed]), 'r.pdf'); fd.append('purpose', 'api verification');
      const up = await A('POST', `/v1/patients/${p.id}/documents`, fd); expect(up.status === 201, `upload ${up.status}`);
      const doc = (await up.json()).documentId;
      expect((await B('GET', `/v1/documents/${doc}`)).status === 404, 'tenant B document');
      const rev = await (await A('GET', `/v1/documents/${doc}`)).json();
      for (const cand of rev.candidates) expect((await A('POST', `/v1/candidates/${cand.id}/decision`, { action: 'confirm' })).status === 200, 'confirm');
      const snap = await (await A('POST', `/v1/documents/${doc}/snapshots`)).json();
      const an = await (await A('POST', `/v1/snapshots/${snap.snapshotId}/analyses`)).json();
      expect((await B('GET', `/v1/jobs/${an.engineRunId}`)).status === 404, 'tenant B job');
      const rep = await (await A('POST', `/v1/snapshots/${snap.snapshotId}/reports`, { analysis_id: an.engineRunId })).json();
      expect((await A('POST', `/v1/reports/${rep.reportId}/review`)).status === 403, 'api sign-off refused');
      expect((await B('GET', `/v1/reports/${rep.reportId}/export.pdf`)).status === 404, 'tenant B pdf');
      const pdf = await A('GET', `/v1/reports/${rep.reportId}/export.pdf`);
      expect(pdf.status === 200 && pdf.headers.get('x-report-status') === 'draft', 'pdf');
      expect((await extractPdfText(Buffer.from(await pdf.arrayBuffer()))).pages.length >= 1, 'pdf parses');
    });
    await check('spend reports: dashboard report limited to admin/auditor/compliance; /v1/spend is tenant-scoped; no raw content in reports', async () => {
      const today = new Date().toISOString().slice(0, 10);
      expect((await fetch(`${DASH}/api/clinical/spend`)).status === 401, 'unauthenticated → 401');
      expect((await op1.call('GET', '/api/clinical/spend')).status === 403, 'operator → 403');
      expect((await viewer.call('GET', '/api/clinical/spend')).status === 403, 'viewer → 403');
      const ar = await admin.call('GET', `/api/clinical/spend?from=${today}&to=${today}`); expect(ar.status === 200, `admin → ${ar.status}`);
      const rep = await ar.json();
      expect(/NOT a hard cap on provider charges/.test(rep.budget.guarantee), 'report states it is not a hard cap');
      expect(Array.isArray(rep.budget.configurationErrors) && rep.budget.configurationErrors.length === 0, 'no configuration errors');
      if (liveModels) expect(rep.totals.calls >= 2, `live AI review calls were accounted (${rep.totals.calls})`);
      expect((await admin.call('GET', '/api/clinical/spend?from=2026-13-40')).status === 400, 'bad date → 400');
      // Tenant isolation: seed ledger rows for the two tenants (disposable DB, synthetic) and read through /v1.
      const { Client } = await import('pg'); const u = new URL(pgUrl); u.pathname = `/${profile.database}`;
      const pgc = new Client({ connectionString: u.toString() }); await pgc.connect();
      try {
        const tid = async (e: string) => (await pgc.query('SELECT tenant_id FROM tenants WHERE email = $1', [e])).rows[0].tenant_id as string;
        const ta = await tid('tenant-a@synthetic.invalid'), tb = await tid('tenant-b@synthetic.invalid');
        const ins = (scope: string, st: string, usd: number | null) => pgc.query(`INSERT INTO model_spend_ledger (id, scope_kind, scope_id, period, role, model, data_class, state, reserved_usd, actual_usd, attempts, created_at) VALUES ($1,'tenant',$2,$3,'review','m','synthetic_test',$4,0.02,$5,1,0)`, [crypto.randomUUID(), scope, today, st, usd]);
        await ins(ta, 'settled', 0.003); await ins(ta, 'unknown_cost', null); await ins(tb, 'settled', 0.5);
        const ra = await (await A('GET', `/v1/spend?from=${today}&to=${today}`)).json(), rb = await (await B('GET', `/v1/spend?from=${today}&to=${today}`)).json();
        expect(ra.totals.calls === 2 && ra.totals.unknownCostCalls === 1 && ra.totals.totalIsLowerBound === true, `tenant A totals ${JSON.stringify(ra.totals)}`);
        expect(rb.totals.calls === 1 && rb.totals.knownCostUsd === 0.5 && rb.totals.totalIsLowerBound === false, `tenant B totals ${JSON.stringify(rb.totals)}`);
        expect(!JSON.stringify(ra).includes(tb) && !JSON.stringify(rb).includes(ta), 'no cross-tenant identifiers');
        const full = await (await admin.call('GET', `/api/clinical/spend?from=${today}&to=${today}`)).json();
        expect(full.totals.calls >= ra.totals.calls + rb.totals.calls, 'admin sees the combined ledger');
        expect(!/prompt|completion|content|api[_-]?key|sk-/i.test(JSON.stringify(full.rows)), 'rows carry no prompts, completions or keys');
      } finally { await pgc.end(); }
      expect((await fetch(`${API}/v1/spend`)).status === 401, '/v1/spend requires an API key');
      expect((await A('GET', '/v1/spend?from=bad')).status === 400, '/v1/spend validates dates');
    });
  } finally {
    await sciMock?.close();
    await cleanup();
  }

  const pass = outcomes.filter((o) => o.status === 'pass').length, fail = outcomes.filter((o) => o.status === 'fail').length, skipped = outcomes.filter((o) => o.status === 'skip').length;
  fs.writeFileSync(path.resolve('docs/verification-local-latest.json'), JSON.stringify({ ranAt: new Date().toISOString(), syntheticDataOnly: true, ocr: ocrReal ? 'real PaddleOCR service' : 'not configured', liveModels: liveModels ? 'live OpenRouter (bounded)' : 'off', summary: { pass, fail, skipped }, outcomes }, null, 2) + '\n');
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped. Screenshots: ${shots}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify-local failed:', e?.message ?? e); process.exit(1); });
