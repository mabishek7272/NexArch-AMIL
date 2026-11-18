/** Test helpers: a tiny zip writer and a SYNTHETIC mock of the four providers (clearly not the real services). */
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';
import { crc32 } from './parsers';

/** end-of-central-directory with a Zip64 locator (entry count 0xFFFF in the classic record), as written for archives with very many entries */
export function makeZip64Directory(files: Array<{ name: string; data: Buffer }>, lieCount?: number): Buffer {
  const base = makeZip(files.map((f) => ({ ...f }))); const eocd = base.length - 22; const cdSize = base.readUInt32LE(eocd + 12), cdOff = base.readUInt32LE(eocd + 16);
  const z64 = Buffer.alloc(56); z64.writeUInt32LE(0x06064b50, 0); z64.writeBigUInt64LE(44n, 4); z64.writeUInt16LE(45, 12); z64.writeUInt16LE(45, 14); z64.writeBigUInt64LE(BigInt(lieCount ?? files.length), 24); z64.writeBigUInt64LE(BigInt(lieCount ?? files.length), 32); z64.writeBigUInt64LE(BigInt(cdSize), 40); z64.writeBigUInt64LE(BigInt(cdOff), 48);
  const loc = Buffer.alloc(20); loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(base.length - 22), 8); loc.writeUInt32LE(1, 16);
  const e = Buffer.from(base.subarray(eocd)); e.writeUInt16LE(0xffff, 10); e.writeUInt16LE(0xffff, 8); e.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([base.subarray(0, eocd), z64, loc, e]);
}

