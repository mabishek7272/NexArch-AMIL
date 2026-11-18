/**
 * PDF export rendered directly from the SAME structured report as the HTML view
 * (plan §7.4). Status banner on every page, provenance, page numbers. Standard
 * Helvetica (WinAnsi): characters outside that encoding are transliterated
 * (≤ → <=, – → -) or replaced with "?" — never silently dropped.
 */
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib';
import { StructuredReport } from './report';

const TRANSLIT: Record<string, string> = { '≤': '<=', '≥': '>=', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '·': '-', ' ': ' ' };

export function toWinAnsi(text: string, font: PDFFont): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const t = TRANSLIT[ch] ?? ch;
    try { font.encodeText(t); out += t; } catch { out += '?'; }
  }
  return out;
}

export async function renderReportPdf(r: StructuredReport, meta: { reportId: string; version: number; status: string; reviewedBy?: string | null }): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Report ${meta.reportId} v${meta.version}`);
  pdf.setProducer('ANUClaw');
  pdf.setCreationDate(new Date(r.provenance.createdAt && !Number.isNaN(Date.parse(r.provenance.createdAt)) ? r.provenance.createdAt : Date.now()));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 50, LH = 14;
  const status = meta.status === 'reviewed' ? `REVIEWED${meta.reviewedBy ? ` by ${meta.reviewedBy}` : ''}` : meta.status === 'superseded' ? 'SUPERSEDED - DO NOT USE' : 'DRAFT - NOT REVIEWED';
  const banner = `${status} | version ${meta.version} | report ${meta.reportId}`;

  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    const colour = meta.status === 'reviewed' ? rgb(0.02, 0.47, 0.34) : rgb(0.7, 0.33, 0.04);
    page.drawRectangle({ x: M - 6, y: H - M - 6, width: W - 2 * M + 12, height: 22, borderColor: colour, borderWidth: 1.5 });
    page.drawText(toWinAnsi(banner, bold), { x: M, y: H - M, size: 10, font: bold, color: colour });
    y = H - M - 32;
  };
  const wrap = (text: string, f: PDFFont, size: number, width: number): string[] => {
    const words = toWinAnsi(text, f).split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
      if (cur) lines.push(cur);
      // hard-break very long tokens (e.g. hashes)
      let rest = w;
      while (f.widthOfTextAtSize(rest, size) > width) {
        let i = rest.length;
        while (i > 1 && f.widthOfTextAtSize(rest.slice(0, i), size) > width) i--;
        lines.push(rest.slice(0, i)); rest = rest.slice(i);
      }
      cur = rest;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const para = (text: string, opts: { size?: number; f?: PDFFont; indent?: number; gap?: number } = {}) => {
    const size = opts.size ?? 10, f = opts.f ?? font, indent = opts.indent ?? 0;
    for (const line of wrap(text, f, size, W - 2 * M - indent)) {
      if (y < M + LH) newPage();
      page.drawText(line, { x: M + indent, y, size, font: f });
      y -= size + 4;
    }
    y -= opts.gap ?? 4;
  };
  const heading = (t: string, size = 13) => { if (y < M + 3 * LH) newPage(); y -= 4; para(t, { size, f: bold, gap: 2 }); };
  const bullets = (items: string[]) => { if (!items.length) para('(none)', { indent: 12 }); for (const i of items) para(`- ${i}`, { indent: 12, gap: 1 }); y -= 3; };

  newPage();
  heading('Clinician view (SOAP)', 16);
  heading('Subjective');
  if (r.soap.subjective.provided) bullets(r.soap.subjective.items.map((i) => `${i.text} (${i.source}, ${i.date})`));
  else para(r.soap.subjective.note ?? '');
  heading('Objective');
  bullets(r.soap.objective.items.map((i) => `${i.text} [${i.source}]`));
  heading('Assessment');
  bullets(r.soap.assessment.items.map((i) => `${i.text} [${i.ruleId}@${i.ruleVersion}]`));
  para(r.soap.assessment.note);
  para(r.soap.assessment.clinicalRules);
  heading('Plan');
  para(r.soap.plan.note);
  heading('Plain-language summary', 16);
  bullets(r.layman.items);
  heading('Limitations', 11);
  bullets(r.layman.limitations);
  heading('Questions for your clinician', 11);
  bullets(r.layman.questions);
  heading('Provenance', 11);
  para(`Snapshot ${r.provenance.snapshotId} (sha256 ${r.provenance.snapshotHash})`, { size: 8 });
  para(`Rule run ${r.provenance.ruleRunId} (output sha256 ${r.provenance.ruleRunOutputHash}) - ${r.provenance.engineVersion}`, { size: 8 });
  para(`Created ${r.provenance.createdAt}`, { size: 8 });

  const pages = pdf.getPages();
  pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M - 70, y: M - 25, size: 8, font }));
  return Buffer.from(await pdf.save());
}
