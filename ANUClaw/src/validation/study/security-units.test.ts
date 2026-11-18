import { describe, expect, it } from 'vitest';
import { jsonDepth, LIMITS, page, sniffForbidden } from '../../dashboard/server/ocr-study-security';
import { forbiddenField, safeMeta } from '../../dashboard/server/ocr-study-access';

describe('study security units', () => {
  it('archive / compressed / executable content is recognised by magic bytes, whatever the declared type', () => {
    expect(sniffForbidden(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toBe('zip archive'); expect(sniffForbidden(Buffer.from([0x1f, 0x8b, 8]))).toBe('gzip'); expect(sniffForbidden(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe('executable');
    expect(sniffForbidden(Buffer.from('SYNTHETIC FIXTURE text'))).toBeNull(); expect(sniffForbidden(Buffer.from('%PDF-1.4'))).toBeNull();
    const tar = Buffer.alloc(300); tar.write('ustar', 257); expect(sniffForbidden(tar)).toBe('tar archive');
  });
  it('pagination is clamped and never negative; JSON depth is measured', () => {
    const q = (o: Record<string, string>) => page({ query: o } as never); expect(q({ limit: '100000' }).limit).toBe(LIMITS.maxPageSize); expect(q({ limit: '-5' }).limit).toBe(LIMITS.defaultPageSize); expect(q({ offset: '-1' }).offset).toBe(0); expect(q({}).limit).toBe(LIMITS.defaultPageSize);
    let d: unknown = 1; for (let i = 0; i < 30; i++) d = { a: d }; expect(jsonDepth(d)).toBeGreaterThan(LIMITS.maxJsonDepth); expect(jsonDepth({ a: { b: 1 } })).toBe(2);
  });
  it('audit metadata is an allow-list of tokens: names, free text, credentials and unknown keys are dropped', () => {
    expect(safeMeta({ datasetId: 'd-1', reasonSha256: 'a'.repeat(64), reasonLength: 12, reason: 'free text about Jane Roe', password: 'hunter2', reauthPassword: 'hunter2', credentialRef: 'CRED-1', email: 'a@b.c', status: 'removed', analyte: 'Sodium', policy: 'two words' }))
      .toEqual({ datasetId: 'd-1', reasonSha256: 'a'.repeat(64), reasonLength: 12, status: 'removed' });
    expect(forbiddenField({ options: { role: 'x' } })).toBe('options.role'); expect(forbiddenField({ name: 'ok' })).toBeNull();
  });
});
