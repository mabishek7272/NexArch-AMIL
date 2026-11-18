import { describe, expect, it } from 'vitest';
import { extractPdfText, looksLikePdf } from './pdf-extract';
import { buildTestPdf } from './test-pdf';

const LAB = ['Synthetic Laboratory Report', 'Hemoglobin 13.2 g/dL 12.0-15.5', 'Potassium <0.5 mmol/L 3.5-5.1', 'Specimen: venous blood'];

describe('extractPdfText (pdf-parse v2)', () => {
  it('extracts native text per page', async () => {
    const r = await extractPdfText(buildTestPdf([LAB]));
    expect(r.status).toBe('ok');
    expect(r.pageCount).toBe(1);
    expect(r.pages[0].quality).toBe('usable');
    expect(r.pages[0].text).toContain('Hemoglobin 13.2 g/dL');
    expect(r.pages[0].text).toContain('<0.5'); // inequality preserved
  });

  it('flags only the image-only page of a mixed document for OCR', async () => {
    const r = await extractPdfText(buildTestPdf([LAB, null, ['Page three text is long enough to be usable as native text.']]));
    expect(r.status).toBe('ok');
    expect(r.pages.map((p) => p.needsOcr)).toEqual([false, true, false]);
    expect(r.pages[1].quality).toBe('empty');
  });

  it('marks very short pages as low_text', async () => {
    const r = await extractPdfText(buildTestPdf([['p. 2']]));
    expect(r.pages[0]).toMatchObject({ quality: 'low_text', needsOcr: true });
  });

  it('returns explicit failures instead of empty success', async () => {
    expect((await extractPdfText(Buffer.from('hello'))).error).toBe('not_a_pdf');
    expect((await extractPdfText(Buffer.from('%PDF-1.4\n garbage without structure'))).status).toBe('failed');
    expect((await extractPdfText(buildTestPdf([LAB]), { maxBytes: 10 })).error).toBe('too_large');
    expect((await extractPdfText(buildTestPdf([LAB, LAB, LAB]), { maxPages: 2 })).error).toBe('too_many_pages');
  });

  it('signature check', () => {
    expect(looksLikePdf(buildTestPdf([LAB]))).toBe(true);
    expect(looksLikePdf(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });
});
