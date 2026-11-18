/**
 * OCR engines and page-level document extraction (plan F06, §7.1–7.2).
 *
 * Pages with usable native text keep it; low-text/empty pages are rendered to PNG
 * and sent to the configured OCR engine. Every page records how its text was
 * obtained and with what confidence. OCR outages are explicit (`unavailable`),
 * never silently skipped. Which engine is better for a given document set must
 * be decided by the evaluation in plan §7.2 — nothing here asserts accuracy.
 */
import axios from 'axios';
import FormData from 'form-data';
import { PDFParse } from 'pdf-parse';
import { extractPdfText, PdfExtraction, DEFAULT_PDF_LIMITS, PdfLimits } from './pdf-extract';
import { safeErrorSummary } from '../security/redact';
import { logger } from '../logger';

export interface OcrLine { text: string; confidence: number | null; bbox?: number[][] }
export interface OcrResult {
  status: 'ok' | 'unavailable' | 'failed' | 'blocked_by_egress_policy';
  error?: string;
  lines: OcrLine[];
  meanConfidence: number | null;
  engine: string;
}

export interface OcrEngine { name: string; recognize(png: Buffer, filename: string): Promise<OcrResult> }

export function meanConfidence(lines: OcrLine[]): number | null {
  const c = lines.map((l) => l.confidence).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
}

/** Client for ocr_server.py (local PaddleOCR service). */
export function paddleServiceEngine(baseUrl = process.env.OCR_SERVICE_URL ?? 'http://127.0.0.1:4001', timeoutMs = 60_000): OcrEngine {
  const name = 'paddleocr-service';
  return {
    name,
    async recognize(png, filename) {
      try {
        const form = new FormData();
        form.append('file', png, { filename, contentType: 'image/png' });
        const r = await axios.post(`${baseUrl}/ocr`, form, { headers: form.getHeaders(), timeout: timeoutMs, validateStatus: () => true });
        if (r.status !== 200) return { status: 'failed', error: `ocr_http_${r.status}`, lines: [], meanConfidence: null, engine: name };
        const raw = Array.isArray(r.data?.lines) ? r.data.lines : null;
        if (!raw) return { status: 'failed', error: 'ocr_bad_response', lines: [], meanConfidence: null, engine: name };
        const lines: OcrLine[] = raw
          .filter((l: any) => typeof l?.text === 'string')
          .map((l: any) => ({ text: l.text, confidence: typeof l.confidence === 'number' ? l.confidence : null, bbox: Array.isArray(l.bbox) ? l.bbox : undefined }));
        return { status: 'ok', lines, meanConfidence: meanConfidence(lines), engine: `${name}${r.data?.engine_version ? `@${r.data.engine_version}` : ''}` };
      } catch (err: any) {
        const code = err?.code;
        const unavailable = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
        logger.warn(`OCR request failed: ${safeErrorSummary(err)}`);
        return { status: unavailable ? 'unavailable' : 'failed', error: unavailable ? 'ocr_service_unavailable' : 'ocr_request_failed', lines: [], meanConfidence: null, engine: name };
      }
    },
  };
}

export async function renderPdfPages(buf: Buffer, pages: number[], scale = 2): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>();
  if (!pages.length) return out;
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r: any = await parser.getScreenshot({ partial: pages, scale } as any);
    for (const p of r.pages ?? []) if (p?.data) out.set(p.pageNumber, Buffer.from(p.data));
  } finally {
    try { await parser.destroy(); } catch { /* ignore */ }
  }
  return out;
}

export interface ExtractedPage {
  page: number;
  method: 'native_text' | 'ocr' | 'none';
  text: string;
  nativeChars: number;
  ocr?: { status: OcrResult['status']; engine: string; meanConfidence: number | null; error?: string; lines: OcrLine[] };
  status: 'ok' | 'ocr_unavailable' | 'ocr_failed' | 'no_text';
}

export interface DocumentExtraction {
  status: 'complete' | 'partial' | 'failed';
  error?: string;
  mediaType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain';
  pageCount: number;
  pages: ExtractedPage[];
  parser: string;
}

export async function extractDocument(
  buf: Buffer,
  mediaType: DocumentExtraction['mediaType'],
  opts: { ocr?: OcrEngine; limits?: Partial<PdfLimits> } = {},
): Promise<DocumentExtraction> {
  if (mediaType === 'text/plain') {
    const text = buf.toString('utf8');
    return { status: 'complete', mediaType, pageCount: 1, parser: 'plain-text', pages: [{ page: 1, method: 'native_text', text, nativeChars: text.replace(/\s+/g, '').length, status: 'ok' }] };
  }
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') {
    if (!opts.ocr) return { status: 'failed', error: 'ocr_not_configured', mediaType, pageCount: 1, parser: 'image', pages: [] };
    const r = await opts.ocr.recognize(buf, mediaType === 'image/png' ? 'page-1.png' : 'page-1.jpg');
    const page = ocrPage(1, 0, '', r);
    return { status: page.status === 'ok' ? 'complete' : 'failed', error: page.status === 'ok' ? undefined : page.status, mediaType, pageCount: 1, parser: 'image', pages: [page] };
  }

  const native: PdfExtraction = await extractPdfText(buf, { ...DEFAULT_PDF_LIMITS, ...opts.limits });
  if (native.status === 'failed') return { status: 'failed', error: native.error, mediaType, pageCount: native.pageCount, parser: 'pdf-parse v2', pages: [] };

  const needOcr = native.pages.filter((p) => p.needsOcr).map((p) => p.page);
  let rendered = new Map<number, Buffer>();
  if (needOcr.length && opts.ocr) {
    try { rendered = await renderPdfPages(buf, needOcr); } catch (err) { logger.warn(`page render failed: ${safeErrorSummary(err)}`); }
  }
  const pages: ExtractedPage[] = [];
  for (const p of native.pages) {
    if (!p.needsOcr) { pages.push({ page: p.page, method: 'native_text', text: p.text, nativeChars: p.chars, status: 'ok' }); continue; }
    if (!opts.ocr) { pages.push({ page: p.page, method: p.chars ? 'native_text' : 'none', text: p.text, nativeChars: p.chars, status: 'ocr_unavailable' }); continue; }
    const png = rendered.get(p.page);
    if (!png) { pages.push({ page: p.page, method: 'none', text: p.text, nativeChars: p.chars, status: 'ocr_failed', ocr: { status: 'failed', engine: opts.ocr.name, meanConfidence: null, error: 'page_render_failed', lines: [] } }); continue; }
    pages.push(ocrPage(p.page, p.chars, p.text, await opts.ocr.recognize(png, `page-${p.page}.png`)));
  }
  const bad = pages.filter((p) => p.status !== 'ok').length;
  return { status: bad === 0 ? 'complete' : bad === pages.length ? 'failed' : 'partial', error: bad ? 'some_pages_without_text' : undefined, mediaType, pageCount: native.pageCount, parser: 'pdf-parse v2', pages };
}

function ocrPage(page: number, nativeChars: number, nativeText: string, r: OcrResult): ExtractedPage {
  const ocr = { status: r.status, engine: r.engine, meanConfidence: r.meanConfidence, error: r.error, lines: r.lines };
  if (r.status === 'ok') {
    const text = r.lines.map((l) => l.text).join('\n');
    return { page, method: 'ocr', text, nativeChars, ocr, status: text.trim() ? 'ok' : 'no_text' };
  }
  return { page, method: nativeChars ? 'native_text' : 'none', text: nativeText, nativeChars, ocr, status: r.status === 'unavailable' ? 'ocr_unavailable' : 'ocr_failed' };
}
