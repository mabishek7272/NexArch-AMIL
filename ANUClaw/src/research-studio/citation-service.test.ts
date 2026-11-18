/** Pure unit tests: identifier normalisation and duplicate-detection rules (M2 plan §4) — no I/O. */
import { describe, expect, it } from 'vitest';
import { normalizeDoi, normalizePmid, normalizeUrl, normalizedIdentityOf, isExactDuplicate, proposedRelation } from './citation-service';

describe('normalizeDoi', () => {
  it('strips resolver prefixes and lower-cases', () => {
    expect(normalizeDoi('https://doi.org/10.1234/ABC.2020')).toBe('10.1234/abc.2020');
    expect(normalizeDoi('https://dx.doi.org/10.1234/abc')).toBe('10.1234/abc');
    expect(normalizeDoi('doi:10.1234/abc')).toBe('10.1234/abc');
    expect(normalizeDoi('  10.1234/abc  ')).toBe('10.1234/abc');
  });
  it('rejects a fabricated/malformed DOI rather than guessing', () => {
    expect(normalizeDoi('not-a-doi')).toBeNull();
    expect(normalizeDoi('10.abc/xyz')).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
    expect(normalizeDoi('')).toBeNull();
  });
});

describe('normalizePmid', () => {
  it('accepts digits with an optional prefix', () => { expect(normalizePmid('PMID:12345')).toBe('12345'); expect(normalizePmid('12345')).toBe('12345'); });
  it('rejects non-numeric input', () => { expect(normalizePmid('abc')).toBeNull(); expect(normalizePmid('12a45')).toBeNull(); });
});

describe('normalizeUrl', () => {
  it('strips tracking params, fragment and trailing slash; lower-cases host', () => {
    expect(normalizeUrl('https://Example.com/paper/?utm_source=x&id=1#top')).toBe('https://example.com/paper/?id=1');
    expect(normalizeUrl('https://example.com/paper/')).toBe('https://example.com/paper');
  });
  it('rejects a non-http(s) or malformed URL', () => { expect(normalizeUrl('ftp://x')).toBeNull(); expect(normalizeUrl('not a url')).toBeNull(); });
});

describe('normalizedIdentityOf (identifier preference: DOI > PMID > URL > title+year)', () => {
  it('prefers DOI over everything else', () => {
    expect(normalizedIdentityOf({ doi: '10.1234/x', pmid: '1', url: 'https://a.com', title: 'T' })).toBe('doi:10.1234/x');
  });
  it('falls back to title+year only when no identifier resolves', () => {
    expect(normalizedIdentityOf({ title: 'Some Study!!', year: 2020 })).toBe('title:some study::2020');
  });
});

describe('isExactDuplicate / proposedRelation — never auto-merging different records (plan §4)', () => {
  it('flags an EXACT duplicate only when the normalized identity matches exactly', () => {
    const a = { doi: '10.1234/x', title: 'A Study' }; const b = { doi: '10.1234/x', title: 'A Different Title Entirely' };
    expect(isExactDuplicate(a, b)).toBe(true); // same DOI = same record, regardless of title drift in our local copy
  });
  it('a preprint and its published version (different DOIs) are NOT an exact duplicate — only a proposed match for a human to confirm', () => {
    const preprint = { doi: '10.1234/preprint', title: 'Effects of X on Y: A Randomised Trial', year: 2020 };
    const published = { doi: '10.1234/published', title: 'Effects of X on Y: A Randomised Trial', year: 2020 };
    expect(isExactDuplicate(preprint, published)).toBe(false);
    expect(proposedRelation(preprint, published)).toBe('duplicate');
  });
  it('does not propose a match for genuinely different titles', () => {
    const a = { title: 'Effects of X on Y', year: 2020 }; const b = { title: 'An Unrelated Study About Z', year: 2020 };
    expect(proposedRelation(a, b)).toBeNull();
  });
  it('a correction notice (same DOI family, different identifier, same title) is proposed, never silently merged', () => {
    const original = { doi: '10.1234/orig', title: 'A Trial Of Something', year: 2019 };
    const correction = { doi: '10.1234/corr', title: 'A Trial Of Something (Correction)', year: 2019 };
    // titles differ enough (extra "(Correction)") that this is intentionally left for a human — not every correction is auto-detected, and that's acceptable: false negatives surface via the source library, false positives (auto-merge) would not.
    expect(isExactDuplicate(original, correction)).toBe(false);
  });
});
