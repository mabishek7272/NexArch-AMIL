/** Deterministic contract/transport fixtures. These are NOT live provider verification. */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AlphaFoldConnector,
  AF_ORIGIN,
  normalizeAlphaFold,
  normalizeConfidenceArtifact,
  officialFile,
  validateQualifier,
  validateSequence,
} from './alphafold';
import { SafeFetcher, LiveBudget } from './fetcher';
import { validateStructureBytes } from './alphafold-service';
import prediction from './fixtures/alphafold/prediction.json';
import fragments from './fixtures/alphafold/fragments.json';
import complex from './fixtures/alphafold/complex.json';
import summary from './fixtures/alphafold/summary.json';
import sequence from './fixtures/alphafold/sequence.json';
import annotations from './fixtures/alphafold/annotations.json';
import { PDB_TEXT } from './testkit';
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('Expected failure');
};

describe('AlphaFold normalized v1 contract fixtures', () => {
  it.each(['P69905', 'A0A000', 'AF-P69905-F1', 'AF-0000000203852801', 'AF-P69905-F1-model_v6'])(
    'valid qualifier %s',
    (s) => expect(validateQualifier(s)).toBe(s),
  );
  it.each([
    'https://evil.test/P69905',
    '../P69905',
    'P69905/1-50',
    'P69905:1-50',
    'P69905%2f..',
    'AF-1',
    'P69905?x=1',
    '',
    null,
  ])('refuses qualifier %s', (s) => expect(() => validateQualifier(s)).toThrow());
  it('validates sequence alphabet, minimum, maximum, headers and metadata', () => {
    expect(validateSequence(' acdefghiklmnpqrstvwy\nA ')).toBe('ACDEFGHIKLMNPQRSTVWYA');
    for (const s of [
      'A'.repeat(19),
      'A'.repeat(2701),
      'ACDEFGHIKLMNPQRSTVWYX',
      '>patient\n' + 'A'.repeat(30),
      'A'.repeat(10001),
      'A'.repeat(20) + '!',
    ])
      expect(() => validateSequence(s)).toThrow();
  });
  it('works with ALL sunset fields absent; tolerates new unknown fields without fabrication', () => {
    const raw = prediction.map((x) => ({ ...x, unexpected: { system: 'untrusted' } }));
    const r = normalizeAlphaFold('prediction', raw);
    expect(r.schema).toBe('anuclaw-alphafold/v1');
    expect(r.models[0]).toMatchObject({
      modelId: 'AF-P69905-F1',
      range: { start: 1, end: 142 },
      sequenceLength: 142,
      predicted: true,
      provenance: { version: 6 },
    });
    expect(r.models[0].confidence.meanPlddt).toBe(98.06);
    expect(r.models[0].files.map((f) => f.key)).toEqual(['mmcif', 'bcif', 'pdb', 'pae', 'plddt']);
    expect(JSON.stringify(r)).not.toContain('unexpected');
    const minimal = normalizeAlphaFold('prediction', [{ modelEntityId: 'AF-P69905-F1' }]).models[0];
    expect(minimal.provenance.version).toBeNull();
    expect(minimal.genes).toEqual([]);
    expect(minimal.entities).toEqual([]);
    expect(minimal.confidence.meanPlddt).toBeNull();
  });
  it('retains fragments without merging, computes overlaps and flags unknown terminal coverage', () => {
    const r = normalizeAlphaFold('prediction', fragments);
    expect(r.models).toHaveLength(2);
    expect(r.coverage.overlaps[0]).toMatchObject({ start: 80, end: 100 });
    expect(r.coverage.completeLengthKnown).toBe(false);
  });
  it('normalizes complex composition and preserves actual producer/interface metrics; does not fabricate files or chains', () => {
    const m = normalizeAlphaFold('complex', complex).models[0];
    expect(m.provenance.provider).toBe('NVIDIA');
    expect(m.entities[0].stoichiometry).toBe(1);
    expect(m.entities[0].chains).toEqual([]);
    expect(m.confidence.interfaceMetrics.complexPredictionAccuracy_ipTM).toBe(0.89);
    expect(m.files).toEqual([]);
  });
  it('normalizes summary entities, residue ranges and sequence summary', () => {
    const r = normalizeAlphaFold('uniprot', summary);
    expect(r.uniprot).toMatchObject({
      accession: 'P69905',
      sequenceLength: 142,
      range: { start: 1, end: 142 },
    });
    expect(r.models[0].entities[0].chains).toEqual(['A']);
    expect(r.models[0].files[0].format).toBe('mmcif');
    expect(normalizeAlphaFold('sequence', sequence).sequenceSummary?.length).toBe(142);
  });
  it('keeps annotation evidence classes distinct and does not treat unknown wording as verified', () => {
    const a = normalizeAlphaFold('annotations', annotations).annotations[0];
    expect(a.evidenceClass).toBe('computational');
    expect(a.regions[0].value).toBe('0.6243');
    const r = normalizeAlphaFold('annotations', {
      annotation: [
        'EXPERIMENTAL',
        'TRANSFERRED',
        'NOT EXPERIMENTAL',
        'COMPUTATIONAL/PREDICTED',
      ].map((evidence) => ({ evidence })),
    });
    expect(r.annotations.map((a) => a.evidenceClass)).toEqual([
      'experimental',
      'transferred',
      'unknown',
      'computational',
    ]);
  });
  it('empty models are honest; missing current identifiers, invalid JSON shapes and schema changes fail closed', () => {
    expect(normalizeAlphaFold('prediction', []).models).toEqual([]);
    for (const raw of [
      null,
      {},
      [{ entryId: 'AF-P69905-F1' }],
      [{ renamedModelId: 'AF-P69905-F1' }],
    ])
      expect(() => normalizeAlphaFold('prediction', raw)).toThrow();
    expect(() => normalizeAlphaFold('sequence', {})).toThrow();
    expect(() => normalizeAlphaFold('annotations', {})).toThrow();
  });
  it('refuses traversal, executable suffixes, encoded paths, credentials, arbitrary URLs, mismatched extensions', () => {
    for (const url of [
      'https://evil.test/files/x.pdb',
      `${AF_ORIGIN}/files/../files/x.pdb`,
      `${AF_ORIGIN}/files/%2e%2e/x.pdb`,
      `${AF_ORIGIN}/files/x.exe`,
      `${AF_ORIGIN}/files/x.cif`,
      `${AF_ORIGIN}/files/x.pdb?x=1`,
      'http://alphafold.ebi.ac.uk/files/x.pdb',
    ])
      expect(officialFile(url, 'pdb')).toBeNull();
  });
  it('normalizes confidence artifacts without fabricating residue numbers or maximum PAE',()=>{
    const p=normalizeConfidenceArtifact('plddt',{confidenceScore:[95,40]});expect(p.schema).toBe('anuclaw-alphafold/v1');expect(p.residueScores[0]).toEqual({index:1,residue:null,plddt:95});
    const a=normalizeConfidenceArtifact('pae',[{predicted_aligned_error:[[0,2],[2,0]]}]);expect(a.maxPae).toBeNull();expect(a.matrix?.[0][1]).toBe(2);
    expect(()=>normalizeConfidenceArtifact('plddt',{confidenceScore:[95],residueNumber:[1,2]})).toThrow();
  });
  it('validates content and selected format, not just a provider filename', () => {
    expect(() =>
      validateStructureBytes('pdb', Buffer.from(PDB_TEXT), 'chemical/x-pdb'),
    ).not.toThrow();
    expect(() =>
      validateStructureBytes('pdb', Buffer.from('<script>alert(1)</script>'), 'text/html'),
    ).toThrow();
    expect(() => validateStructureBytes('mmcif', Buffer.from(PDB_TEXT), 'text/plain')).toThrow();
    expect(() =>
      validateStructureBytes('bcif', Buffer.from('MZ executable'), 'application/octet-stream'),
    ).toThrow();
    expect(() =>
      validateStructureBytes(
        'pae',
        Buffer.from(
          '[{"predicted_aligned_error":[[0,2],[2,0]],"max_predicted_aligned_error":31.75}]',
        ),
        'application/json',
      ),
    ).not.toThrow();
    expect(() =>
      validateStructureBytes(
        'pae',
        Buffer.from('{"predicted_aligned_error":[[0,-1]]}'),
        'application/json',
      ),
    ).toThrow();
  });
});

