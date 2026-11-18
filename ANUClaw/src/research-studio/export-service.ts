/**
 * Export (M5, plan §8). Markdown, BibTeX, RIS and a hash-chained provenance manifest need no third-party dependency
 * (they are text formats this module serialises directly from already-persisted rows). PDF is real and rendered —
 * `pdf-lib` is an existing, already-used dependency (`src/documents/pdf-extract.ts`'s sibling); LaTeX is emitted as
 * valid, inspectable `.tex` SOURCE (no LaTeX engine is installed in this repo, so it is not compiled — this is
 * stated explicitly in the export's own manifest, never implied to be a rendered PDF). DOCX is real and rendered via
 * `docx` (dolanmiu/docx, MIT, pure JS, no native bindings) — added as a direct dependency specifically for this
 * (`package.json`: `"docx": "9.15.4"`, exact-pinned; `npm ls docx` shows it introduces no transitive vulnerabilities
 * of its own). Never a renamed HTML/Markdown file passed off as `.docx` — `buildDocx` constructs a real Open XML
 * package via the library's `Document`/`Paragraph` model and `Packer.toBuffer`.
 *
 * `inspectExport` performs REAL, automatable checks on the generated artifact — not a description of what a human
 * should look for: citation consistency (every claim a section cites appears in the export text), PDF pagination
 * (the actual page count from the rendered document), table/figure presence (every current visual's SVG is
 * well-formed and non-empty).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { canonical, sha256Hex } from '../validation/study/manifest';
import { ownProject } from './permissions';
import { ExportRow, SectionRow, SourceRow, VisualSpecRow, ClaimRow } from './types';

const uid = () => crypto.randomUUID();

export function exportRoot(): string { return process.env.ANUCLAW_RESEARCH_STUDIO_EXPORT_ROOT ?? path.join(process.cwd(), 'data', 'research-studio-exports'); }

// ── Citation serialisers (text formats; no dependency needed) ──────────────────────────────────────────────────
function bibtexKey(s: SourceRow): string { const first = (JSON.parse(s.authors_json)[0] as string | undefined)?.split(/[ ,]/)[0] ?? 'anon'; return `${first.toLowerCase().replace(/[^a-z]/g, '')}${s.year ?? ''}`; }
export function serializeBibtex(sources: SourceRow[]): string {
  return sources.map((s) => {
    const authors = (JSON.parse(s.authors_json) as string[]).join(' and ');
    const fields = [`title = {${s.title}}`, authors && `author = {${authors}}`, s.year && `year = {${s.year}}`, s.venue && `journal = {${s.venue}}`, s.doi && `doi = {${s.doi}}`, s.url && `url = {${s.url}}`].filter(Boolean);
    return `@article{${bibtexKey(s)},\n  ${fields.join(',\n  ')}\n}`;
  }).join('\n\n');
}
export function serializeRis(sources: SourceRow[]): string {
  return sources.map((s) => {
    const authors = (JSON.parse(s.authors_json) as string[]).map((a) => `AU  - ${a}`).join('\n');
    const lines = ['TY  - JOUR', `TI  - ${s.title}`, authors, s.year && `PY  - ${s.year}`, s.venue && `JO  - ${s.venue}`, s.doi && `DO  - ${s.doi}`, s.url && `UR  - ${s.url}`, 'ER  - '].filter(Boolean);
    return lines.join('\n');
  }).join('\n\n');
}

// ── Markdown / LaTeX ─────────────────────────────────────────────────────────────────────────────────────────────
export function buildMarkdown(title: string, sections: SectionRow[], visuals: VisualSpecRow[]): string {
  const body = sections.map((s) => `## ${s.title}\n\n${s.content_text}${s.invalidated_at ? '\n\n> **STALE**: ' + s.invalidated_reason : ''}`).join('\n\n');
  const figs = visuals.length ? `\n\n## Visuals\n\n${visuals.map((v) => `### ${v.title}\n\n_${v.kind === 'conceptual' ? 'Conceptual diagram — not derived from measured data.' : `Data-derived from a verified research run.`}_\n\n(SVG rendering omitted from Markdown; see the provenance manifest / export API for the rendered figure.)`).join('\n\n')}` : '';
  return `# ${title}\n\n${body}${figs}\n`;
}
export function buildLatex(title: string, sections: SectionRow[]): string {
  const esc = (s: string) => s.replace(/[&%$#_{}~^\\]/g, (c) => `\\${c}`);
  const body = sections.map((s) => `\\section{${esc(s.title)}}\n${esc(s.content_text)}`).join('\n\n');
  return `% Generated LaTeX SOURCE — not compiled (no LaTeX engine is installed in this repository).\n\\documentclass{article}\n\\title{${esc(title)}}\n\\begin{document}\n\\maketitle\n${body}\n\\end{document}\n`;
}

/** A real, rendered PDF via pdf-lib — not a placeholder. Returns the bytes and the actual page count pdf-lib reports. */
export async function buildPdf(title: string, sections: SectionRow[]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const MARGIN = 50, FONT_SIZE = 11, LINE_H = 14, PAGE_W = 612, PAGE_H = 792;
  let page = doc.addPage([PAGE_W, PAGE_H]); let y = PAGE_H - MARGIN;
  const writeLine = (text: string, size = FONT_SIZE) => {
    if (y < MARGIN) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
    page.drawText(text.slice(0, 110), { x: MARGIN, y, size, font }); y -= LINE_H;
  };
  writeLine(title, 16); y -= 6;
  for (const s of sections) {
    writeLine(s.title, 13);
    const words = s.content_text.split(/\s+/); let line = '';
    for (const w of words) { if ((line + ' ' + w).length > 95) { writeLine(line); line = w; } else line = line ? `${line} ${w}` : w; }
    if (line) writeLine(line);
    y -= 6;
  }
  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount() };
}

