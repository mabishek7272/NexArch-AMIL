/**
 * Page-level native PDF text extraction using the installed pdf-parse v2 API
 * (plan F06; replaces the broken v1-style `require('pdf-parse')(buffer)` call).
 *
 * Each page is assessed independently so mixed documents (text pages + scanned
 * pages) route only the low-text pages to OCR. Failures are explicit statuses,
 * never an empty "success".
 */
import { PDFParse } from 'pdf-parse';

export type PageQuality = 'usable' | 'low_text' | 'empty';

export interface PageText {
  page: number;
  text: string;
  /** Non-whitespace characters on the page. */
  chars: number;
  quality: PageQuality;
  /** True when native text is insufficient and OCR should be attempted. */
  needsOcr: boolean;
}

export type PdfFailure = 'not_a_pdf' | 'too_large' | 'too_many_pages' | 'encrypted' | 'invalid_pdf' | 'parse_error';

export interface PdfExtraction {
  status: 'ok' | 'failed';
  error?: PdfFailure;
  pageCount: number;
  pages: PageText[];
  parser: { name: 'pdf-parse'; api: 'v2' };
}

export interface PdfLimits { maxBytes: number; maxPages: number; minUsableChars: number }
export const DEFAULT_PDF_LIMITS: PdfLimits = { maxBytes: 25 * 1024 * 1024, maxPages: 200, minUsableChars: 40 };

export function looksLikePdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function assessPage(page: number, text: string, minUsableChars: number): PageText {
  const chars = text.replace(/\s+/g, '').length;
  const quality: PageQuality = chars === 0 ? 'empty' : chars < minUsableChars ? 'low_text' : 'usable';
  return { page, text, chars, quality, needsOcr: quality !== 'usable' };
}

const fail = (error: PdfFailure, pageCount = 0): PdfExtraction => ({ status: 'failed', error, pageCount, pages: [], parser: { name: 'pdf-parse', api: 'v2' } });

export async function extractPdfText(buf: Buffer, limits: Partial<PdfLimits> = {}): Promise<PdfExtraction> {
  const lim = { ...DEFAULT_PDF_LIMITS, ...limits };
  if (!looksLikePdf(buf)) return fail('not_a_pdf');
  if (buf.length > lim.maxBytes) return fail('too_large');

  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({ data: new Uint8Array(buf) });
    const info = await parser.getInfo();
    const total = Number((info as { total?: number }).total ?? 0);
    if (total > lim.maxPages) return fail('too_many_pages', total);
    const result = await parser.getText();
    const pages = (result.pages ?? [])
      .slice()
      .sort((a, b) => a.num - b.num)
      .map((p) => assessPage(p.num, p.text ?? '', lim.minUsableChars));
    return { status: 'ok', pageCount: result.total ?? pages.length, pages, parser: { name: 'pdf-parse', api: 'v2' } };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'PasswordException') return fail('encrypted');
    if (name === 'InvalidPDFException' || name === 'FormatError') return fail('invalid_pdf');
    return fail('parse_error');
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }
}