export function makeZip(files: Array<{ name: string; data: Buffer; method?: 0 | 8; lieSize?: number; zip64?: boolean; symlink?: boolean }>): Buffer {
  const parts: Buffer[] = []; const cd: Buffer[] = []; let off = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name); const comp = f.method === 0 ? f.data : zlib.deflateRawSync(f.data); const m = f.method ?? 8;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(m, 8); lh.writeUInt32LE(crc32(f.data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.lieSize ?? f.data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    parts.push(lh, nameB, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(f.symlink ? ((3 << 8) | 45) : 45, 4); ch.writeUInt16LE(45, 6); if (f.symlink) ch.writeUInt32LE(((0o120777 << 16) >>> 0), 38); ch.writeUInt16LE(m, 10); ch.writeUInt32LE(crc32(f.data), 16); ch.writeUInt16LE(nameB.length, 28);
    let extra = Buffer.alloc(0);
    if (f.zip64) {   // like NCBI's archives: 0xFFFFFFFF in the directory, real values in the Zip64 extra field (usize, csize, local header offset)
      ch.writeUInt32LE(0xffffffff, 20); ch.writeUInt32LE(0xffffffff, 24); ch.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(28); extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(f.lieSize ?? f.data.length), 4); extra.writeBigUInt64LE(BigInt(comp.length), 12); extra.writeBigUInt64LE(BigInt(off), 20); ch.writeUInt16LE(extra.length, 30);
    } else { ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.lieSize ?? f.data.length, 24); ch.writeUInt32LE(off, 42); }
    cd.push(ch, nameB, extra); off += 30 + nameB.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

export const PDB_TEXT = [
  'HEADER    SYNTHETIC TEST STRUCTURE', 'TITLE     SYNTHETIC MINI PEPTIDE', 'EXPDTA    X-RAY DIFFRACTION', 'REMARK   2 RESOLUTION.    1.80 ANGSTROMS.',
  ...[['N', 'ALA', 1, 0, 0, 0, 95.0], ['CA', 'ALA', 1, 1.4, 0, 0, 92.0], ['CA', 'GLY', 2, 3.8, 0, 0, 72.0], ['CA', 'SER', 3, 7.6, 0, 0, 55.0], ['CA', 'LYS', 4, 11.4, 0, 0, 30.0]].map(([n, r, i, x, y, z, b], k) =>
    `ATOM  ${String(k + 1).padStart(5)} ${String(n).padEnd(4)} ${String(r).padStart(3)} A${String(i).padStart(4)}    ${Number(x).toFixed(3).padStart(8)}${Number(y).toFixed(3).padStart(8)}${Number(z).toFixed(3).padStart(8)}${(1).toFixed(2).padStart(6)}${Number(b).toFixed(2).padStart(6)}          ${String(n)[0].padStart(2)}`),
  'END',
].join('\n');

export const FASTA_TEXT = '>NC_TEST.1 Synthetic phage genome\nACGTACGTAC\nGGCCTTAANN\n>seq2 second\nACGT\n';
export const GFF_TEXT = '##gff-version 3\nNC_TEST.1\tsynthetic\tgene\t1\t100\t.\t+\t.\tID=g1\nNC_TEST.1\tsynthetic\tCDS\t5\t90\t.\t+\t0\tID=c1\n';
export const MATRIX_TEXT = ['!Series_title\t"Synthetic series"', '!Series_geo_accession\t"GSE1"', '!Series_platform_id\t"GPL1"', '!Sample_geo_accession\t"GSM1"\t"GSM2"', '!series_matrix_table_begin', 'ID_REF\t"GSM1"\t"GSM2"', '"g1"\t1.5\t2.5', '"g2"\t3\tnull', '!series_matrix_table_end'].join('\n');

export interface MockOpts { afFileBase?: string; afVersion?: number; rcsbMethod?: string; rcsbMethodology?: string; mode?: Record<string, string> }
/** mode keys: e.g. { afJson: 'outage' | 'badjson' | 'ratelimit' | 'ratelimit_once' | 'redirect_evil' | 'html' | 'huge' } */
export async function startMockProviders(opts: MockOpts = {}): Promise<{ origin: string; hits: string[]; acceptHeaders: string[]; opts: MockOpts; close: () => Promise<void>; mutate: (m: Partial<MockOpts>) => void; setMode: (k: string, v: string) => void }> {
  const state = { ...opts, mode: { ...(opts.mode ?? {}) } }; const hits: string[] = []; const acceptHeaders: string[] = []; const counters: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname; hits.push(`${req.method} ${p}${url.search}`); acceptHeaders.push(String(req.headers.accept ?? ''));
    if (p === '/needs-star-accept' && !/^\*\/\*$/.test(String(req.headers.accept ?? ''))) return;   // models a server that stalls on axios' default Accept header
    const send = (code: number, body: string | Buffer, ct = 'application/json', extra: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': ct, ...extra }); res.end(body); };
    const mode = (k: string) => state.mode[k]; const once = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
    const injected = (k: string): boolean => {
      const m = mode(k); if (!m) return false;
      if (m === 'forbidden') { send(403, 'forbidden', 'text/html'); return true; }
      if (m === 'outage') { send(503, 'down', 'text/plain'); return true; }
      if (m === 'badjson') { send(200, '{not json'); return true; }
      if (m === 'ratelimit') { send(429, '{}', 'application/json', { 'retry-after': '0' }); return true; }
      if (m === 'ratelimit_once' && once(k) === 1) { send(429, '{}', 'application/json', { 'retry-after': '0' }); return true; }
      if (m === 'html') { send(200, '<html>login</html>', 'text/html'); return true; }
      if (m === 'redirect_evil') { res.writeHead(302, { location: 'https://evil.example.org/steal' }); res.end(); return true; }
      if (m === 'huge') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(60e6) }); res.end(Buffer.alloc(1024)); return true; }
      return false;
    };
    const afV = state.afVersion ?? 4;
    if (p === '/api/prediction/P69905') {
      if (injected('afJson')) return;
      return send(200, JSON.stringify([{ entryId: 'AF-P69905-F1', uniprotAccession: 'P69905', uniprotId: 'HBA_HUMAN', uniprotDescription: 'Hemoglobin subunit alpha', gene: 'HBA1', organismScientificName: 'Homo sapiens', taxId: 9606, modelCreatedDate: '2022-06-01', latestVersion: afV, uniprotStart: 1, uniprotEnd: 142, globalMetricValue: 97.9, fractionPlddtVeryHigh: 0.95, fractionPlddtConfident: 0.05, fractionPlddtLow: 0, fractionPlddtVeryLow: 0, pdbUrl: `${state.afFileBase ?? origin()}/files/AF-P69905-F1-model_v${afV}.pdb`, cifUrl: `${state.afFileBase ?? origin()}/files/AF-P69905-F1-model_v${afV}.cif`, paeDocUrl: `${state.afFileBase ?? origin()}/files/AF-P69905-F1-predicted_aligned_error_v${afV}.json` }]));
    }
    if (p.startsWith('/files/AF-P69905-F1-model_v') && p.endsWith('.pdb')) { if (injected('afFile')) return; return send(200, PDB_TEXT.replace('SYNTHETIC MINI', `SYNTHETIC v${afV} MINI`), 'chemical/x-pdb'); }
    if (p.startsWith('/files/AF-P69905-F1-predicted_aligned_error')) return send(200, JSON.stringify([{ predicted_aligned_error: [[0, 1], [1, 0]], max_predicted_aligned_error: 31.75 }]));
    if (p === '/rest/v1/core/entry/4HHB' || p === '/rest/v1/core/entry/1XYZ') {
      if (injected('rcsbJson')) return;
      const id = p.endsWith('4HHB') ? '4HHB' : '1XYZ';
      return send(200, JSON.stringify({ rcsb_id: id, struct: { title: 'SYNTHETIC ENTRY' }, exptl: [{ method: id === '1XYZ' ? (state.rcsbMethod ?? 'THEORETICAL MODEL') : (state.rcsbMethod ?? 'X-RAY DIFFRACTION') }], rcsb_entry_info: { resolution_combined: [1.8], polymer_entity_count: 1, structure_determination_methodology: id === '1XYZ' ? (state.rcsbMethodology ?? 'computational') : 'experimental' }, rcsb_accession_info: { initial_release_date: '1984-03-07', revision_date: '2024-02-21', deposit_date: '1984-03-07', major_revision: 4, minor_revision: 2 } }));
    }
    if (p === '/download/4HHB.pdb' || p === '/download/1XYZ.pdb') { if (injected('rcsbFile')) return; return send(200, PDB_TEXT, 'text/plain'); }
    if (p === '/download/4HHB.cif') return send(404, 'nope', 'text/plain');
    if (p === '/rcsbsearch/v2/query' && req.method === 'POST') { if (injected('rcsbSearch')) return; return send(200, JSON.stringify({ total_count: 2, result_set: [{ identifier: '4HHB', score: 1 }, { identifier: '1XYZ', score: 0.5 }] })); }
    if (p === '/datasets/v2/genome/accession/GCF_000000001.1/dataset_report') return send(200, JSON.stringify({ reports: [{ accession: 'GCF_000000001.1', organism: { organism_name: 'Synthetic phage', tax_id: 1 }, assembly_info: { assembly_name: 'syn1', assembly_level: 'Complete Genome', release_date: '2020-01-01' }, assembly_stats: { total_sequence_length: '5386', gc_percent: 44 }, source_database: 'SOURCE_DATABASE_REFSEQ' }] }));
    if (p === '/datasets/v2/genome/accession/GCF_000000002.1/dataset_report') return send(200, JSON.stringify({ reports: [{ accession: 'GCF_000000002.1', organism: { organism_name: 'Synthetic huge' }, assembly_info: { assembly_name: 'big' }, assembly_stats: { total_sequence_length: '3000000000' } }] }));
    if (p === '/datasets/v2/genome/accession/GCF_000000001.1/download') {
      if (injected('ncbiZip')) return;
      const mode = state.mode.ncbiZipKind;
      if (mode === 'bomb') return send(200, makeZip([{ name: 'ncbi_dataset/data/x/genomic.fna', data: Buffer.alloc(40 * 1024 * 1024, 65) }]), 'application/zip');
      if (mode === 'traversal') return send(200, makeZip([{ name: '../../evil.fna', data: Buffer.from('>x\nACGT\n') }]), 'application/zip');
      return send(200, makeZip([{ name: 'ncbi_dataset/data/GCF_000000001.1/GCF_000000001.1_syn1_genomic.fna', data: Buffer.from(FASTA_TEXT), zip64: true }, { name: 'ncbi_dataset/data/GCF_000000001.1/genomic.gff', data: Buffer.from(GFF_TEXT) }, { name: 'ncbi_dataset/dataset_catalog.json', data: Buffer.from('{}') }]), 'application/zip');
    }
    if (p === '/datasets/v2/genome/taxon/synthetic%20phage/dataset_report') return send(200, JSON.stringify({ reports: [{ accession: 'GCF_000000001.1', organism: { organism_name: 'Synthetic phage' } }] }));
    if (p === '/geo/query/acc.cgi') {
      if (injected('geoSoft')) return;
      return send(200, ['^SERIES = GSE1', '!Series_title = Synthetic expression series', '!Series_summary = A synthetic summary.', '!Series_type = Expression profiling by array', '!Series_platform_id = GPL1', '!Series_sample_id = GSM1', '!Series_sample_id = GSM2', '!Series_last_update_date = Mar 01 2020', '!Series_contact_email = person@example.org', '!Series_supplementary_file = ftp://example/x_RAW.tar'].join('\n'), 'text/plain');
    }
    if (p === '/geo/series/GSEnnn/GSE1/matrix/GSE1_series_matrix.txt.gz') { if (mode('geoMatrix') === 'forbidden') return send(403, 'forbidden', 'text/html'); const gz = zlib.gzipSync(Buffer.from(MATRIX_TEXT)); res.writeHead(200, { 'content-type': 'application/x-gzip', 'content-length': String(gz.length) }); return req.method === 'HEAD' ? res.end() : res.end(gz); }
    if (p === '/entrez/eutils/esearch.fcgi') return send(200, JSON.stringify({ esearchresult: { idlist: ['200000001'] } }));
    if (p === '/entrez/eutils/esummary.fcgi') return send(200, JSON.stringify({ result: { uids: ['200000001'], '200000001': { accession: 'GSE1', title: 'Synthetic expression series', taxon: 'Homo sapiens', n_samples: '2' } } }));
    if (p === '/redirect-to') { res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }); return res.end(); }
    if (p === '/needs-star-accept') return send(200, 'ok', 'text/plain');
    send(404, 'not found', 'text/plain');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin: origin(), hits, acceptHeaders, opts: state, close: () => new Promise<void>((r) => server.close(() => r())), mutate: (m) => Object.assign(state, m), setMode: (k, v) => { if (v === '') delete state.mode[k]; else state.mode[k] = v; } };
}
