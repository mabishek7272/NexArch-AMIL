/**
 * Structured parsers for the public formats this integration accepts. Each returns a SUMMARY (counts, ranges, quality flags) — never
 * an interpretation. Anything else is reported as `unsupported_format`; nothing is invented. Pure functions, hard caps on input size.
 */
import * as zlib from 'zlib';
import { ScienceError } from './types';

export const PARSER_VERSION = 'anuclaw-scidata-parsers/1';
const bad = (m: string) => new ScienceError('malformed_response', m, 502);
const MAX_TEXT = 64 * 1024 * 1024;

// ── structures ───────────────────────────────────────────────────────────────
export interface StructureSummary {
  format: 'pdb' | 'mmcif'; models: number; chains: Array<{ id: string; residues: number; atoms: number; hetatmAtoms: number }>; atoms: number; residues: number;
  elements: Record<string, number>; coordinateRange: { min: [number, number, number]; max: [number, number, number] };
  bFactor: { n: number; min: number; max: number; mean: number };
  /** For AlphaFold models the B-factor column holds per-residue pLDDT; for experimental structures it is a B-factor and is NOT a confidence. */
  plddt: { fractionVeryHigh: number; fractionConfident: number; fractionLow: number; fractionVeryLow: number; mean: number; residuesScored: number } | null;
  headerTitle: string | null; experimentalMethod: string | null; resolutionAngstrom: number | null;
}

function summarise(format: StructureSummary['format'], atoms: Array<{ chain: string; resKey: string; het: boolean; x: number; y: number; z: number; b: number; el: string; name: string; model: number }>, meta: Pick<StructureSummary, 'headerTitle' | 'experimentalMethod' | 'resolutionAngstrom'>, treatBAsPlddt: boolean): StructureSummary {
  if (!atoms.length) throw bad('No ATOM/HETATM records were found.');
  const first = Math.min(...atoms.map((a) => a.model)); const a1 = atoms.filter((a) => a.model === first);
  for (const a of a1) if (![a.x, a.y, a.z].every(Number.isFinite)) throw bad('A coordinate is not a finite number.');
  const byChain = new Map<string, { res: Set<string>; atoms: number; het: number }>(); const els: Record<string, number> = {};
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let bsum = 0, bmin = Infinity, bmax = -Infinity, bn = 0;
  for (const a of a1) {
    const c = byChain.get(a.chain) ?? { res: new Set(), atoms: 0, het: 0 }; byChain.set(a.chain, c);
    c.atoms++; if (a.het) c.het++; else c.res.add(a.resKey);
    els[a.el || '?'] = (els[a.el || '?'] ?? 0) + 1;
    [a.x, a.y, a.z].forEach((v, i) => { if (v < min[i]) min[i] = v; if (v > max[i]) max[i] = v; });
    if (Number.isFinite(a.b)) { bsum += a.b; bn++; if (a.b < bmin) bmin = a.b; if (a.b > bmax) bmax = a.b; }
  }
  let plddt: StructureSummary['plddt'] = null;
  if (treatBAsPlddt) {
    const ca = a1.filter((a) => a.name === 'CA' && !a.het && Number.isFinite(a.b)); const n = ca.length;
    if (n) plddt = { residuesScored: n, mean: ca.reduce((s, a) => s + a.b, 0) / n, fractionVeryHigh: ca.filter((a) => a.b > 90).length / n, fractionConfident: ca.filter((a) => a.b > 70 && a.b <= 90).length / n, fractionLow: ca.filter((a) => a.b > 50 && a.b <= 70).length / n, fractionVeryLow: ca.filter((a) => a.b <= 50).length / n };
  }
  const chains = [...byChain].map(([id, c]) => ({ id, residues: c.res.size, atoms: c.atoms, hetatmAtoms: c.het }));
  return { format, models: new Set(atoms.map((a) => a.model)).size, chains, atoms: a1.length, residues: chains.reduce((s, c) => s + c.residues, 0), elements: els, coordinateRange: { min, max }, bFactor: { n: bn, min: bmin, max: bmax, mean: bn ? bsum / bn : NaN }, plddt, ...meta };
}

