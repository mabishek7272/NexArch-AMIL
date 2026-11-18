/**
 * ANUClaw Research Studio — mounted at /api/research-studio (M1 foundation: projects + a durable task graph; M2:
 * evidence graph — search strategies/runs, sources, dedup links, artifacts, excerpts, claims, screening, evidence
 * matrix). Roles: admin, operator, clinician (same as /api/research). Projects and tasks are OWNER-ONLY.
 * See docs/RESEARCH-STUDIO-PLAN.md for exactly what is and is not implemented.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { requireDashAuth, requireRole, AuthRequest } from '../auth';
import { WorkflowError } from '../../../documents/workflow';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';
import { createProject, listProjects, getProject, reviseBrief, listRevisions } from '../../../research-studio/project-service';
import { ownProject, ownTask } from '../../../research-studio/permissions';
import { createTask, getTask, pauseTask, resumeTask, cancelTask, resolveAwaitingUser, listEvents, verifyEventChain, TaskStoreError } from '../../../research-studio/task-store';
import { tick, runToQuiescence, projectGraphView } from '../../../research-studio/orchestrator';
import { runnableTypes } from '../../../research-studio/agent-registry';
import { PROJECT_MODES } from '../../../research-studio/types';
import { createSearchStrategy, listSearchStrategies, listSearchRuns } from '../../../research-studio/search-service';
import {
  createSource, listSources, getSource, reviseSourceMetadata, listSourceLinks, decideSourceLink, recordArtifact, listArtifacts,
  createExcerpt, listExcerpts, createClaim, listClaims, linkClaimEvidence, listClaimLinks, recordScreeningDecision,
  currentScreeningDecisions, screeningHistory, latestEvidenceMatrix,
} from '../../../research-studio/evidence-service';
import { detectAndParseBibliography, storeArtifact } from '../../../research-studio/import-service';
import {
  createProfile, listProfiles, getProfile, beginConnect, confirmConnected, disconnectProfile, revokeProfile, BrowserProfileError,
} from '../../../research-studio/browser/profile-service';
import {
  listSectionVersions, currentSections, getSection, addComment, listComments, decideSection, linkSectionClaim, listSectionClaims,
  invalidateSectionsForTasks,
} from '../../../research-studio/manuscript-service';
import { createGuideline, listGuidelines, confirmChecklistItem, latestComplianceReport } from '../../../research-studio/guideline-service';
import { createVisual, buildPrismaFlow, currentVisuals, listVisuals, invalidateVisualsForTasks } from '../../../research-studio/visual-service';
import { listExports, getExport, readVerifiedExport } from '../../../research-studio/export-service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const router = Router();
function handle(res: Response, err: unknown): void {
  if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message, code: err.code, details: err.details }); return; }
  if (err instanceof TaskStoreError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  if (err instanceof BrowserProfileError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  logger.error(`research-studio route error: ${safeErrorSummary(err)}`);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
}
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: AuthRequest, res: Response) => { fn(req, res).catch((e) => handle(res, e)); };

router.use(requireDashAuth, requireRole('admin', 'operator', 'clinician'));

router.get('/', wrap(async (_req, res) => {
  res.json({
    purpose: 'Autonomous research-article and thesis workflows. M1+M2: durable projects/task graphs, Research Planner, and a real evidence graph (search strategies/runs, sources, dedup links, artifacts, excerpts, claims, screening, evidence matrix) with deterministic Literature Scout / Source Verifier / Evidence Extractor / Evidence Matrix Builder agents. No browser/MCP automation, writing, critique or export agent is implemented yet — queued tasks of those types have no agent and will not advance.',
    modes: PROJECT_MODES, runnableTaskTypes: runnableTypes(),
  });
}));

router.post('/projects', wrap(async (req, res) => {
  const b = req.body ?? {};
  const project = await createProject({ userId: req.user!.id, mode: b.mode, title: b.title, brief: b.brief });
  await createTask(project.id, { type: 'plan.scope_and_graph' });
  const steps = await runToQuiescence(project.id, 10);   // the planner is free/deterministic: run it immediately so the graph exists before the first page load
  res.status(201).json({ project, planSteps: steps.length, graph: await projectGraphView(project.id) });
}));

router.get('/projects', wrap(async (req, res) => { res.json({ projects: await listProjects(req.user!.id) }); }));

router.get('/projects/:id', wrap(async (req, res) => {
  const project = await getProject(String(req.params.id), req.user!.id);
  res.json({ project, graph: await projectGraphView(project.id) });
}));

router.patch('/projects/:id/brief', wrap(async (req, res) => { res.json({ project: await reviseBrief(String(req.params.id), req.user!.id, req.body?.brief) }); }));
router.get('/projects/:id/revisions', wrap(async (req, res) => { res.json({ revisions: await listRevisions(String(req.params.id), req.user!.id) }); }));

router.get('/projects/:id/graph', wrap(async (req, res) => { await ownProject(String(req.params.id), req.user!.id); res.json({ graph: await projectGraphView(String(req.params.id)) }); }));

router.post('/projects/:id/tick', wrap(async (req, res) => { await ownProject(String(req.params.id), req.user!.id); res.json(await tick(String(req.params.id))); }));
router.post('/projects/:id/advance', wrap(async (req, res) => {
  await ownProject(String(req.params.id), req.user!.id);
  const steps = Math.min(Number(req.body?.maxSteps ?? 50) || 50, 200);
  res.json({ steps: await runToQuiescence(String(req.params.id), steps), graph: await projectGraphView(String(req.params.id)) });
}));

router.get('/projects/:id/events', wrap(async (req, res) => {
  await ownProject(String(req.params.id), req.user!.id);
  res.json({ events: await listEvents(String(req.params.id)), chain: await verifyEventChain(String(req.params.id)) });
}));

router.post('/tasks/:id/pause', wrap(async (req, res) => { const { task } = await ownTask(String(req.params.id), req.user!.id); res.json({ task: await pauseTask(task.id) }); }));
router.post('/tasks/:id/resume', wrap(async (req, res) => { const { task } = await ownTask(String(req.params.id), req.user!.id); res.json({ task: await resumeTask(task.id) }); }));
router.post('/tasks/:id/cancel', wrap(async (req, res) => { const { task } = await ownTask(String(req.params.id), req.user!.id); res.json({ task: await cancelTask(task.id, String(req.body?.reason ?? 'cancelled by user')) }); }));
router.post('/tasks/:id/resolve', wrap(async (req, res) => { const { task } = await ownTask(String(req.params.id), req.user!.id); res.json({ task: await resolveAwaitingUser(task.id, req.body?.answer) }); }));

// ── M2: evidence graph ───────────────────────────────────────────────────────────────────────────────────────────
router.post('/projects/:id/search-strategies', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  res.status(201).json({ strategy: await createSearchStrategy(pid, req.user!.id, { databases: req.body?.databases ?? [], queries: req.body?.queries ?? [], filters: req.body?.filters }) });
}));
router.get('/projects/:id/search-strategies', wrap(async (req, res) => { res.json({ strategies: await listSearchStrategies(String(req.params.id), req.user!.id) }); }));
router.get('/projects/:id/search-runs', wrap(async (req, res) => { res.json({ runs: await listSearchRuns(String(req.params.id), req.user!.id) }); }));

router.post('/projects/:id/sources', wrap(async (req, res) => {
  const pid = String(req.params.id); const b = req.body ?? {};
  const out = await createSource(pid, req.user!.id, { doi: b.doi, pmid: b.pmid, url: b.url, title: b.title, authors: b.authors, year: b.year, venue: b.venue, sourceType: b.sourceType, metadata: b.metadata, importProvenance: { origin: 'manual', by: req.user!.id, at: Date.now() } });
  res.status(201).json(out);
}));
router.get('/projects/:id/sources', wrap(async (req, res) => { res.json({ sources: await listSources(String(req.params.id), req.user!.id) }); }));
router.get('/projects/:id/sources/:sourceId', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  const source = await getSource(String(req.params.sourceId), pid); if (!source) throw new WorkflowError(404, 'not_found', 'Source not found.');
  res.json({ source, artifacts: await listArtifacts(source.id, pid, req.user!.id), screening: await screeningHistory(source.id, pid, req.user!.id) });
}));
/** A material source revision cascades through M1's invalidateDownstream to TASKS (evidence-service.ts) and now also
 * directly to any manuscript SECTION produced by one of those invalidated tasks — plan §4's invalidation requirement
 * reaching all the way to manuscript content, not stopping at the task graph. */
