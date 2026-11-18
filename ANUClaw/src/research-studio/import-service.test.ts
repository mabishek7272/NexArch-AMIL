/** Pure/no-DB tests: RIS/BibTeX parsing (plan §3A — "preserve original records and report parse failures") and local artifact storage safety. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRis, parseBibtex, detectAndParseBibliography, storeArtifact, artifactRoot } from './import-service';

const RIS_GOOD = `TY  - JOUR
AU  - Smith, John
AU  - Doe, Jane
TI  - Effects of X on Y
PY  - 2020
DO  - 10.1234/abc
UR  - https://example.com/paper
JO  - Journal of Examples
ER  -
`;

const RIS_MALFORMED = `TY  - JOUR
AU  - No Title Here
PY  - 2020
ER  -
`;

const BIBTEX_GOOD = `@article{smith2020,
  title = {Effects of X on Y},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  doi = {10.1234/abc},
  journal = {Journal of Examples}
}`;

const BIBTEX_MALFORMED_NO_TITLE = `@article{nokey, author = {Someone}, year = {2021}}`;
const BIBTEX_UNBALANCED = `@article{broken, title = {Unterminated`;

describe('parseRis', () => {
  it('parses a well-formed record', () => {
    const r = parseRis(RIS_GOOD);
    expect(r.failures).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ title: 'Effects of X on Y', year: 2020, doi: '10.1234/abc', venue: 'Journal of Examples' });
    expect(r.records[0].authors).toEqual(['Smith, John', 'Doe, Jane']);
    expect(r.records[0].raw).toContain('TI  - Effects of X on Y');
  });
  it('reports a record with no title as a named failure, never silently dropped', () => {
    const r = parseRis(RIS_MALFORMED);
    expect(r.records).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/no TI\/T1/);
    expect(r.failures[0].raw).toContain('No Title Here'); // original record text preserved
  });
});

describe('parseBibtex', () => {
  it('parses a well-formed entry', () => {
    const r = parseBibtex(BIBTEX_GOOD);
    expect(r.failures).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ title: 'Effects of X on Y', year: 2020, doi: '10.1234/abc', venue: 'Journal of Examples' });
    expect(r.records[0].authors).toEqual(['Smith, John', 'Doe, Jane']);
  });
  it('reports a missing title as a named failure', () => {
    const r = parseBibtex(BIBTEX_MALFORMED_NO_TITLE);
    expect(r.records).toEqual([]); expect(r.failures[0].reason).toMatch(/no title field/);
  });
  it('reports unbalanced braces (malformed import) as a named failure rather than guessing where the entry ends', () => {
    const r = parseBibtex(BIBTEX_UNBALANCED);
    expect(r.records).toEqual([]); expect(r.failures[0].reason).toMatch(/unbalanced braces/);
  });
});

describe('detectAndParseBibliography', () => {
  it('auto-detects RIS vs BibTeX by content shape', () => {
    expect(detectAndParseBibliography(RIS_GOOD).format).toBe('ris');
    expect(detectAndParseBibliography(BIBTEX_GOOD).format).toBe('bibtex');
  });
  it('refuses an unrecognised format rather than guessing', () => {
    expect(() => detectAndParseBibliography('just some random text, not a bibliography')).toThrow(/Unrecognised bibliography format/);
  });
});

describe('storeArtifact (local artifact storage safety)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-artifact-test-')); process.env.ANUCLAW_RESEARCH_STUDIO_ROOT = root; });
  afterEach(() => { delete process.env.ANUCLAW_RESEARCH_STUDIO_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

  const PROJECT = '11111111-1111-1111-1111-111111111111'; const SOURCE = '22222222-2222-2222-2222-222222222222';

  it('stores a text artifact under a project/source-scoped, mode-0700 directory and extracts its text', async () => {
    const out = await storeArtifact(PROJECT, SOURCE, 'note.txt', Buffer.from('hello evidence'));
    expect(out.kind).toBe('text'); expect(out.extractedText).toBe('hello evidence');
    expect(fs.existsSync(out.storagePath)).toBe(true);
    const dir = path.dirname(out.storagePath); const stat = fs.statSync(dir);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(artifactRoot()).toBe(root);
  });
  it('refuses a non-UUID project/source id (never trusts a caller-supplied path segment)', async () => {
    await expect(storeArtifact('not-a-uuid', SOURCE, 'x.txt', Buffer.from('x'))).rejects.toThrow(/server-generated UUIDs/);
  });
  it('refuses an artifact over the size limit', async () => {
    await expect(storeArtifact(PROJECT, SOURCE, 'big.txt', Buffer.alloc(30 * 1024 * 1024))).rejects.toThrow(/exceeds the .* limit/);
  });
  it('a malformed/non-PDF file whose bytes look like a PDF header still goes through extractPdfText, which reports the failure explicitly rather than crashing', async () => {
    const fakePdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.from('not actually a valid pdf body')]);
    const out = await storeArtifact(PROJECT, SOURCE, 'fake.pdf', fakePdf);
    expect(out.kind).toBe('pdf'); expect(out.extractionError).toBeDefined(); expect(out.extractedText).toBeUndefined();
  });
});