export function parsePdb(text: string, opts: { bFactorIsPlddt?: boolean } = {}): StructureSummary {
  if (text.length > MAX_TEXT) throw bad('File too large to parse.');
  const atoms: Parameters<typeof summarise>[1] = []; let model = 1; const title: string[] = []; let method: string | null = null, res: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const rec = line.slice(0, 6);
    if (rec === 'MODEL ') model = Number(line.slice(10, 14)) || model + 1;
    else if (rec === 'ATOM  ' || rec === 'HETATM') {
      if (line.length < 54) throw bad('A coordinate record is too short.');
      atoms.push({ chain: line[21].trim() || '_', resKey: `${line.slice(17, 20).trim()}${line.slice(22, 27).trim()}`, het: rec === 'HETATM', x: Number(line.slice(30, 38)), y: Number(line.slice(38, 46)), z: Number(line.slice(46, 54)), b: line.length >= 66 ? Number(line.slice(60, 66)) : NaN, el: line.slice(76, 78).trim(), name: line.slice(12, 16).trim(), model });
    } else if (rec === 'TITLE ') title.push(line.slice(10).trim());
    else if (rec === 'EXPDTA') method = line.slice(10).trim();
    else if (line.startsWith('REMARK   2 RESOLUTION.')) { const m = /RESOLUTION\.\s+([\d.]+)/.exec(line); if (m) res = Number(m[1]); }
  }
  return summarise('pdb', atoms, { headerTitle: title.join(' ') || null, experimentalMethod: method, resolutionAngstrom: res }, Boolean(opts.bFactorIsPlddt));
}

/** Minimal mmCIF tokenizer: handles quoted values, ';' text blocks, comments and loop_ tables. */
export function tokenizeCif(text: string): string[] {
  const out: string[] = []; const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(';')) { let buf = line.slice(1); while (++i < lines.length && !lines[i].startsWith(';')) buf += '\n' + lines[i]; out.push(buf); continue; }
    let p = 0;
    while (p < line.length) {
      const ch = line[p];
      if (ch === ' ' || ch === '\t') { p++; continue; }
      if (ch === '#') break;
      if (ch === "'" || ch === '"') { let q = p + 1; while (q < line.length && !(line[q] === ch && (q + 1 === line.length || /\s/.test(line[q + 1])))) q++; out.push(line.slice(p + 1, q)); p = q + 1; continue; }
      let q = p; while (q < line.length && !/\s/.test(line[q])) q++; out.push(line.slice(p, q)); p = q;
    }
  }
  return out;
}

export function parseMmcif(text: string, opts: { bFactorIsPlddt?: boolean } = {}): StructureSummary {
  if (text.length > MAX_TEXT) throw bad('File too large to parse.');
  const t = tokenizeCif(text); const items = new Map<string, string>(); let atomCols: string[] | null = null; const atomRows: string[][] = [];
  for (let i = 0; i < t.length;) {
    if (t[i] === 'loop_') {
      const cols: string[] = []; i++; while (i < t.length && t[i].startsWith('_')) cols.push(t[i++]);
      const vals: string[] = []; while (i < t.length && !t[i].startsWith('_') && t[i] !== 'loop_' && !t[i].startsWith('data_')) vals.push(t[i++]);
      if (cols[0]?.startsWith('_atom_site.')) { if (vals.length % cols.length) throw bad('The _atom_site loop has a ragged row.'); atomCols = cols; for (let r = 0; r < vals.length; r += cols.length) atomRows.push(vals.slice(r, r + cols.length)); }
    } else if (t[i].startsWith('_')) { items.set(t[i], t[i + 1] ?? ''); i += 2; } else i++;
  }
  if (!atomCols) throw bad('No _atom_site table was found.');
  const ix = (n: string) => atomCols!.indexOf(`_atom_site.${n}`); const need = (n: string) => { const k = ix(n); if (k < 0) throw bad(`_atom_site.${n} is missing.`); return k; };
  const g = need('group_PDB'), x = need('Cartn_x'), y = need('Cartn_y'), z = need('Cartn_z'); const cAsym = ix('label_asym_id') >= 0 ? ix('label_asym_id') : need('auth_asym_id');
  const seq = ix('label_seq_id') >= 0 ? ix('label_seq_id') : ix('auth_seq_id'), comp = ix('label_comp_id'), nm = ix('label_atom_id'), bi = ix('B_iso_or_equiv'), el = ix('type_symbol'), mod = ix('pdbx_PDB_model_num');
  const atoms = atomRows.map((r) => ({ chain: r[cAsym], resKey: `${comp >= 0 ? r[comp] : ''}${seq >= 0 ? r[seq] : ''}`, het: r[g] === 'HETATM', x: Number(r[x]), y: Number(r[y]), z: Number(r[z]), b: bi >= 0 ? Number(r[bi]) : NaN, el: el >= 0 ? r[el] : '', name: nm >= 0 ? r[nm] : '', model: mod >= 0 ? Number(r[mod]) || 1 : 1 }));
  const resolution = Number(items.get('_refine.ls_d_res_high') ?? items.get('_em_3d_reconstruction.resolution') ?? NaN);
  return summarise('mmcif', atoms, { headerTitle: items.get('_struct.title') ?? null, experimentalMethod: items.get('_exptl.method') ?? null, resolutionAngstrom: Number.isFinite(resolution) ? resolution : null }, Boolean(opts.bFactorIsPlddt));
}

