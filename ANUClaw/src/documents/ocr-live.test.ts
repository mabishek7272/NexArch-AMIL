/**
 * REAL PaddleOCR service test on SYNTHETIC rendered pages. Opt-in:
 *   ANUCLAW_OCR_SERVICE_URL=http://127.0.0.1:54001 npx vitest run src/documents/ocr-live.test.ts
 * (service: .venv-ocr/bin/python -I ocr_server.py with OCR_PORT=54001)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { paddleServiceEngine, renderPdfPages, extractDocument } from './ocr';
import { buildTestPdf, buildScannedPdf } from './test-pdf';
import { parseLabLines } from './lab-parser';

const URL_ = process.env.ANUCLAW_OCR_SERVICE_URL;
const LINES = ['SYNTHETIC LAB REPORT', 'Hemoglobin 16.4 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145', 'Potassium 4.1 mmol/L 3.5-5.1'];

const scannedPdf = buildScannedPdf;

describe.skipIf(!URL_)('PaddleOCR service (real, synthetic pages)', () => {
  it('recognises rendered text lines with confidence and boxes; parser recovers values', async () => {
    const png = (await renderPdfPages(buildTestPdf([LINES]), [1], 2)).get(1)!;
    const r = await paddleServiceEngine(URL_).recognize(png, 'synthetic.png');
    expect(r.status).toBe('ok');
    expect(r.engine).toMatch(/paddleocr-service@paddleocr-\d/);
    expect(r.lines.length).toBeGreaterThanOrEqual(4);
    for (const l of r.lines) {
      expect(l.confidence).toBeGreaterThan(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
      expect(l.bbox).toHaveLength(4);
    }
    const text = r.lines.map((l) => l.text).join('\n');
    console.log('OCR lines:', JSON.stringify(r.lines.map((l) => [l.text, Number(l.confidence?.toFixed(3))])));
    const cands = parseLabLines(text, 1, 'ocr', r.meanConfidence);
    const hb = cands.find((c) => /hemoglobin/i.test(c.analyte));
    expect(hb?.valueRaw).toBe('16.4');
    expect(hb?.refLow).toBe(12);
  }, 120_000);

  it('a scanned (image-only) PDF page goes through page-level OCR in the document pipeline', async () => {
    const png = (await renderPdfPages(buildTestPdf([LINES]), [1], 2)).get(1)!;
    const pdf = await scannedPdf(png);
    const r = await extractDocument(pdf, 'application/pdf', { ocr: paddleServiceEngine(URL_) });
    expect(r.status).toBe('complete');
    expect(r.pages[0].method).toBe('ocr');
    expect(r.pages[0].nativeChars).toBe(0);
    expect(r.pages[0].ocr?.meanConfidence).toBeGreaterThan(0.5);
    expect(r.pages[0].text).toMatch(/Sodium/i);
  }, 120_000);

  it('a blank page yields no lines (not invented text); wrong content types are HTTP errors', async () => {
    const blank = (await renderPdfPages(buildTestPdf([['.']]), [1], 1)).get(1)!;
    const r = await paddleServiceEngine(URL_).recognize(blank, 'blank.png');
    expect(r.status).toBe('ok');
    expect(r.lines.filter((l) => l.text.trim().length > 2)).toHaveLength(0);
    // The client always sends image/png; post a non-image body directly to check server behaviour.
    const fd = new FormData();
    fd.append('file', new Blob(['not an image'], { type: 'text/plain' }), 'x.txt');
    expect((await fetch(`${URL_}/ocr`, { method: 'POST', body: fd })).status).toBe(400);
    const empty = new FormData();
    empty.append('file', new Blob([], { type: 'image/png' }), 'e.png');
    expect((await fetch(`${URL_}/ocr`, { method: 'POST', body: empty })).status).toBe(400);
  }, 120_000);
});
