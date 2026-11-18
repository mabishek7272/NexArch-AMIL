/**
 * Local literature import (M2, plan §3A): RIS/BibTeX bibliography parsing, and safe storage of permitted local PDF/text
 * artifacts. No existing RIS/BibTeX dependency was found in this repo (checked package.json) — these are small, bounded
 * formats, so hand-written deterministic parsers are used rather than adding a new third-party dependency. Every
 * record's original raw text is preserved alongside the parsed fields, and a record that fails to parse is reported as
 * a named failure, never silently dropped (plan §3A: "preserve original records and report parse failures").
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractPdfText, looksLikePdf, DEFAULT_PDF_LIMITS } from '../documents/pdf-extract';

const sha256OfBuffer = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

export interface ImportedRecord { title: string; authors: string[]; year: number | null; doi: string | null; url: string | null; venue: string | null; raw: string }
export interface ImportFailure { index: number; raw: string; reason: string }
export interface ImportResult { records: ImportedRecord[]; failures: ImportFailure[]; format: 'ris' | 'bibtex' }

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** RIS: one record per block ending in "ER  - "; tag lines are "XX  - value" (2-letter tag, 2 spaces, dash). */
export function parseRis(text: string): ImportResult {
  const records: ImportedRecord[] = []; const failures: ImportFailure[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\nER\s*-\s*\n?/).map((b) => b.trim()).filter(Boolean);
  blocks.forEach((raw, i) => {
    const lines = raw.split('\n').filter((l) => /^[A-Z0-9]{2}\s*-\s?/.test(l));
    if (!lines.length) { failures.push({ index: i, raw, reason: 'no recognisable RIS tag lines (expected "XX  - value")' }); return; }
    const authors: string[] = []; let title = ''; let year: number | null = null; let doi: string | null = null; let url: string | null = null; let venue: string | null = null;
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9]{2})\s*-\s?(.*)$/); if (!m) continue;
      const [, tag, val] = m; const v = val.trim();
      if (tag === 'AU' || tag === 'A1') authors.push(v);
      else if (tag === 'TI' || tag === 'T1') title = title || v;
      else if (tag === 'PY' || tag === 'Y1') { const y = parseInt(v.slice(0, 4), 10); if (Number.isFinite(y)) year = y; }
      else if (tag === 'DO') doi = v;
      else if (tag === 'UR') url = url || v;
      else if (tag === 'JO' || tag === 'T2' || tag === 'JF') venue = venue || v;
    }
    if (!title) { failures.push({ index: i, raw, reason: 'no TI/T1 (title) tag found' }); return; }
    records.push({ title, authors, year, doi, url, venue, raw });
  });
  return { records, failures, format: 'ris' };
}

/** A small, deliberately strict BibTeX parser: @type{key, field = {value} or "value" or bare, ...}. One level of brace nesting in values is tolerated; anything else for an entry is reported as a failure, never guessed. */
export function parseBibtex(text: string): ImportResult {
  const records: ImportedRecord[] = []; const failures: ImportFailure[] = [];
  const entryStarts = [...text.matchAll(/@(\w+)\s*\{/g)];
  entryStarts.forEach((m, i) => {
    const start = m.index!; let depth = 0; let end = -1;
    for (let j = start + m[0].length - 1; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) { failures.push({ index: i, raw: text.slice(start, Math.min(start + 200, text.length)), reason: 'unbalanced braces: entry never closes' }); return; }
    const raw = text.slice(start, end + 1);
    const body = text.slice(start + m[0].length, end);
    const firstComma = body.indexOf(','); if (firstComma === -1) { failures.push({ index: i, raw, reason: 'no fields found after the citation key' }); return; }
    const fields: Record<string, string> = {};
    const fieldRe = /(\w+)\s*=\s*(\{([^{}]*)\}|"([^"]*)"|([^,}]+))\s*,?/g;
    let fm: RegExpExecArray | null; const fieldsText = body.slice(firstComma + 1);
    while ((fm = fieldRe.exec(fieldsText))) { fields[fm[1].toLowerCase()] = (fm[3] ?? fm[4] ?? fm[5] ?? '').trim(); }
    const title = fields.title; if (!title) { failures.push({ index: i, raw, reason: 'no title field found' }); return; }
    const authors = fields.author ? fields.author.split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean) : [];
    const year = fields.year ? parseInt(fields.year.slice(0, 4), 10) : null;
    records.push({ title, authors, year: Number.isFinite(year) ? year : null, doi: fields.doi ?? null, url: fields.url ?? null, venue: fields.journal ?? fields.booktitle ?? null, raw });
  });
  return { records, failures, format: 'bibtex' };
}