router.patch('/projects/:id/sources/:sourceId', wrap(async (req, res) => {
  const pid = String(req.params.id); const b = req.body ?? {};
  const out = await reviseSourceMetadata(String(req.params.sourceId), pid, req.user!.id, { doi: b.doi, title: b.title, metadata: b.metadata, correctionStatus: b.correctionStatus }, b.retrievalMetadata ?? {});
  const reason = `source ${req.params.sourceId} was revised`;
  const [invalidatedSections, invalidatedVisuals] = await Promise.all([
    invalidateSectionsForTasks(out.invalidatedTasks, reason),
    invalidateVisualsForTasks(out.invalidatedTasks, reason),
  ]);
  res.json({ ...out, invalidatedSections, invalidatedVisuals });
}));

/** Bulk import: RIS or BibTeX text in the request body. Every parse failure is reported, never silently dropped. */
router.post('/projects/:id/sources/import', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  const text = String(req.body?.text ?? ''); if (!text.trim()) throw new WorkflowError(400, 'validation', 'text is required (RIS or BibTeX content).');
  const parsed = detectAndParseBibliography(text);
  const created: string[] = []; const duplicates: string[] = [];
  for (const rec of parsed.records) {
    const out = await createSource(pid, req.user!.id, { doi: rec.doi, title: rec.title, authors: rec.authors, year: rec.year, venue: rec.venue, sourceType: 'unknown', metadata: { raw: rec.raw }, importProvenance: { origin: `local_import_${parsed.format}`, by: req.user!.id, at: Date.now() } });
    (out.exactDuplicateOf ? duplicates : created).push(out.source.id);
  }
  res.status(201).json({ format: parsed.format, imported: created.length, duplicatesSkipped: duplicates.length, parseFailures: parsed.failures });
}));