describe('AlphaFold real HTTP transport against deterministic local fixtures', () => {
  let server: http.Server, origin: string;
  let mode = 'ok',
    hits = 0,
    conditional = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      conditional = String(req.headers['if-none-match'] ?? req.headers['if-modified-since'] ?? '');
      if (mode === 'timeout') {
        return;
      }
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'https://evil.test/steal' });
        return res.end();
      }
      if (mode === 'oversized') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '3000000' });
        return res.end('{}');
      }
      if (mode === 'stream') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        return;
      }
      if (['404', '408', '429', '503'].includes(mode)) {
        res.writeHead(Number(mode), {
          'Content-Type': 'application/json',
          ...(mode === '429' ? { 'Retry-After': '0' } : {}),
        });
        return res.end('{}');
      }
      if (mode === '304') {
        res.writeHead(304);
        return res.end();
      }
      if (mode === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>oops</html>');
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v6"' });
      res.end(mode === 'badjson' ? '{bad' : JSON.stringify(prediction));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const fetcher = () =>
    new SafeFetcher({
      allowedOrigins: [origin],
      allowInsecureLoopback: true,
      sleep: async () => {},
    });
  it('TTL hit is not live verification; manual refresh supports ETag 304 without changing retrieval time/hash', async () => {
    mode = 'ok';
    hits = 0;
    const c = new AlphaFoldConnector(fetcher(), origin);
    const a = await c.lookup('prediction', 'P69905');
    expect((await c.lookup('prediction', 'p69905')).cache).toBe('hit');
    expect(hits).toBe(1);
    mode = '304';
    const b = await c.lookup('prediction', 'P69905', true);
    expect(b.cache).toBe('revalidated');
    expect(conditional).toBe('"v6"');
    expect(b.responseHash).toBe(a.responseHash);
    expect(b.retrievedAt).toBe(a.retrievedAt);
    expect(hits).toBe(2);
  });
  it.each([
    ['404', 'not_found', 1],
    ['408', 'timeout', 3],
    ['429', 'rate_limited', 3],
    ['503', 'unavailable', 3],
    ['redirect', 'redirect_refused', 1],
    ['oversized', 'too_large', 1],
    ['html', 'bad_content_type', 1],
    ['badjson', 'malformed_response', 1],
  ])('handles %s safely', async (m, code, count) => {
    mode = m;
    hits = 0;
    const e = await fail(new AlphaFoldConnector(fetcher(), origin).lookup('prediction', 'P69905'));
    expect(e).toMatchObject({ code });
    expect(hits).toBe(count);
  });
  it('bounded timeout and cancellation during a response stream', async () => {
    mode = 'timeout';
    expect(
      await fail(fetcher().request(`${origin}/x`, { timeoutMs: 30, retries: 0 })),
    ).toMatchObject({ code: 'timeout' });
    mode = 'stream';
    const c = new AbortController();
    const p = fetcher().request(`${origin}/x`, { signal: c.signal, timeoutMs: 2000, retries: 2 });
    setTimeout(() => c.abort(), 30);
    expect(await fail(p)).toMatchObject({ code: 'cancelled' });
  });
  it('enforces coordinate size while streaming, before storage', async () => {
    mode = 'oversized';
    expect(
      await fail(fetcher().request(`${origin}/files/x.pdb`, { maxBytes: 100, retries: 0 })),
    ).toMatchObject({ code: 'too_large' });
  });
});

