import { describe, expect, it } from 'vitest';
import { redactSecrets, safeErrorSummary, safeSerialize } from './redact';

describe('redactSecrets', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop123', 'abcdefghijklmnop123'],
    ['key sk-or-v1-0123456789abcdef', 'sk-or-v1-0123456789abcdef'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX2hlcmU', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX2hlcmU'],
    ['postgres://user:hunter2pw@db:5432/x', 'hunter2pw'],
    ['hash scrypt$1$15$8$1$AAAA$BBBB', 'scrypt$1$15$8$1$AAAA$BBBB'],
    ['api amgi_live_ABCDEFGHIJKLMNOP', 'amgi_live_ABCDEFGHIJKLMNOP'],
  ])('masks %s', (input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
  });

  it('truncates very long values', () => {
    expect(redactSecrets('x'.repeat(5000)).length).toBeLessThan(2100);
  });
});

describe('safeSerialize', () => {
  it('drops sensitive keys and HTTP client internals', () => {
    const out = JSON.stringify(safeSerialize({ password: 'p', token: 't', ok: 1, config: { headers: { Authorization: 'Bearer zzzzzzzzzzzz' } } }));
    expect(out).not.toContain('"p"');
    expect(out).not.toContain('zzzzzzzzzzzz');
    expect(out).toContain('"ok":1');
  });

  it('summarises axios-style errors without request config or bodies', () => {
    const err: any = new Error('Request failed with status code 401');
    err.config = { headers: { Authorization: 'Bearer sk-or-v1-secretsecret' } };
    err.response = { status: 401, data: 'provider body with details' };
    const s = safeErrorSummary(err);
    expect(s).toContain('401');
    expect(s).not.toContain('secretsecret');
    expect(s).not.toContain('provider body');
  });
});