router.post('/projects/:id/sources/:sourceId/artifacts', upload.single('file'), wrap(async (req, res) => {
  const pid = String(req.params.id); const sourceId = String(req.params.sourceId);
  const file = (req as any).file as { originalname: string; buffer: Buffer } | undefined;
  if (!file) throw new WorkflowError(400, 'validation', 'file is required (multipart field "file").');
  const stored = await storeArtifact(pid, sourceId, file.originalname, file.buffer);
  const artifact = await recordArtifact(pid, sourceId, req.user!.id, stored.kind, stored.storagePath, stored.sha256, stored.sizeBytes);
  res.status(201).json({ artifact, extractionError: stored.extractionError ?? null, extractedChars: stored.extractedText?.length ?? 0 });
}));

router.post('/projects/:id/sources/:sourceId/screening', wrap(async (req, res) => {
  res.status(201).json({ decision: await recordScreeningDecision(String(req.params.id), String(req.params.sourceId), req.user!.id, req.body?.decision, req.body?.exclusionReason ?? null) });
}));
router.get('/projects/:id/screening', wrap(async (req, res) => { res.json({ decisions: await currentScreeningDecisions(String(req.params.id), req.user!.id) }); }));

router.get('/projects/:id/source-links', wrap(async (req, res) => { res.json({ links: await listSourceLinks(String(req.params.id), req.user!.id) }); }));
router.post('/projects/:id/source-links/:linkId/decision', wrap(async (req, res) => {
  const decision = req.body?.decision === 'confirmed' ? 'confirmed' : req.body?.decision === 'rejected' ? 'rejected' : null;
  if (!decision) throw new WorkflowError(400, 'validation', 'decision must be "confirmed" or "rejected".');
  res.json({ link: await decideSourceLink(String(req.params.linkId), String(req.params.id), req.user!.id, decision) });
}));

router.post('/projects/:id/sources/:sourceId/excerpts', wrap(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json({ excerpt: await createExcerpt(String(req.params.id), String(req.params.sourceId), req.user!.id, { locator: b.locator ?? {}, text: String(b.text ?? ''), extractedBy: 'human' }) });
}));
router.get('/projects/:id/excerpts', wrap(async (req, res) => { res.json({ excerpts: await listExcerpts(String(req.params.id), req.user!.id, req.query.sourceId ? String(req.query.sourceId) : undefined) }); }));