describe.skipIf(process.env.ANUCLAW_ALPHAFOLD_LIVE !== '1')(
  'OPT-IN live AlphaFold DB: bounded public P69905, metadata only',
  () => {
    it('validates five real official endpoints without coordinate downloads', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-live-'));
      try {
        const ledger = path.join(dir, 'ledger.json');
        const fetcher = new SafeFetcher({
          allowedOrigins: [AF_ORIGIN],
          budget: new LiveBudget(ledger, { maxFiles: 10, maxBytes: 500000 }),
          defaultTimeoutMs: 12000,
        });
        const c = new AlphaFoldConnector(fetcher);
        const evidence: any[] = [];
        for (const [op, value] of [
          ['prediction', 'P69905'],
          ['uniprot', 'P69905'],
          ['complex', 'AF-0000000203852801'],
          ['annotations', 'P69905'],
          ['sequence', prediction[0].sequence],
        ] as const) {
          const r = await c.lookup(op, value);
          expect(r.raw.status).toBe(200);
          evidence.push({
            operation: op,
            endpoint: r.raw.finalUrl,
            status: r.raw.status,
            bytes: r.raw.body.length,
            sha256: r.responseHash,
            models: r.normalized.models.length,
            annotations: r.normalized.annotations.length,
            cache: r.cache,
            retrievedAt: new Date(r.retrievedAt).toISOString(),
          });
        }
        fs.mkdirSync('docs/evidence', { recursive: true });
        fs.writeFileSync(
          'docs/evidence/alphafold-live.json',
          JSON.stringify(
            {
              acquisition: 'live',
              coordinateDownloads: 0,
              evidence,
              ledger: JSON.parse(fs.readFileSync(ledger, 'utf8')),
            },
            null,
            2,
          ) + '\n',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 60000);
  },
);
