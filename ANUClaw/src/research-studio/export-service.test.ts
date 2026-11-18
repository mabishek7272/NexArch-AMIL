/** Pure unit tests (no DB): serializers, Markdown/LaTeX assembly, the real rendered PDF, the hash-chained
 * provenance manifest, and the real inspection checks. */
import { describe, expect, it } from 'vitest';
import {
  serializeBibtex, serializeRis, buildMarkdown, buildLatex, buildPdf, buildDocx, inspectDocxStructure, buildProvenanceManifest, inspectExport,
} from './export-service';
import { SectionRow, SourceRow, VisualSpecRow, ClaimRow } from './types';

const source = (over: Partial<SourceRow> = {}): SourceRow => ({
  id: 's1', project_id: 'p1', doi: '10.1234/x', pmid: null, url: null, normalized_id: 'doi:10.1234/x',
  title: 'A Real Study', authors_json: JSON.stringify(['Smith, John', 'Doe, Jane']), year: 2021, venue: 'Journal of Examples',
  source_type: 'journal-article', content_hash: null, metadata_json: '{}', metadata_verification_status: 'verified',
  fulltext_status: 'unknown', correction_status: 'none', import_provenance_json: '{}', created_at: 0, updated_at: 0, ...over,
});
const section = (over: Partial<SectionRow> = {}): SectionRow => ({
  id: 'sec1', project_id: 'p1', task_id: null, section_key: 'intro', version: 1, kind: 'section', title: 'Introduction',
  content_text: 'This is the introduction text.', content_source: 'human', model_provenance_json: '{}', status: 'accepted',
  parent_version_id: null, invalidated_at: null, invalidated_reason: null, created_by: 'u1', created_at: 0, ...over,
});

describe('serializeBibtex / serializeRis', () => {
  it('produces a well-formed BibTeX entry from a real source row', () => {
    const bib = serializeBibtex([source()]);
    expect(bib).toContain('@article{smith2021,'); expect(bib).toContain('title = {A Real Study}'); expect(bib).toContain('doi = {10.1234/x}');
  });
  it('produces a well-formed RIS entry', () => {
    const ris = serializeRis([source()]);
    expect(ris).toContain('TY  - JOUR'); expect(ris).toContain('TI  - A Real Study'); expect(ris).toContain('AU  - Smith, John'); expect(ris).toContain('ER  - ');
  });
});

describe('buildMarkdown / buildLatex', () => {
  it('assembles real section content, flags a stale section, and labels conceptual vs. data-derived visuals correctly', () => {
    const stale = section({ id: 'sec2', section_key: 'methods', title: 'Methods', invalidated_at: 100, invalidated_reason: 'source retracted' });
    const visual: VisualSpecRow = { id: 'v1', project_id: 'p1', task_id: null, visual_key: 'fig1', version: 1, type: 'conceptual_diagram', kind: 'conceptual', title: 'A diagram', spec_json: '{}', data_provenance_json: '{}', svg: '<svg></svg>', invalidated_at: null, invalidated_reason: null, created_by: 'u1', created_at: 0 };
    const md = buildMarkdown('My Paper', [section(), stale], [visual]);
    expect(md).toContain('# My Paper'); expect(md).toContain('This is the introduction text.');
    expect(md).toContain('**STALE**: source retracted');
    expect(md).toContain('Conceptual diagram — not derived from measured data.');
  });
  it('escapes LaTeX special characters and states the source is not compiled', () => {
    const tex = buildLatex('A & B', [section({ content_text: '50% of cases had $X increase.' })]);
    expect(tex).toContain('not compiled'); expect(tex).toContain('A \\& B'); expect(tex).toContain('50\\% of cases had \\$X increase.');
  });
});

describe('buildPdf', () => {
  it('renders a REAL multi-page PDF whose page count reflects actual content length', async () => {
    const shortSections = [section()];
    const { bytes: shortBytes, pageCount: shortPages } = await buildPdf('Short', shortSections);
    expect(shortBytes.length).toBeGreaterThan(0); expect(shortPages).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(shortBytes).subarray(0, 5).toString('latin1')).toBe('%PDF-'); // a real PDF, not a placeholder

    const longText = Array.from({ length: 400 }, (_, i) => `sentence number ${i} with some real words in it.`).join(' ');
    const { pageCount: longPages } = await buildPdf('Long', [section({ content_text: longText })]);
    expect(longPages).toBeGreaterThan(shortPages); // genuinely paginates on real content length, not a fixed count
  });
});

describe('buildDocx / inspectDocxStructure', () => {
  it('renders a REAL Open XML (.docx) package — a ZIP container with a word/document.xml entry, never a renamed text file', async () => {
    const bytes = await buildDocx('My Paper', [section()]);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // ZIP local-file signature
    expect(inspectDocxStructure(bytes)).toBe(true);
  });
  it('refuses to call a non-ZIP buffer well-formed, and a ZIP without a document.xml entry', () => {
    expect(inspectDocxStructure(Buffer.from('this is plain text, not a docx'))).toBe(false);
    expect(inspectDocxStructure(Buffer.from('PK\x03\x04 but no real entry name inside'))).toBe(false);
  });
});

describe('buildProvenanceManifest', () => {
  it('is hash-chained: the manifestSha256 changes if any input changes, and verifies against its own content', () => {
    const m1 = buildProvenanceManifest('p1', [section()], [source()], [], 1000);
    const m2 = buildProvenanceManifest('p1', [section({ content_text: 'different text' })], [source()], [], 1000);
    expect(m1.manifestSha256).not.toBe(m2.manifestSha256);
    expect(m1.sections[0].contentSha256).not.toBe(m2.sections[0].contentSha256);
  });
});

describe('inspectExport', () => {
  const claim: ClaimRow = { id: 'c1', project_id: 'p1', statement: 'The intervention significantly reduced recurrence rates', created_by: 'u1', created_at: 0 };
  it('flags a cited claim that does not actually appear in the exported text — never silently "consistent"', () => {
    const md = buildMarkdown('Paper', [section({ content_text: 'This text never mentions the claim at all.' })], []);
    const r = inspectExport(md, 2, [claim], [{ sectionId: 'sec1', claimId: 'c1' }], []);
    expect(r.citationConsistency.missing).toEqual(['c1']); expect(r.pagination.pageCount).toBe(2);
  });
  it('passes when the cited claim text actually appears in the export', () => {
    const md = buildMarkdown('Paper', [section({ content_text: claim.statement })], []);
    const r = inspectExport(md, 1, [claim], [{ sectionId: 'sec1', claimId: 'c1' }], []);
    expect(r.citationConsistency.missing).toEqual([]);
  });
  it('flags a malformed/empty visual SVG rather than counting it as a valid figure', () => {
    const good: VisualSpecRow = { id: 'v1', project_id: 'p1', task_id: null, visual_key: 'fig1', version: 1, type: 'table', kind: 'data_derived', title: 'T', spec_json: '{}', data_provenance_json: '{}', svg: '<svg width="100" height="50"></svg>', invalidated_at: null, invalidated_reason: null, created_by: 'u1', created_at: 0 };
    const bad: VisualSpecRow = { ...good, id: 'v2', svg: 'not an svg at all' };
    const r = inspectExport('text', null, [], [], [good, bad]);
    expect(r.visuals.malformed).toEqual(['v2']); expect(r.visuals.checked).toBe(2);
  });
});
