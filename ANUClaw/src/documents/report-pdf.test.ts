import { describe, expect, it } from 'vitest';
import { runRules } from './rules';
import { buildReport, SnapshotObservation } from './report';
import { renderReportPdf } from './report-pdf';
import { extractPdfText } from './pdf-extract';

const obs = (n: number): SnapshotObservation[] => Array.from({ length: n }, (_, i) => ({
  id: `o${i}`, analyte: `Analyte ${i}`, valueRaw: i % 3 === 0 ? '<0.01' : `${10 + i}.5`, valueNum: i % 3 === 0 ? 0.01 : 10 + i + 0.5,
  comparator: i % 3 === 0 ? '<' : null, unit: 'µmol/L', refLow: 10, refHigh: 20, page: 1, method: 'native_text', revision: 1, status: 'confirmed',
}));
const report = (o: SnapshotObservation[]) => buildReport({ snapshotId: 's', snapshotHash: 'h'.repeat(64), ruleRunId: 'r', ruleRunOutputHash: 'o'.repeat(64), rules: runRules(o), observations: o, documentLabel: 'd', createdAt: '2026-11-17T00:00:00Z' });

describe('renderReportPdf', () => {
  it('renders a valid PDF whose text matches the structured report', async () => {
    const o = obs(3);
    const pdf = await renderReportPdf(report(o), { reportId: 'rep1', version: 1, status: 'draft' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const t = await extractPdfText(pdf);
    // The extractor maps the µ glyph to Greek mu (U+03BC); compare NFKC-normalised text.
    const text = t.pages.map((p) => p.text).join('\n').normalize('NFKC');
    expect(text).toContain('DRAFT - NOT REVIEWED');
    expect(text).toContain('Analyte 1: 11.5 µmol/L'.normalize('NFKC'));
    expect(text).toContain('<0.01');
    expect(text).toMatch(/Not provided/);
  });

  it('long reports paginate with the status banner and page numbers on every page', async () => {
    const pdf = await renderReportPdf(report(obs(80)), { reportId: 'rep2', version: 3, status: 'superseded' });
    const t = await extractPdfText(pdf);
    expect(t.pageCount).toBeGreaterThan(1);
    for (const p of t.pages) {
      expect(p.text).toContain('SUPERSEDED - DO NOT USE');
      expect(p.text).toMatch(new RegExp(`Page ${p.page} of ${t.pageCount}`));
    }
  });

  it('transliterates characters outside the PDF font encoding instead of dropping them', async () => {
    const r = report(obs(1));
    r.layman.items.push('Value ≤ 5 — check “this”');
    const t = await extractPdfText(await renderReportPdf(r, { reportId: 'rep3', version: 1, status: 'draft' }));
    expect(t.pages.map((p) => p.text).join(' ')).toContain('Value <= 5 - check "this"');
  });
});
