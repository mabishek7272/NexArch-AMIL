/** Deterministic tests (NO live network): parsers, safe fetcher and provider normalisation against a SYNTHETIC mock. */
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFetcher } from './fetcher';
import { parseFasta, parseGff3, parseMmcif, parsePdb, parseSeriesMatrix, readZip, tokenizeCif } from './parsers';
import { describeAlphaFold, describeGeo, describeNcbiGenome, describeRcsb, geoMatrixUrl, normalizeAccession, parseSoftBrief, DEFAULT_BASES, resolveBases, rcsbSearchBody } from './providers';
import { FASTA_TEXT, GFF_TEXT, makeZip, makeZip64Directory, MATRIX_TEXT, PDB_TEXT, startMockProviders } from './testkit';
import { ScienceError } from './types';

const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ScienceError; } throw new Error('expected failure'); };

describe('structure parsers', () => {
  it('PDB: chains, residues, atoms, ranges, metadata; AlphaFold B-factor is pLDDT, experimental B-factor is NOT', () => {
    const s = parsePdb(PDB_TEXT, { bFactorIsPlddt: true });
    expect(s).toMatchObject({ format: 'pdb', models: 1, atoms: 5, residues: 4, experimentalMethod: 'X-RAY DIFFRACTION', resolutionAngstrom: 1.8, headerTitle: 'SYNTHETIC MINI PEPTIDE' });
    expect(s.chains).toEqual([{ id: 'A', residues: 4, atoms: 5, hetatmAtoms: 0 }]);
    expect(s.plddt).toMatchObject({ residuesScored: 4 }); expect(s.plddt!.fractionVeryHigh).toBe(0.25); expect(s.plddt!.fractionVeryLow).toBe(0.25);
    expect(parsePdb(PDB_TEXT).plddt).toBeNull();                                         // experimental: no confidence is invented
  });
  it('PDB: malformed input is refused, not guessed', () => {
    expect(() => parsePdb('HEADER x\nEND')).toThrow(/No ATOM/);
    expect(() => parsePdb('ATOM      1  N   ALA A   1       1.0')).toThrow(/too short/);
    expect(() => parsePdb(PDB_TEXT.replace('   1.400', '   abcdef'))).toThrow(/finite/);
  });
  it('mmCIF: tokenizer handles quotes, comments and text blocks; _atom_site loop parsed with metadata', () => {
    expect(tokenizeCif("_a 'x y'\n_b \"p q\"\n# c\n;multi\nline\n;\n")).toEqual(['_a', 'x y', '_b', 'p q', 'multi\nline']);
    const cif = ['data_X', '_struct.title \'SYNTHETIC CIF\'', '_exptl.method \'ELECTRON MICROSCOPY\'', '_em_3d_reconstruction.resolution 3.2', 'loop_', '_atom_site.group_PDB', '_atom_site.type_symbol', '_atom_site.label_atom_id', '_atom_site.label_comp_id', '_atom_site.label_asym_id', '_atom_site.label_seq_id', '_atom_site.Cartn_x', '_atom_site.Cartn_y', '_atom_site.Cartn_z', '_atom_site.B_iso_or_equiv', '_atom_site.pdbx_PDB_model_num',
      'ATOM C CA ALA A 1 1.0 2.0 3.0 91.0 1', 'ATOM C CA GLY A 2 4.0 5.0 6.0 40.0 1', 'HETATM O O HOH B . 7.0 8.0 9.0 20.0 1'].join('\n');
    const s = parseMmcif(cif, { bFactorIsPlddt: true });
    expect(s).toMatchObject({ format: 'mmcif', atoms: 3, headerTitle: 'SYNTHETIC CIF', experimentalMethod: 'ELECTRON MICROSCOPY', resolutionAngstrom: 3.2 });
    expect(s.chains.map((c) => c.id).sort()).toEqual(['A', 'B']); expect(s.plddt!.residuesScored).toBe(2);
    expect(() => parseMmcif('data_X\n_a 1')).toThrow(/_atom_site/);
    expect(() => parseMmcif(cif.replace('ATOM C CA GLY A 2 4.0 5.0 6.0 40.0 1', 'ATOM C CA GLY A 2 4.0 5.0 6.0 40.0'))).toThrow(/ragged/);
  });
});