// ── sequences and annotation ─────────────────────────────────────────────────
export interface FastaSummary { records: number; totalResidues: number; kind: 'nucleotide' | 'protein' | 'mixed' | 'unknown'; kindIsInferred: true; ambiguousResidues: number; gcFraction: number | null; entries: Array<{ id: string; description: string; length: number }>; entriesTruncated: boolean }
export function parseFasta(text: string, opts: { maxRecords?: number } = {}): FastaSummary {
  if (text.length > MAX_TEXT) throw bad('File too large to parse.');
  const recs: Array<{ id: string; description: string; seq: string[] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('>')) { const h = line.slice(1).trim(); const sp = h.search(/\s/); recs.push({ id: sp < 0 ? h : h.slice(0, sp), description: sp < 0 ? '' : h.slice(sp + 1), seq: [] }); }
    else { if (!recs.length) throw bad('Sequence data appears before any FASTA header.'); if (!/^[A-Za-z*\-.]+$/.test(line)) throw bad('A sequence line contains characters that are not residues.'); recs[recs.length - 1].seq.push(line); }
  }
  if (!recs.length) throw bad('No FASTA records were found.');
  let total = 0, amb = 0, gc = 0, nuc = 0, prot = 0; const entries: FastaSummary['entries'] = []; const cap = opts.maxRecords ?? 50;
  for (const r of recs) {
    const s = r.seq.join('').toUpperCase(); if (!s) throw bad(`Record '${r.id}' has no sequence.`);
    total += s.length; const isNuc = /^[ACGTUNRYKMSWBDHV\-*.]+$/.test(s) && (s.match(/[ACGTUN]/g)?.length ?? 0) / s.length > 0.9; if (isNuc) nuc++; else prot++;
    if (isNuc) { amb += (s.match(/[^ACGTU\-*.]/g) ?? []).length; gc += (s.match(/[GC]/g) ?? []).length; } else amb += (s.match(/[XBZJUO*]/g) ?? []).length;
    if (entries.length < cap) entries.push({ id: r.id, description: r.description.slice(0, 200), length: s.length });
  }
  const nucRes = recs.filter((r) => /^[ACGTUN]+$/i.test(r.seq.join(''))).reduce((s, r) => s + (r.seq.join('').match(/[ACGTU]/gi)?.length ?? 0), 0);   // GC over unambiguous bases
  return { records: recs.length, totalResidues: total, kind: nuc && prot ? 'mixed' : nuc ? 'nucleotide' : prot ? 'protein' : 'unknown', kindIsInferred: true, ambiguousResidues: amb, gcFraction: nuc && !prot && nucRes ? gc / nucRes : null, entries, entriesTruncated: recs.length > cap };
}