router.post('/projects/:id/claims', wrap(async (req, res) => { res.status(201).json({ claim: await createClaim(String(req.params.id), req.user!.id, String(req.body?.statement ?? '')) }); }));
router.get('/projects/:id/claims', wrap(async (req, res) => { res.json({ claims: await listClaims(String(req.params.id), req.user!.id) }); }));
router.post('/projects/:id/claims/:claimId/links', wrap(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json({ link: await linkClaimEvidence(String(req.params.id), req.user!.id, String(req.params.claimId), String(b.excerptId ?? ''), b.relation, b.supportStatus ?? 'unresolved') });
}));
router.get('/projects/:id/claims/:claimId/links', wrap(async (req, res) => { res.json({ links: await listClaimLinks(String(req.params.claimId), String(req.params.id), req.user!.id) }); }));

router.get('/projects/:id/evidence-matrix', wrap(async (req, res) => {
  const matrix = await latestEvidenceMatrix(String(req.params.id), req.user!.id);
  res.json({ matrix: matrix ? JSON.parse(matrix.matrix_json) : null, builtAt: matrix?.built_at ?? null });
}));

// ── M3: browser profiles (NOT project-scoped — a profile belongs to the user, reusable across projects) ──────────
// Never a credential: the row holds only provider/label/status/the profile's own on-disk directory path.
router.post('/browser-profiles', wrap(async (req, res) => { res.status(201).json({ profile: await createProfile(req.user!.id, String(req.body?.provider ?? ''), String(req.body?.label ?? '')) }); }));
router.get('/browser-profiles', wrap(async (req, res) => { res.json({ profiles: await listProfiles(req.user!.id) }); }));
router.get('/browser-profiles/:id', wrap(async (req, res) => { res.json({ profile: await getProfile(String(req.params.id), req.user!.id) }); }));
router.post('/browser-profiles/:id/connect', wrap(async (req, res) => { res.json({ profile: await beginConnect(String(req.params.id), req.user!.id) }); }));
router.post('/browser-profiles/:id/confirm', wrap(async (req, res) => { res.json({ profile: await confirmConnected(String(req.params.id), req.user!.id) }); }));
router.post('/browser-profiles/:id/disconnect', wrap(async (req, res) => { res.json({ profile: await disconnectProfile(String(req.params.id), req.user!.id) }); }));
router.post('/browser-profiles/:id/revoke', wrap(async (req, res) => { res.json({ profile: await revokeProfile(String(req.params.id), req.user!.id) }); }));

// ── M4: manuscript/thesis authoring ─────────────────────────────────────────────────────────────────────────────
router.get('/projects/:id/sections', wrap(async (req, res) => {
  const pid = String(req.params.id);
  res.json(req.query.sectionKey
    ? { versions: await listSectionVersions(pid, req.user!.id, String(req.query.sectionKey)) }
    : { current: await currentSections(pid, req.user!.id) });
}));
router.get('/projects/:id/sections/:sectionId', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  const section = await getSection(String(req.params.sectionId), pid); if (!section) throw new WorkflowError(404, 'not_found', 'Section not found.');
  res.json({ section, comments: await listComments(section.id, pid, req.user!.id), claims: await listSectionClaims(section.id, pid) });
}));
router.post('/projects/:id/sections/:sectionId/comments', wrap(async (req, res) => {
  res.status(201).json({ comment: await addComment(String(req.params.id), String(req.params.sectionId), req.user!.id, String(req.body?.body ?? '')) });
}));
router.post('/projects/:id/sections/:sectionId/claims', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  res.status(201).json({ link: await linkSectionClaim(pid, String(req.params.sectionId), String(req.body?.claimId ?? '')) });
}));
/** Accepting a proposal re-queues a citation audit for the project so the newly-current content is re-checked — plan §4's "re-run citation and numerical consistency checks after edits", using the SAME Citation Auditor, not a bespoke check. */
router.post('/projects/:id/sections/:sectionId/decision', wrap(async (req, res) => {
  const pid = String(req.params.id); const decision = req.body?.decision === 'accepted' ? 'accepted' : req.body?.decision === 'rejected' ? 'rejected' : null;
  if (!decision) throw new WorkflowError(400, 'validation', 'decision must be "accepted" or "rejected".');
  const result = await decideSection(pid, String(req.params.sectionId), req.user!.id, decision, req.body?.reason ?? null);
  let reauditTaskId: string | null = null;
  if (decision === 'accepted') { const t = await createTask(pid, { type: 'citation.audit' }); reauditTaskId = t.id; }
  res.status(201).json({ decision: result, reauditTaskId });
}));

