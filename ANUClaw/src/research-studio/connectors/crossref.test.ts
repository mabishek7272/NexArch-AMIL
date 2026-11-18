/** Pure unit tests with an injected fake fetcher (recorded/synthetic fixtures) — NO real network call is ever made here. */
import { describe, expect, it } from 'vitest';
import { CrossrefConnector, CrossrefFetcher } from './crossref';
import { ScienceError } from '../../sciencedata/types';

function fakeFetcher(responses: Record<string, { status: number; body: unknown } | Error>): CrossrefFetcher {
  return {
    async request(url: string) {
      for (const [key, resp] of Object.entries(responses)) {
        if (url.includes(key)) {
          if (resp instanceof Error) throw resp;
          return { status: resp.status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(resp.body)), finalUrl: url, attempts: 1 };
        }
      }
      throw new ScienceError('not_found', 'no fixture for this URL', 404);
    },
  };
}

const WORK = (over: Record<string, unknown> = {}) => ({
  DOI: '10.1234/real', title: ['A Real Study'], author: [{ given: 'Jane', family: 'Doe' }],
  'published-print': { 'date-parts': [[2021]] }, 'container-title': ['Journal of Reality'], type: 'journal-article', ...over,
});

describe('CrossrefConnector.lookupByDoi', () => {
  it('parses a resolving DOI into a work, including correction/retraction and license signals', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works/10.1234%2Freal': { status: 200, body: { message: WORK() } } }) });
    const w = await c.lookupByDoi('10.1234/real');
    expect(w).toMatchObject({ doi: '10.1234/real', title: 'A Real Study', year: 2021, venue: 'Journal of Reality', correctionStatus: 'none', hasLicenseLink: false });
  });
  it('reports a retraction notice exactly as Crossref states it — never inferred any other way', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works/10.1234%2Fretracted': { status: 200, body: { message: WORK({ DOI: '10.1234/retracted', 'update-to': [{ type: 'retraction', DOI: '10.1234/notice' }] }) } } }) });
    const w = await c.lookupByDoi('10.1234/retracted');
    expect(w?.correctionStatus).toBe('retracted');
  });
  it('a fabricated/unresolvable DOI resolves to null, never to a fabricated work', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works/10.9999%2Fdoes-not-exist': new ScienceError('not_found', 'no such DOI', 404) }) });
    expect(await c.lookupByDoi('10.9999/does-not-exist')).toBeNull();
  });
  it('a connector/network failure propagates as an error rather than being silently treated as "not found"', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works/10.1234%2Freal': new ScienceError('unavailable', 'provider down', 502) }) });
    await expect(c.lookupByDoi('10.1234/real')).rejects.toThrow(/provider down/);
  });
});

describe('CrossrefConnector.searchBibliographic', () => {
  it('reports status "partial" (never silently truncated) when more results exist than were fetched', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works?': { status: 200, body: { message: { items: [WORK()], 'total-results': 50 } } } }) });
    const r = await c.searchBibliographic('some query', { rows: 1 });
    expect(r.works).toHaveLength(1); expect(r.totalResults).toBe(50); expect(r.status).toBe('partial');
  });
  it('reports "completed" when every result was fetched', async () => {
    const c = new CrossrefConnector({ fetcher: fakeFetcher({ '/works?': { status: 200, body: { message: { items: [WORK()], 'total-results': 1 } } } }) });
    expect((await c.searchBibliographic('q')).status).toBe('completed');
  });
  it('bounds rows to a sane maximum regardless of what is requested', async () => {
    let seenUrl = '';
    const c = new CrossrefConnector({ fetcher: { async request(url) { seenUrl = url; return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ message: { items: [] } })), finalUrl: url, attempts: 1 }; } } });
    await c.searchBibliographic('q', { rows: 10_000 });
    expect(seenUrl).toContain('rows=100');
  });
});