export interface Gff3Summary { version: string | null; features: number; byType: Record<string, number>; seqids: string[]; strands: Record<string, number>; minStart: number | null; maxEnd: number | null; malformedLines: number; firstProblems: string[] }
export function parseGff3(text: string): Gff3Summary {
  if (text.length > MAX_TEXT) throw bad('File too large to parse.');
  const byType: Record<string, number> = {}, strands: Record<string, number> = {}, seq = new Set<string>(); let n = 0, minS = Infinity, maxE = -Infinity, malformed = 0, ver: string | null = null; const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    if (line.startsWith('##gff-version')) { ver = line.split(/\s+/)[1] ?? null; return; }
    if (line.startsWith('#')) return;
    const f = line.split('\t'); const start = Number(f[3]), end = Number(f[4]);
    if (f.length !== 9 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || !['+', '-', '.', '?'].includes(f[6])) { malformed++; if (problems.length < 5) problems.push(`line ${i + 1}`); return; }
    n++; byType[f[2]] = (byType[f[2]] ?? 0) + 1; strands[f[6]] = (strands[f[6]] ?? 0) + 1; seq.add(f[0]); if (start < minS) minS = start; if (end > maxE) maxE = end;
  });
  if (!n) throw bad('No valid GFF3 feature lines were found.');
  if (malformed > n) throw bad('Most lines are not valid GFF3.');
  return { version: ver, features: n, byType, seqids: [...seq].slice(0, 100), strands, minStart: minS, maxEnd: maxE, malformedLines: malformed, firstProblems: problems };
}

// ── GEO series matrix ────────────────────────────────────────────────────────
export interface SeriesMatrixSummary { accession: string | null; title: string | null; platforms: string[]; samples: number; features: number; valuesTotal: number; valuesMissing: number; valueRange: { min: number; max: number } | null; sampleAccessions: string[]; firstFeatureIds: string[]; metadataKeys: string[] }
export function parseSeriesMatrix(textOrGz: Buffer | string): SeriesMatrixSummary {
  let text: string;
  if (typeof textOrGz === 'string') text = textOrGz;
  else { try { text = (textOrGz[0] === 0x1f && textOrGz[1] === 0x8b ? zlib.gunzipSync(textOrGz, { maxOutputLength: MAX_TEXT }) : textOrGz).toString('utf8'); } catch { throw bad('The file is not valid gzip data or expands beyond the safety limit.'); } }
  const meta = new Map<string, string[]>(); const feats: string[] = []; let header: string[] | null = null, inTable = false, total = 0, missing = 0, min = Infinity, max = -Infinity;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('!series_matrix_table_begin')) { inTable = true; continue; }
    if (line.startsWith('!series_matrix_table_end')) { inTable = false; continue; }
    if (!inTable) { if (line.startsWith('!')) { const [k, ...v] = line.split('\t'); const key = k.slice(1); meta.set(key, [...(meta.get(key) ?? []), ...v.map((s) => s.replace(/^"|"$/g, ''))]); } continue; }
    if (!line) continue; const f = line.split('\t').map((s) => s.replace(/^"|"$/g, ''));
    if (!header) { if (f[0] !== 'ID_REF') throw bad('The data table has no ID_REF header.'); header = f; continue; }
    if (f.length !== header.length) throw bad('A data row has a different number of columns than the header.');
    feats.push(f[0]);
    for (let i = 1; i < f.length; i++) { total++; const v = f[i]; if (v === '' || /^(null|na|nan)$/i.test(v)) { missing++; continue; } const x = Number(v); if (!Number.isFinite(x)) throw bad('A data value is not numeric.'); if (x < min) min = x; if (x > max) max = x; }
  }
  if (!header) throw bad('No data table was found (this file has metadata only, or is not a series matrix).');
  return { accession: meta.get('Series_geo_accession')?.[0] ?? null, title: meta.get('Series_title')?.[0] ?? null, platforms: [...new Set(meta.get('Series_platform_id') ?? [])], samples: header.length - 1, features: feats.length, valuesTotal: total, valuesMissing: missing, valueRange: Number.isFinite(min) ? { min, max } : null, sampleAccessions: (meta.get('Sample_geo_accession') ?? []).slice(0, 200), firstFeatureIds: feats.slice(0, 5), metadataKeys: [...meta.keys()].slice(0, 80) };
}

// ── zip (read-only, in memory, bounded) ──────────────────────────────────────
export interface ZipEntry { name: string; data: Buffer }
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/**
 * Reads selected members only. Entry names are never used as file paths and nothing is extracted to disk.
 * Limits/refusals: entry count (also for Zip64 directories), DECLARED total uncompressed size over ALL entries, per-entry size, compression ratio,
 * encrypted entries, symlink entries (anywhere in the archive), duplicate member names, unsafe paths, size/CRC mismatches.
 */