/** Creates (and runs one tick of) an on-demand Editorial Agent task for this section — optional, never part of the mandatory planner graph. */
router.post('/projects/:id/sections/:sectionId/editorial-edit', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  const b = req.body ?? {};
  const task = await createTask(pid, { type: 'editorial.author_voice_edit', params: { sectionId: String(req.params.sectionId), editedText: b.editedText, writingSampleText: b.writingSampleText, styleNotes: b.styleNotes } });
  await tick(pid);
  res.status(201).json({ task: await getTask(task.id) });
}));

router.post('/projects/:id/guidelines', wrap(async (req, res) => {
  const pid = String(req.params.id); const b = req.body ?? {};
  res.status(201).json({ guideline: await createGuideline(pid, req.user!.id, { journalOrUniversity: b.journalOrUniversity, constraints: b.constraints, checklist: b.checklist }) });
}));
router.get('/projects/:id/guidelines', wrap(async (req, res) => { res.json({ guidelines: await listGuidelines(String(req.params.id), req.user!.id) }); }));
router.post('/projects/:id/guidelines/checklist/:itemId', wrap(async (req, res) => {
  res.json({ guideline: await confirmChecklistItem(String(req.params.id), req.user!.id, String(req.params.itemId), req.body?.confirmed !== false) });
}));
router.post('/projects/:id/compliance-report', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  await createTask(pid, { type: 'compliance.report' });
  await tick(pid);
  const saved = await latestComplianceReport(pid, req.user!.id);
  res.status(201).json({ report: saved ? JSON.parse(saved.report_json) : null, builtAt: saved?.built_at ?? null });
}));
router.get('/projects/:id/compliance-report', wrap(async (req, res) => {
  const r = await latestComplianceReport(String(req.params.id), req.user!.id);
  res.json({ report: r ? JSON.parse(r.report_json) : null, builtAt: r?.built_at ?? null });
}));

// ── M5: visuals and exports ─────────────────────────────────────────────────────────────────────────────────────
router.post('/projects/:id/visuals', wrap(async (req, res) => {
  const pid = String(req.params.id); const b = req.body ?? {};
  const visual = b.type === 'prisma_flow' ? await buildPrismaFlow(pid, req.user!.id) : await createVisual(pid, req.user!.id, { visualKey: b.visualKey, type: b.type, kind: b.kind, title: b.title, spec: b.spec ?? {} });
  res.status(201).json({ visual });
}));
router.get('/projects/:id/visuals', wrap(async (req, res) => {
  const pid = String(req.params.id);
  res.json(req.query.all === 'true' ? { visuals: await listVisuals(pid, req.user!.id) } : { visuals: await currentVisuals(pid, req.user!.id) });
}));

router.post('/projects/:id/export', wrap(async (req, res) => {
  const pid = String(req.params.id); await ownProject(pid, req.user!.id);
  const task = await createTask(pid, { type: 'export.manuscript' });
  await tick(pid);
  res.status(201).json({ task: await getTask(task.id) });
}));
router.get('/projects/:id/exports', wrap(async (req, res) => { res.json({ exports: await listExports(String(req.params.id), req.user!.id) }); }));
/** Serves the stored export's actual bytes (the same file whose hash is in the provenance manifest), never
 * regenerated on the fly, and never served without re-verifying the on-disk file still matches its recorded hash
 * (fails closed on any tampering/corruption — see export-service.ts#readVerifiedExport). */
router.get('/projects/:id/exports/:exportId/download', wrap(async (req, res) => {
  const pid = String(req.params.id); const exp = await getExport(String(req.params.exportId), pid, req.user!.id);
  if (!exp) throw new WorkflowError(404, 'not_found', 'Export not found.');
  const bytes = await readVerifiedExport(exp);
  const contentType = exp.format === 'pdf' ? 'application/pdf'
    : exp.format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : exp.format === 'provenance_manifest' ? 'application/json' : 'text/plain';
  const ext: Record<string, string> = { markdown: 'md', bibtex: 'bib', ris: 'ris', latex: 'tex', pdf: 'pdf', docx: 'docx', provenance_manifest: 'json' };
  res.setHeader('Content-Type', contentType); res.setHeader('Content-Disposition', `attachment; filename="export-${exp.format}-${exp.content_sha256.slice(0, 12)}.${ext[exp.format] ?? 'txt'}"`);
  res.send(bytes);
}));

export default router;