export function detectAndParseBibliography(text: string): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) throw new Error(`Import text exceeds the ${MAX_IMPORT_BYTES}-byte limit.`);
  if (/^\s*TY\s*-/m.test(text)) return parseRis(text);
  if (/@\w+\s*\{/.test(text)) return parseBibtex(text);
  throw new Error('Unrecognised bibliography format: expected RIS (starts with "TY  -") or BibTeX ("@article{...").');
}

// ── Local artifact storage (permitted PDFs/text; project-scoped; ids are always server-generated UUIDs, never
//    user-supplied path segments) ──────────────────────────────────────────────────────────────────────────────────
const ID_RE = /^[a-f0-9-]{36}$/;
export function artifactRoot(): string { return process.env.ANUCLAW_RESEARCH_STUDIO_ROOT ?? path.join(process.cwd(), 'data', 'research-studio-artifacts'); }
function safeDir(projectId: string, sourceId: string): string {
  if (!ID_RE.test(projectId) || !ID_RE.test(sourceId)) throw new Error('artifact storage requires server-generated UUIDs for project/source ids.');
  return path.join(artifactRoot(), projectId, sourceId);
}

export const MAX_ARTIFACT_BYTES = DEFAULT_PDF_LIMITS.maxBytes;
export interface StoredArtifact { kind: 'pdf' | 'text'; storagePath: string; sha256: string; sizeBytes: number; extractedText?: string; extractionError?: string }

/** Stores ONE permitted local artifact (PDF or plain text) for a source, under a project-scoped, mode-0700 directory. PDFs are text-extracted immediately via the existing extractPdfText (bounded; never OCR here — that is a separate, heavier pipeline). */
export async function storeArtifact(projectId: string, sourceId: string, filename: string, buf: Buffer): Promise<StoredArtifact> {
  if (buf.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte limit.`);
  const isPdf = looksLikePdf(buf);
  const dir = safeDir(projectId, sourceId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha = sha256OfBuffer(buf);
  const safeName = `${sha.slice(0, 16)}${isPdf ? '.pdf' : '.txt'}`;
  const storagePath = path.join(dir, safeName);
  fs.writeFileSync(storagePath, buf, { mode: 0o600 });
  if (isPdf) {
    const extracted = await extractPdfText(buf);
    if (extracted.status === 'failed') return { kind: 'pdf', storagePath, sha256: sha, sizeBytes: buf.length, extractionError: extracted.error };
    return { kind: 'pdf', storagePath, sha256: sha, sizeBytes: buf.length, extractedText: extracted.pages.map((p) => p.text).join('\n\n') };
  }
  return { kind: 'text', storagePath, sha256: sha, sizeBytes: buf.length, extractedText: buf.toString('utf8') };
}

/** Re-reads a stored TEXT artifact's content (not for PDFs — their text was extracted once at import time and is stored as an excerpt/evidence record, not re-parsed). Refuses any path outside the artifact root. */
export function readArtifactText(storagePath: string): string {
  const root = path.resolve(artifactRoot());
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith(root + path.sep)) throw new Error('refused: artifact path is outside the research-studio artifact root.');
  return fs.readFileSync(resolved, 'utf8');
}

/** Structure copy into the existing private project/source artifact tree. Server-selected format, hashed filename. */
export function storeStructureArtifact(projectId: string, sourceId: string, format: string, buf: Buffer): { path: string; sha256: string; size: number } {
  if (!['pdb', 'mmcif', 'bcif', 'pae', 'plddt'].includes(format) || !buf.length || buf.length > 20e6) throw new Error('Invalid or oversized structure artifact.');
  const dir = safeDir(projectId, sourceId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(buf).digest('hex'); const fp = path.join(dir, hash);
  if (fs.existsSync(fp)) { if (crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex') !== hash) throw new Error('Artifact hash mismatch; refusing replacement.'); }
  else fs.writeFileSync(fp, buf, { flag: 'wx', mode: 0o600 });
  return { path: fp, sha256: hash, size: buf.length };
}
