import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { extractDocument, paddleServiceEngine, OcrEngine } from './ocr';
import { buildTestPdf } from './test-pdf';

const LAB = ['Synthetic Laboratory Report', 'Hemoglobin 13.2 g/dL 12.0-15.5'];
const fakeEngine = (impl: OcrEngine['recognize']): OcrEngine => ({ name: 'fake', recognize: impl });

describe('extractDocument', () => {
  it('OCRs only image-only pages of a mixed PDF and records the method per page', async () => {
    const calls: string[] = [];
    const engine = fakeEngine(async (png, fn) => {
      calls.push(fn);
      expect(png.subarray(1, 4).toString()).toBe('PNG'); // a real rendered page image
      return { status: 'ok', lines: [{ text: 'Glucose 5.4 mmol/L', confidence: 0.91 }], meanConfidence: 0.91, engine: 'fake' };
    });
    const r = await extractDocument(buildTestPdf([LAB, null]), 'application/pdf', { ocr: engine });
    expect(r.status).toBe('complete');
    expect(calls).toEqual(['page-2.png']);
    expect(r.pages.map((p) => p.method)).toEqual(['native_text', 'ocr']);
    expect(r.pages[1].ocr?.meanConfidence).toBe(0.91);
  });

  it('OCR outage is explicit: document is partial, page marked ocr_unavailable', async () => {
    const engine = fakeEngine(async () => ({ status: 'unavailable', error: 'ocr_service_unavailable', lines: [], meanConfidence: null, engine: 'fake' }));
    const r = await extractDocument(buildTestPdf([LAB, null]), 'application/pdf', { ocr: engine });
    expect(r.status).toBe('partial');
    expect(r.pages[1].status).toBe('ocr_unavailable');
  });

  it('no OCR configured: scanned pages are reported, not dropped', async () => {
    const r = await extractDocument(buildTestPdf([null]), 'application/pdf');
    expect(r.status).toBe('failed');
    expect(r.pages[0].status).toBe('ocr_unavailable');
  });

  it('parser failures propagate as failed with a reason', async () => {
    const r = await extractDocument(Buffer.from('not a pdf'), 'application/pdf');
    expect(r).toMatchObject({ status: 'failed', error: 'not_a_pdf' });
  });

  it('images require an OCR engine', async () => {
    expect((await extractDocument(Buffer.from('x'), 'image/png')).error).toBe('ocr_not_configured');
  });
});

describe('paddleServiceEngine client', () => {
  let server: http.Server;
  let mode = 'ok';
  let url: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ lines: [{ text: 'A 1', confidence: 0.8 }, { text: 'B 2', confidence: 0.6 }], engine_version: 'test' })); }
        else if (mode === '500') { res.writeHead(500); res.end('{"error":"x"}'); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"legacy shape"}'); }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('parses lines and mean confidence', async () => {
    mode = 'ok';
    const r = await paddleServiceEngine(url).recognize(Buffer.from('png'), 'p.png');
    expect(r).toMatchObject({ status: 'ok', meanConfidence: 0.7, engine: 'paddleocr-service@test' });
  });

  it('HTTP errors and malformed bodies are failures', async () => {
    mode = '500';
    expect((await paddleServiceEngine(url).recognize(Buffer.from('png'), 'p.png')).error).toBe('ocr_http_500');
    mode = 'legacy';
    expect((await paddleServiceEngine(url).recognize(Buffer.from('png'), 'p.png')).error).toBe('ocr_bad_response');
  });

  it('a stopped service is reported as unavailable', async () => {
    const r = await paddleServiceEngine('http://127.0.0.1:1', 2000).recognize(Buffer.from('png'), 'p.png');
    expect(r.status).toBe('unavailable');
  });
});
