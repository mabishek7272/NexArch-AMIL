/**
 * Export Agent (M5, plan §8), task type 'export.manuscript' — the final node in every project's graph, unregistered
 * since M1. Deterministic: assembles Markdown, BibTeX, RIS, LaTeX source, a real rendered PDF (`pdf-lib`), a real
 * rendered DOCX (`docx`), and a hash-chained provenance manifest from already-persisted, current content — never
 * generates new prose, never invents a citation. `inspectExport` runs on the real generated artifacts (actual PDF
 * page count, actual citation presence, actual DOCX ZIP/OOXML structure) and its findings are part of the task's
 * own result, not a separate claim. This export reflects the CURRENT review state exactly — plan §6: "a
 * final-review export is not journal acceptance or clinical approval," restated explicitly in every manifest.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { currentSections, listSectionClaims } from '../manuscript-service';
import { listClaims } from '../evidence-service';
import { currentVisuals } from '../visual-service';
import { db } from '../../db';
import { SourceRow } from '../types';
import {
  buildMarkdown, buildLatex, buildPdf, buildDocx, buildProvenanceManifest, serializeBibtex, serializeRis, storeExport, inspectExport,
} from '../export-service';

const NOTICE = 'This export reflects the CURRENT review state of this project. It is NOT a journal acceptance, NOT a completed peer review, and NOT a clinical or academic approval of any kind.';

const exportAgent: AgentHandler = async (ctx) => {
  const allSections = await currentSections(ctx.project.id, ctx.project.owner_id);
  const sections = allSections.filter((s) => s.kind !== 'outline');
  if (!sections.length) return { kind: 'failed', reason: 'No sections exist yet to export.' };
  const sources = await db.query<SourceRow>('SELECT * FROM research_studio_sources WHERE project_id = $1', [ctx.project.id]);
  const visuals = await currentVisuals(ctx.project.id, ctx.project.owner_id);
  const claims = await listClaims(ctx.project.id, ctx.project.owner_id);

  const sectionClaimPairs: Array<{ sectionId: string; claimId: string }> = [];
  for (const s of sections) for (const link of await listSectionClaims(s.id, ctx.project.id)) sectionClaimPairs.push({ sectionId: s.id, claimId: link.claim_id });

  const markdown = `> ${NOTICE}\n\n${buildMarkdown(ctx.project.title, sections, visuals)}`;
  const bibtex = serializeBibtex(sources); const ris = serializeRis(sources);
  const latex = `% ${NOTICE}\n` + buildLatex(ctx.project.title, sections);
  const { bytes: pdfBytes, pageCount } = await buildPdf(ctx.project.title, sections);
  const docxBytes = await buildDocx(ctx.project.title, sections);
  const manifest = buildProvenanceManifest(ctx.project.id, sections, sources, visuals);
  const inspection = inspectExport(markdown + latex, pageCount, claims, sectionClaimPairs, visuals, docxBytes);
  if (!inspection.docx.wellFormed) return { kind: 'failed', reason: 'The rendered DOCX did not verify as a well-formed ZIP/OOXML package; refusing to publish a broken export.' };

  const saved = await Promise.all([
    storeExport(ctx.project.id, ctx.task.id, 'markdown', markdown, manifest),
    storeExport(ctx.project.id, ctx.task.id, 'bibtex', bibtex, manifest),
    storeExport(ctx.project.id, ctx.task.id, 'ris', ris, manifest),
    storeExport(ctx.project.id, ctx.task.id, 'latex', latex, manifest),
    storeExport(ctx.project.id, ctx.task.id, 'pdf', Buffer.from(pdfBytes), manifest),
    storeExport(ctx.project.id, ctx.task.id, 'docx', docxBytes, manifest),
    storeExport(ctx.project.id, ctx.task.id, 'provenance_manifest', JSON.stringify(manifest, null, 2), manifest),
  ]);

  return {
    kind: 'completed',
    result: {
      schema: 'anuclaw-research-studio-export/v1', notice: NOTICE,
      exportIds: saved.map((s) => s.id), formats: saved.map((s) => s.format),
      inspection, manifestSha256: manifest.manifestSha256,
    },
  };
};

export function registerExportAgent(): void { registerAgent('export.manuscript', exportAgent); }