describe('sequence, annotation and table parsers', () => {
  it('FASTA: counts, inferred kind (labelled inferred), ambiguity, GC; rejects non-residue text', () => {
    const s = parseFasta(FASTA_TEXT);
    expect(s).toMatchObject({ records: 2, totalResidues: 24, kind: 'nucleotide', kindIsInferred: true, ambiguousResidues: 2 });
    expect(s.gcFraction).toBeCloseTo(11 / 22, 6);          // GC over unambiguous bases only (N excluded) expect(s.entries[0]).toMatchObject({ id: 'NC_TEST.1', length: 20 });
    expect(() => parseFasta('ACGT\n>x\nAC')).toThrow(/before any FASTA header/); expect(() => parseFasta('>x\n')).toThrow(/no sequence/); expect(() => parseFasta('>x\nAC GT!')).toThrow(/not residues/); expect(() => parseFasta('')).toThrow(/No FASTA/);
    expect(parseFasta('>p\nMKTAYIAKQR\n').kind).toBe('protein');
  });
  it('GFF3: feature counts, bounds, malformed lines counted and bounded', () => {
    const s = parseGff3(GFF_TEXT); expect(s).toMatchObject({ version: '3', features: 2, byType: { gene: 1, CDS: 1 }, minStart: 1, maxEnd: 100, malformedLines: 0 });
    expect(parseGff3(GFF_TEXT + 'bad line\n').malformedLines).toBe(1);
    expect(() => parseGff3('##gff-version 3\nbad\nbad\n')).toThrow(/No valid GFF3/);
    expect(() => parseGff3('a\tb\tc\t10\t5\t.\t+\t.\tx')).toThrow();
  });
  it('series matrix (plain and gzip): dims, missing values, range; metadata-only or ragged files are refused', () => {
    for (const input of [MATRIX_TEXT, zlib.gzipSync(Buffer.from(MATRIX_TEXT))]) {
      expect(parseSeriesMatrix(input as any)).toMatchObject({ accession: 'GSE1', samples: 2, features: 2, valuesTotal: 4, valuesMissing: 1, valueRange: { min: 1.5, max: 3 }, platforms: ['GPL1'] });
    }
    expect(() => parseSeriesMatrix('!Series_title\t"x"')).toThrow(/No data table/);
    expect(() => parseSeriesMatrix(MATRIX_TEXT.replace('"g2"\t3\tnull', '"g2"\t3'))).toThrow(/different number of columns/);
    expect(() => parseSeriesMatrix(MATRIX_TEXT.replace('1.5', 'abc'))).toThrow(/not numeric/);
    expect(() => parseSeriesMatrix(Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toThrow(/gzip/);
  });
});

describe('zip reader safety', () => {
  const want = () => true;
  it('reads stored and deflated members and verifies size + CRC', () => {
    const z = makeZip([{ name: 'a.fna', data: Buffer.from('>x\nACGT\n') }, { name: 'b.txt', data: Buffer.from('hello'), method: 0 }]);
    expect(readZip(z, want).map((e) => [e.name, e.data.toString()])).toEqual([['a.fna', '>x\nACGT\n'], ['b.txt', 'hello']]);
    expect(readZip(z, (n) => n === 'b.txt')).toHaveLength(1);
  });
  it('Zip64 members (real NCBI Datasets archives use them) are read from the extra field; a truncated or missing Zip64 field is refused', () => {
    const z = makeZip([{ name: 'ncbi_dataset/data/x/g.fna', data: Buffer.from('>x\nACGT\n'), zip64: true }, { name: 'plain.txt', data: Buffer.from('hi') }]);
    expect(readZip(z, () => true).map((e) => [e.name, e.data.toString()])).toEqual([['ncbi_dataset/data/x/g.fna', '>x\nACGT\n'], ['plain.txt', 'hi']]);
    const broken = Buffer.from(z); const i = broken.indexOf(Buffer.from([0x01, 0x00, 0x18, 0x00])); broken.writeUInt16LE(0x7777, i);   // wipe the Zip64 extra id
    expect(() => readZip(broken, () => true)).toThrow(/no Zip64 extra field/);
  });
  it('refuses traversal, encrypted, bombs, size lies, corrupt directories and non-zips', () => {
    expect(() => readZip(makeZip([{ name: '../x', data: Buffer.from('a') }]), want)).toThrow(/unsafe member path/);
    expect(() => readZip(makeZip([{ name: 'a\\b', data: Buffer.from('a') }]), want)).toThrow(/unsafe/);
    const bomb = makeZip([{ name: 'x.fna', data: Buffer.alloc(8 * 1024 * 1024, 65) }]);
    expect(() => readZip(bomb, want)).toThrow(/compresses suspiciously well|too large/);
    expect(() => readZip(makeZip([{ name: 'x', data: Buffer.alloc(100, 1), lieSize: 5 }]), want)).toThrow(/size\/CRC|decompressed/);
    expect(() => readZip(makeZip([{ name: 'x', data: Buffer.from('a') }]), want, { maxEntries: 0, maxEntryBytes: 10, maxTotalBytes: 10 })).toThrow(/entries/);
    expect(() => readZip(Buffer.from('not a zip at all'), want)).toThrow(/Not a zip/);
    const z = makeZip([{ name: 'a', data: Buffer.from('abc') }]); z[z.length - 6] = 99;   // corrupt the central directory offset
    expect(() => readZip(z, want)).toThrow();
  });
});

describe('zip reader: further hardening (symlinks, duplicates, declared totals, Zip64 directories)', () => {
  const small = { maxEntries: 500, maxEntryBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 };
  it('refuses an archive containing a symbolic link — even one that is not selected', () => {
    const z = makeZip([{ name: 'ok.fna', data: Buffer.from('>x\nACGT\n') }, { name: 'link.txt', data: Buffer.from('/etc/passwd'), symlink: true }]);
    expect(() => readZip(z, (n) => n === 'ok.fna')).toThrow(/symbolic link/);
  });
  it('refuses duplicate member names (zip-confusion attacks)', () => {
    expect(() => readZip(makeZip([{ name: 'a.fna', data: Buffer.from('>a\nAC\n') }, { name: 'a.fna', data: Buffer.from('>b\nGT\n') }]), () => true)).toThrow(/two members named/);
  });
  it('the DECLARED uncompressed total of ALL entries is limited, not only the entries we read', () => {
    const z = makeZip([{ name: 'wanted.fna', data: Buffer.from('>x\nACGT\n') }, { name: 'huge.bin', data: Buffer.alloc(3 * 1024 * 1024, 7) }]);
    expect(() => readZip(z, (n) => n === 'wanted.fna', small)).toThrow(/declares more uncompressed data/);
  });
  it('the cumulative size of the entries READ is limited as well', () => {
    const z = makeZip([{ name: 'a.fna', data: Buffer.alloc(900_000, 65), method: 0 }, { name: 'b.fna', data: Buffer.alloc(900_000, 67), method: 0 }, { name: 'c.fna', data: Buffer.alloc(900_000, 71), method: 0 }]);
    expect(() => readZip(z, () => true, small)).toThrow(/declares more|expands beyond/);
  });
  it('entry-count limit applies to Zip64 directories too (a lying small count cannot hide a huge one)', () => {
    const files = [{ name: 'a.fna', data: Buffer.from('>a\nAC\n') }];
    expect(readZip(makeZip64Directory(files), () => true).map((e) => e.name)).toEqual(['a.fna']);                 // a real Zip64 directory is read
    expect(() => readZip(makeZip64Directory(files, 100_000), () => true)).toThrow(/entries \(limit 500\)/);          // declares 100,000 entries
    const noLocator = Buffer.from(makeZip64Directory(files)); noLocator.writeUInt32LE(0, noLocator.length - 22 - 20); expect(() => readZip(noLocator, () => true)).toThrow(/Zip64 locator/);
  });
  it('a member with data but a zero compressed size is refused', () => {
    expect(() => readZip(makeZip([{ name: 'x.fna', data: Buffer.alloc(0), method: 0, lieSize: 10 }]), () => true)).toThrow(/too large or compresses suspiciously well/);
  });
});

describe('provider normalisation and classification', () => {
  const b = DEFAULT_BASES;
  it('accession rules per provider', () => {
    expect(normalizeAccession('alphafold', ' p69905 ')).toBe('P69905'); expect(normalizeAccession('rcsb', '4hhb')).toBe('4HHB'); expect(normalizeAccession('ncbi_datasets', 'gcf_000819615.1')).toBe('GCF_000819615.1'); expect(normalizeAccession('geo', 'gse1')).toBe('GSE1');
    for (const [p, a] of [['alphafold', 'hemoglobin'], ['alphafold', 'P69905/../x'], ['rcsb', '4HHBX'], ['ncbi_datasets', 'NC_045512.2'], ['geo', 'GDS1'], ['geo', '']] as const) expect(() => normalizeAccession(p, a)).toThrow(/valid .* accession/);
  });
  it('AlphaFold is PREDICTED and says retrieval is not running AlphaFold; confidence metadata is preserved; file URLs come from the record', () => {
    const d = describeAlphaFold('P69905', [{ modelEntityId: 'AF-P69905-F1', sequenceStart: 1, sequenceEnd: 142, uniprotAccession: 'P69905', latestVersion: 4, globalMetricValue: 97.9, fractionPlddtVeryHigh: 0.9, pdbUrl: 'https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v4.pdb', uniprotStart: 1, uniprotEnd: 142 }], b);
    expect(d.classification).toBe('predicted'); expect(d.classificationNote).toMatch(/not an experimental/i); expect(d.sourceVersion).toBe('v4');
    expect((d.metadata.confidence as any).globalMetricValuePlddt).toBe(97.9); expect(d.metadata.sequenceLength).toBe(142);
    expect(d.files.map((f) => f.key)).toEqual(['pdb']); expect(d.warnings.join(' ')).toMatch(/experimental validation/);
    expect(describeAlphaFold('P69905', [], b).files).toEqual([]); expect(() => describeAlphaFold('P69905', [{ entryId: 'x' }], b)).toThrow(/current model identifier/);
  });
  it('RCSB: experimental vs COMPUTED model are distinguished from the record itself', () => {
    const rec = (method: string, methodology: string) => ({ rcsb_id: '4HHB', exptl: [{ method }], rcsb_entry_info: { structure_determination_methodology: methodology }, rcsb_accession_info: { revision_date: '2024-01-01' }, struct: { title: 't' } });
    expect(describeRcsb('4HHB', rec('X-RAY DIFFRACTION', 'experimental'), b)).toMatchObject({ classification: 'experimental' });
    const c = describeRcsb('4HHB', rec('THEORETICAL MODEL', 'computational'), b); expect(c.classification).toBe('predicted'); expect(c.classificationNote).toMatch(/COMPUTED model/); expect(c.files.every((f) => f.classification === 'predicted')).toBe(true);
    expect(describeRcsb('4HHB', rec('X-RAY', 'computational'), b).classification).toBe('predicted');     // the record's own methodology field wins
    expect(() => describeRcsb('4HHB', { rcsb_id: '1ABC' }, b)).toThrow(/different entry/); expect(() => describeRcsb('4HHB', {}, b)).toThrow(/rcsb_id/);
    expect(rcsbSearchBody('hemoglobin').request_options.paginate.rows).toBe(10);
  });
  it('NCBI: RefSeq = curated_reference, GenBank = author_supplied; oversized or unsized genomes are REFUSED, not downloaded', () => {
    const rep = (acc: string, len: unknown) => ({ reports: [{ accession: acc, organism: { organism_name: 'X' }, assembly_info: { assembly_name: 'a' }, assembly_stats: { total_sequence_length: len } }] });
    expect(describeNcbiGenome('GCF_000000001.1', rep('GCF_000000001.1', '5386'), b, 12e6)).toMatchObject({ classification: 'curated_reference' });
    expect(describeNcbiGenome('GCA_000000001.1', rep('GCA_000000001.1', '5386'), b, 12e6).classification).toBe('author_supplied');
    expect(describeNcbiGenome('GCF_000000001.1', rep('GCF_000000001.1', '3000000000'), b, 12e6).refused![0].reason).toMatch(/above the 12 Mbp cap/);
    expect(describeNcbiGenome('GCF_000000001.1', rep('GCF_000000001.1', undefined), b, 12e6).refused![0].reason).toMatch(/cannot be bounded/);
    expect(() => describeNcbiGenome('GCF_000000001.1', { reports: [] }, b, 12e6)).toThrow(/no report/); expect(() => describeNcbiGenome('GCF_000000001.1', rep('GCF_000000009.1', '1'), b, 12e6)).toThrow(/different assembly/);
  });
  it('GEO: author_supplied; contact fields are dropped; supplementary files are listed, never fetched; size cap refuses', () => {
    const soft = '^SERIES = GSE1\n!Series_title = T\n!Series_contact_email = a@b.c\n!Series_supplementary_file = ftp://x/RAW.tar\n!Series_last_update_date = Jan 01 2020';
    expect(JSON.stringify(parseSoftBrief(soft))).not.toMatch(/a@b\.c/);
    const d = describeGeo('GSE1', soft, b, 20e6, 1000); expect(d.classification).toBe('author_supplied'); expect(d.files.map((f) => f.key)).toEqual(['series_matrix']); expect(d.warnings.join(' ')).toMatch(/not fetched/);
    expect(describeGeo('GSE1', soft, b, 20e6, 50e6).refused![0].reason).toMatch(/above the 20 MB cap/);
    expect(() => describeGeo('GSE2', soft, b, 20e6, null)).toThrow(/different or empty/);
    expect(geoMatrixUrl(b, 'GSE12345')).toContain('/GSE12nnn/GSE12345/matrix/GSE12345_series_matrix.txt.gz'); expect(geoMatrixUrl(b, 'GSE1')).toContain('/GSEnnn/GSE1/');
  });
  it('base-URL overrides: loopback only, never in production', () => {
    expect(resolveBases({ ANUCLAW_SCIDATA_BASE_OVERRIDES: '{"alphafold":"http://127.0.0.1:9"}' } as any).alphafold).toBe('http://127.0.0.1:9');
    expect(() => resolveBases({ ANUCLAW_SCIDATA_BASE_OVERRIDES: '{"alphafold":"https://evil.example.org"}' } as any)).toThrow(/loopback/);
    expect(() => resolveBases({ NODE_ENV: 'production', ANUCLAW_SCIDATA_BASE_OVERRIDES: '{"alphafold":"http://127.0.0.1:9"}' } as any)).toThrow(/production/);
    expect(() => resolveBases({ ANUCLAW_SCIDATA_BASE_OVERRIDES: '{"nope":"http://127.0.0.1:9"}' } as any)).toThrow(/unknown override/);
  });
});

describe('SafeFetcher against a synthetic server: outages, rate limits, size, redirects, content type', () => {
  let m: Awaited<ReturnType<typeof startMockProviders>>; let f: SafeFetcher;
  const fetcher = (over: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {}) => new SafeFetcher({ allowedOrigins: [m.origin], allowInsecureLoopback: true, sleep: async () => undefined, ...over });
  beforeAll(async () => { m = await startMockProviders(); f = fetcher(); });
  afterAll(async () => { await m.close(); });

  it('origins: non-allow-listed, credentialed, plain-http-non-loopback and non-http(s) URLs are refused before any request', async () => {
    for (const u of ['https://evil.example.org/x', 'http://example.com/x', 'ftp://alphafold.ebi.ac.uk/x', `http://user:pw@127.0.0.1:${new URL(m.origin).port}/x`, 'file:///etc/passwd']) expect((await fail(f.request(u))).code).toBe('blocked_origin');
    expect((await fail(new SafeFetcher({ allowedOrigins: [m.origin] }).request(`${m.origin}/x`))).code).toBe('blocked_origin');       // loopback http not enabled
  });
  it('a redirect to another origin is refused (no request is made to it)', async () => {
    m.setMode('afJson', 'redirect_evil'); try { expect((await fail(f.request(`${m.origin}/api/prediction/P69905`))).code).toBe('redirect_refused'); } finally { m.setMode('afJson', ''); }
  });
  it('outage: 5xx is retried a bounded number of times, then reported as unavailable', async () => {
    m.hits.length = 0; m.setMode('afJson', 'outage');
    try { const e = await fail(f.request(`${m.origin}/api/prediction/P69905`, { retries: 2 })); expect(e.code).toBe('unavailable'); expect(m.hits.filter((h) => h.includes('/api/prediction/P69905'))).toHaveLength(3); } finally { m.setMode('afJson', ''); }
  });
  it('rate limit: 429 honours Retry-After then succeeds; persistent 429 → rate_limited after bounded retries', async () => {
    m.hits.length = 0; m.setMode('afJson', 'ratelimit_once'); const waits: number[] = [];
    const ok = await fetcher({ sleep: async (ms) => { waits.push(ms); } }).request(`${m.origin}/api/prediction/P69905`, { retries: 2 });
    expect(ok.status).toBe(200); expect(ok.attempts).toBe(2); expect(waits.length).toBeGreaterThanOrEqual(1);
    m.setMode('afJson', 'ratelimit'); m.hits.length = 0;
    const e = await fail(f.request(`${m.origin}/api/prediction/P69905`, { retries: 1 })); expect(e.code).toBe('rate_limited'); expect(e.status).toBe(429); expect(m.hits.length).toBe(2); m.setMode('afJson', '');
  });
  it('oversized: refused from the declared length / while streaming, never buffered whole', async () => {
    m.setMode('afFile', 'huge'); try { const e = await fail(f.request(`${m.origin}/files/AF-P69905-F1-model_v4.pdb`, { maxBytes: 1024 * 1024 })); expect(e.code).toBe('too_large'); expect(e.status).toBe(413); } finally { m.setMode('afFile', ''); }
    const e2 = await fail(f.request(`${m.origin}/files/AF-P69905-F1-model_v4.pdb`, { maxBytes: 50 })); expect(e2.code).toBe('too_large');
  });
  it('401/403 are reported as access_denied (NOT inferred to be controlled access, NOT an outage), without retry storms', async () => {
    m.setMode('afJson', 'forbidden'); m.hits.length = 0; try { const e = await fail(f.request(`${m.origin}/api/prediction/P69905`, { retries: 2 })); expect(e.code).toBe('access_denied'); expect(e.status).toBe(403); expect(m.hits).toHaveLength(1); expect(e.message).toMatch(/NOT assumed to be controlled-access/); expect(JSON.stringify(e)).not.toMatch(/restricted/i); expect(e.details).toEqual({ httpStatus: 403 }); } finally { m.setMode('afJson', ''); }
  });
  it('sends Accept: */* by default (a server that stalls on axios\' default Accept header is served), and a caller-specified Accept is honoured', async () => {
    const r = await f.request(`${m.origin}/needs-star-accept`, { timeoutMs: 1500, retries: 0 }); expect(r.body.toString()).toBe('ok');
    await f.request(`${m.origin}/api/prediction/P69905`, { accept: 'application/json' }); expect(m.acceptHeaders.at(-1)).toBe('application/json');
  });
  it('not found, bad content type, timeouts and connection failures have explicit codes', async () => {
    expect((await fail(f.request(`${m.origin}/nothing-here`))).code).toBe('not_found');
    m.setMode('afJson', 'html'); try { expect((await fail(f.request(`${m.origin}/api/prediction/P69905`, { expectTypes: /json/i }))).code).toBe('bad_content_type'); } finally { m.setMode('afJson', ''); }
    const slow = http.createServer(() => { /* never answers */ }); await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r())); const origin = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try { expect((await fail(fetcher({ allowedOrigins: [origin] }).request(`${origin}/x`, { timeoutMs: 150, retries: 0 }))).code).toBe('timeout'); } finally { slow.closeAllConnections?.(); slow.close(); }
    expect((await fail(fetcher({ allowedOrigins: ['http://127.0.0.1:1'] }).request('http://127.0.0.1:1/x', { retries: 0 }))).code).toBe('unavailable');
  });
  it('per-request origin restriction: a redirect from one provider to ANOTHER allow-listed provider is refused', async () => {
    const other = http.createServer((_q, r) => { r.writeHead(200); r.end('other provider'); }); await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const o2 = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const both = fetcher({ allowedOrigins: [m.origin, o2] });
      expect((await both.request(`${m.origin}/redirect-to?to=${encodeURIComponent(`${o2}/x`)}`)).body.toString()).toBe('other provider');          // allowed globally (the fetcher knows both)
      const e = await fail(both.request(`${m.origin}/redirect-to?to=${encodeURIComponent(`${o2}/x`)}`, { origins: [m.origin] })); expect(e.code).toBe('redirect_refused');   // …but not for a request confined to the first provider
      expect((await fail(both.request(`${o2}/x`, { origins: [m.origin] }))).code).toBe('blocked_origin');
    } finally { other.closeAllConnections?.(); other.close(); }
  });
  it('per-host pacing enforces a minimum interval between requests', async () => {
    const waits: number[] = []; const g = fetcher({ minIntervalMs: () => 200, sleep: async (ms) => { waits.push(ms); } });
    await g.request(`${m.origin}/api/prediction/P69905`); await g.request(`${m.origin}/api/prediction/P69905`);
    expect(waits.some((w) => w > 0 && w <= 200)).toBe(true);
  });
});
