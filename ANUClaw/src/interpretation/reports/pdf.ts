/**
 * PDF rendering (interpretation engine, P4c): headless Chromium through playwright-core (already a dependency).
 *
 * The page has no script and no external resource, and the browser context is created with JavaScript disabled and every
 * request that is not a data: URL aborted, so rendering cannot reach the network or the filesystem. If Chromium cannot
 * start, `PdfUnavailable` is thrown and the route answers 503 pdf_renderer_unavailable; HTML keeps working.
 * The status banner is repeated in the header of EVERY page and the page number in the footer.
 */
import { esc } from './render';

export class PdfUnavailable extends Error { constructor() { super('pdf renderer unavailable'); } }

const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 30_000;
let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active += 1;
  try { return await fn(); } finally { active -= 1; waiting.shift()?.(); }
}

export async function renderPdf(html: string, bannerText: string, footerNote: string): Promise<Buffer> {
  return slot(async () => {
    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true, timeout: TIMEOUT_MS });
      const ctx = await browser.newContext({ javaScriptEnabled: false, offline: true });
      await ctx.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: TIMEOUT_MS });
      const pdf = await page.pdf({
        format: 'A4', printBackground: true, displayHeaderFooter: true, margin: { top: '22mm', bottom: '18mm', left: '14mm', right: '14mm' },
        headerTemplate: `<div style="width:100%;font:600 9px system-ui,sans-serif;padding:5px 14mm;border-bottom:1px solid #999;color:#222">${esc(bannerText)}</div>`,
        footerTemplate: `<div style="width:100%;font:8px system-ui,sans-serif;padding:0 14mm;color:#555;display:flex;justify-content:space-between"><span>${esc(footerNote)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      });
      return Buffer.from(pdf);
    } catch (e) {
      throw Object.assign(new PdfUnavailable(), { cause: e instanceof Error ? e.name : 'unknown' });
    } finally {
      await browser?.close().catch(() => { /* already gone */ });
    }
  });
}