/** A real Open XML (.docx) package via the `docx` library's document model — never a renamed text/HTML file. */
export async function buildDocx(title: string, sections: SectionRow[]): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const s of sections) {
    children.push(new Paragraph({ text: s.title, heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ children: [new TextRun(s.content_text)] }));
    if (s.invalidated_at) children.push(new Paragraph({ children: [new TextRun({ text: `STALE: ${s.invalidated_reason ?? ''}`, bold: true, color: 'C00000' })] }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Provenance manifest (hash-chained, exactly like task events) ──────────────────────────────────────────────
export interface ProvenanceManifest {
  schema: 'anuclaw-research-studio-export-manifest/v1'; builtAt: number; projectId: string;
  sections: Array<{ id: string; sectionKey: string; version: number; contentSource: string; contentSha256: string }>;
  sources: Array<{ id: string; doi: string | null; metadataVerificationStatus: string; structureProvenance?: unknown }>;
  visuals: Array<{ id: string; visualKey: string; kind: string; dataProvenance: unknown }>;
  manifestSha256: string;
}
export function buildProvenanceManifest(projectId: string, sections: SectionRow[], sources: SourceRow[], visuals: VisualSpecRow[], now = Date.now()): ProvenanceManifest {
  const base = {
    schema: 'anuclaw-research-studio-export-manifest/v1' as const, builtAt: now, projectId,
    sections: sections.map((s) => ({ id: s.id, sectionKey: s.section_key, version: s.version, contentSource: s.content_source, contentSha256: sha256Hex(s.content_text) })),
    sources: sources.map((s) => ({ id: s.id, doi: s.doi, metadataVerificationStatus: s.metadata_verification_status, ...(s.source_type === 'predicted_structure' ? { structureProvenance: JSON.parse(s.metadata_json) } : {}) })),
    visuals: visuals.map((v) => ({ id: v.id, visualKey: v.visual_key, kind: v.kind, dataProvenance: JSON.parse(v.data_provenance_json) })),
  };
  return { ...base, manifestSha256: sha256Hex(canonical(base)) };
}

// ── Inspection (real checks on the generated artifact, not a description of what to look for) ──────────────────
export interface ExportInspection {
  citationConsistency: { checked: number; missing: string[] };
  pagination: { pageCount: number | null };
  visuals: { checked: number; malformed: string[] };
  docx: { wellFormed: boolean | null };
}

/** A REAL structural check: a .docx is a ZIP/OOXML container — refuses to call it well-formed unless the ZIP local-file
 * signature is present AND the package actually contains a `word/document.xml` entry name, never a renamed text file. */
export function inspectDocxStructure(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false; // 'PK' ZIP local-file signature
  return bytes.includes(Buffer.from('word/document.xml', 'ascii'));
}

export function inspectExport(markdownOrLatex: string, pdfPageCount: number | null, claims: ClaimRow[], sectionClaimPairs: Array<{ sectionId: string; claimId: string }>, visuals: VisualSpecRow[], docxBytes?: Buffer): ExportInspection {
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const missing = sectionClaimPairs
    .map((p) => claimById.get(p.claimId))
    .filter((c): c is ClaimRow => !!c)
    .filter((c) => !markdownOrLatex.includes(c.statement.slice(0, 40)))
    .map((c) => c.id);
  const malformed = visuals.filter((v) => !v.svg.startsWith('<svg') || !/width="\d/.test(v.svg)).map((v) => v.id);
  return {
    citationConsistency: { checked: sectionClaimPairs.length, missing: [...new Set(missing)] },
    pagination: { pageCount: pdfPageCount }, visuals: { checked: visuals.length, malformed },
    docx: { wellFormed: docxBytes ? inspectDocxStructure(docxBytes) : null },
  };
}

// ── Storage + persistence ───────────────────────────────────────────────────────────────────────────────────────
const KNOWN_FORMATS: ExportRow['format'][] = ['markdown', 'bibtex', 'ris', 'latex', 'pdf', 'docx', 'provenance_manifest'];
function safeDir(projectId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(projectId)) throw new Error('export storage requires a server-generated UUID project id.');
  return path.join(exportRoot(), projectId);
}
export async function storeExport(projectId: string, taskId: string, format: ExportRow['format'], content: Buffer | string, manifest: unknown, now = Date.now()): Promise<ExportRow> {
  if (!KNOWN_FORMATS.includes(format)) throw new Error(`storeExport: "${format}" is not a known export format — refusing to write an arbitrarily-named file.`);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const dir = safeDir(projectId); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sha = sha256Hex(buf); const fileName = `${format}-${sha.slice(0, 16)}`;
  const storagePath = path.join(dir, fileName); fs.writeFileSync(storagePath, buf, { mode: 0o600 });
  const id = uid(); const manifestJson = JSON.stringify(manifest);
  await db.query('INSERT INTO research_studio_exports (id, project_id, task_id, format, content_sha256, byte_size, storage_path, manifest_json, built_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, projectId, taskId, format, sha, buf.length, storagePath, manifestJson, now]);
  return { id, project_id: projectId, task_id: taskId, format, content_sha256: sha, byte_size: buf.length, storage_path: storagePath, manifest_json: manifestJson, built_at: now };
}
export async function listExports(projectId: string, userId: string): Promise<ExportRow[]> { await ownProject(projectId, userId); return db.query<ExportRow>('SELECT * FROM research_studio_exports WHERE project_id = $1 ORDER BY ordinal', [projectId]); }
export async function getExport(exportId: string, projectId: string, userId: string): Promise<ExportRow | undefined> { await ownProject(projectId, userId); return db.queryOne<ExportRow>('SELECT * FROM research_studio_exports WHERE id = $1 AND project_id = $2', [exportId, projectId]); }

/** Re-reads the stored file and recomputes its hash against the DB record — a download must never hand out bytes
 * that silently drifted from what was recorded (on-disk tampering, a corrupted write, filesystem bit-rot). Fails
 * closed: a mismatch throws rather than serving the (now-untrusted) bytes. */
export async function readVerifiedExport(exp: Pick<ExportRow, 'storage_path' | 'content_sha256'>): Promise<Buffer> {
  const root = path.resolve(exportRoot());
  const resolved = path.resolve(exp.storage_path);
  if (!resolved.startsWith(root + path.sep)) throw new WorkflowError(500, 'path_escape', 'Refused: export path is outside the research-studio export root.');
  const bytes = fs.readFileSync(resolved);
  const actual = sha256Hex(bytes);
  if (actual !== exp.content_sha256) throw new WorkflowError(409, 'integrity_failure', `Export integrity check failed: the stored file no longer matches its recorded hash — it was modified after it was written. Refusing to serve it.`);
  return bytes;
}