export function readZip(buf: Buffer, want: (name: string) => boolean, lim = { maxEntries: 500, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 }): ZipEntry[] {
  let eocd = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('Not a zip archive (no end-of-central-directory record).');
  let count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) {       // Zip64 end-of-central-directory (large or many-entry archives)
    if (eocd < 20 || buf.readUInt32LE(eocd - 20) !== 0x07064b50) throw bad('A Zip64 archive has no Zip64 locator.');
    const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (z64 < 0 || z64 + 56 > buf.length || buf.readUInt32LE(z64) !== 0x06064b50) throw bad('The Zip64 end-of-central-directory record is corrupt.');
    const c64 = buf.readBigUInt64LE(z64 + 32), o64 = buf.readBigUInt64LE(z64 + 48);
    if (c64 > BigInt(lim.maxEntries)) throw new ScienceError('too_large', `The archive has ${c64} entries (limit ${lim.maxEntries}).`, 413);
    count = Number(c64); cdOff = Number(o64);
  }
  if (count > lim.maxEntries) throw new ScienceError('too_large', `The archive has ${count} entries (limit ${lim.maxEntries}).`, 413);
  const out: ZipEntry[] = []; const seen = new Set<string>(); let declaredTotal = 0, total = 0, p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('The zip central directory is corrupt.');
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), eattr = buf.readUInt32LE(p + 38);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), lho = buf.readUInt32LE(p + 42);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {          // Zip64: the real values are in extra field 0x0001, in this order, only for the fields that were 0xFFFFFFFF
      const eStart = p + 46 + nl; let q = eStart, found = false;
      while (q + 4 <= eStart + el) {
        const id = buf.readUInt16LE(q), sz = buf.readUInt16LE(q + 2);
        if (id === 0x0001) {
          let o = q + 4; const take = () => { if (o + 8 > q + 4 + sz) throw bad('A Zip64 extra field is truncated.'); const v = buf.readBigUInt64LE(o); o += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ScienceError('too_large', 'A zip member is larger than supported.', 413); return Number(v); };
          if (usize === 0xffffffff) usize = take(); if (csize === 0xffffffff) csize = take(); if (lho === 0xffffffff) lho = take(); found = true; break;
        }
        q += 4 + sz;
      }
      if (!found) throw bad('A Zip64 entry has no Zip64 extra field.');
    }
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8'); p += 46 + nl + el + cl;
    // The DECLARED size of every entry counts, whether or not we read it: an archive that declares more than the limit is refused outright.
    declaredTotal += usize; if (declaredTotal > lim.maxTotalBytes) throw new ScienceError('too_large', 'The archive declares more uncompressed data than the safety limit.', 413);
    // Unix symlink: the high 16 bits of the external attributes hold st_mode when the archive was made on Unix (version-made-by high byte 3).
    if ((madeBy >> 8) === 3 && (((eattr >>> 16) & 0o170000) === 0o120000)) throw bad(`The archive contains a symbolic link ('${name.slice(0, 80)}'); archives with links are refused.`);
    if (seen.has(name)) throw bad(`The archive has two members named '${name.slice(0, 80)}'.`); seen.add(name);
    if (!want(name)) continue;
    if (name.startsWith('/') || name.includes('..') || name.includes('\\') || /^[A-Za-z]:/.test(name)) throw bad('The archive contains an unsafe member path.');
    if (flags & 1) throw bad('The archive member is encrypted.');
    if (usize > lim.maxEntryBytes || (usize > 0 && csize === 0) || (csize > 0 && usize / csize > 200)) throw new ScienceError('too_large', `Archive member '${name.slice(0, 80)}' is too large or compresses suspiciously well.`, 413);
    total += usize; if (total > lim.maxTotalBytes) throw new ScienceError('too_large', 'The archive expands beyond the safety limit.', 413);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad('A zip local header is corrupt.');
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28); const raw = buf.slice(ds, ds + csize);
    let data: Buffer;
    try { data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: lim.maxEntryBytes }) : (() => { throw bad(`Unsupported zip compression method ${method}.`); })(); } catch (e) { if (e instanceof ScienceError) throw e; throw bad('A zip member could not be decompressed.'); }
    if (data.length !== usize || crc32(data) !== crc) throw bad(`Archive member '${name.slice(0, 80)}' failed its size/CRC check.`);
    out.push({ name, data });
  }
  return out;
}
