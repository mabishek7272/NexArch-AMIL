/**
 * Public scientific data (research-only) — mounted at /api/science. Roles: admin, operator, clinician.
 * Scope = the signed-in user: searches, retrievals, workspaces and attachments are private to them (404 otherwise).
 */
import { Router, Response } from 'express';
import { requireDashAuth, requireRole, AuthRequest } from '../auth';
import { WorkflowError } from '../../../documents/workflow';
import { science, Scope } from '../../../sciencedata/service';
import { PROVIDER_IDS, ProviderId } from '../../../sciencedata/types';
import { alphaFold } from '../../../sciencedata/alphafold-service';
import { AFOperation } from '../../../sciencedata/alphafold';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';

const router = Router();
function handle(res: Response, err: unknown): void {
  if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message, code: err.code, details: err.details }); return; }
  logger.error(`science route error: ${safeErrorSummary(err)}`);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
}
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: AuthRequest, res: Response) => { fn(req, res).catch((e) => handle(res, e)); };
const scopeOf = (req: AuthRequest): Scope => ({ kind: 'user', id: req.user!.id });
const provider = (v: unknown): ProviderId => { if (!PROVIDER_IDS.includes(v as ProviderId)) throw new WorkflowError(400, 'bad_provider', `provider must be one of ${PROVIDER_IDS.join(', ')}.`); return v as ProviderId; };

router.use(requireDashAuth, requireRole('admin', 'operator', 'clinician'));

// Cancel provider I/O when the response socket disappears. Normal completed requests do not abort.
function cancellation(req: AuthRequest, res: Response): AbortSignal {
  const controller = new AbortController(); req.once('aborted', () => controller.abort());
  res.once('close', () => { if (!res.writableEnded) controller.abort(); }); return controller.signal;
}
router.post('/alphafold/lookup', wrap(async (req,res) => { res.json(await alphaFold().lookup(scopeOf(req),req.user!.id,req.body?.operation as AFOperation,req.body?.value,req.body?.refresh === true,cancellation(req,res))); }));
router.get('/alphafold/lookups/:id', wrap(async (req,res) => { res.json(await alphaFold().getLookup(scopeOf(req),String(req.params.id))); }));
router.post('/alphafold/import', wrap(async (req,res) => { res.status(201).json(await alphaFold().importFile(scopeOf(req),req.user!.id,req.body ?? {},cancellation(req,res))); }));
router.get('/alphafold/imports/:id', wrap(async (req,res) => { res.json(await alphaFold().getImport(scopeOf(req),String(req.params.id))); }));
router.post('/alphafold/projects/:id/attachments', wrap(async (req,res) => { res.status(201).json(await alphaFold().attach(scopeOf(req),req.user!.id,String(req.params.id),String(req.body?.importId ?? ''),req.body?.replaces)); }));
router.get('/alphafold/projects/:id/attachments', wrap(async (req,res) => { res.json({ attachments: await alphaFold().attachments(req.user!.id,String(req.params.id)) }); }));
router.post('/alphafold/projects/:id/receptors', wrap(async (req,res) => { res.status(201).json(await alphaFold().handoff(scopeOf(req),req.user!.id,String(req.params.id),req.body ?? {})); }));
router.get('/alphafold/projects/:id/receptors/:receptorId', wrap(async (req,res) => { res.json(await alphaFold().getHandoff(req.user!.id,String(req.params.id),String(req.params.receptorId))); }));

router.get('/', wrap(async (_req, res) => { res.json(science().catalog()); }));
router.post('/search', wrap(async (req, res) => { res.json(await science().search(scopeOf(req), provider(req.body?.provider), req.body?.query)); }));
router.post('/describe', wrap(async (req, res) => { res.json(await science().describe(scopeOf(req), provider(req.body?.provider), req.body?.accession)); }));
router.post('/retrieve', wrap(async (req, res) => { res.status(201).json(await science().retrieve(scopeOf(req), provider(req.body?.provider), req.body?.accession, req.body?.files, { refresh: req.body?.refresh === true })); }));
router.get('/sources/:id', wrap(async (req, res) => { res.json(await science().getSource(scopeOf(req), String(req.params.id))); }));
router.get('/sources/:id/content', wrap(async (req, res) => {
  const { bytes, source } = await science().readContent(scopeOf(req), String(req.params.id));
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="source.bin"', 'X-Content-SHA256': source.sha256, 'X-Research-Only': 'true', 'X-Source-Classification': source.classification, 'X-Content-Type-Options': 'nosniff' });
  res.send(bytes);
}));
router.post('/workspaces', wrap(async (req, res) => { res.status(201).json(await science().createWorkspace(scopeOf(req), req.body?.name, req.body?.purpose)); }));
router.get('/workspaces', wrap(async (req, res) => { res.json({ workspaces: await science().listWorkspaces(scopeOf(req)) }); }));
router.get('/workspaces/:id', wrap(async (req, res) => { res.json(await science().getWorkspace(scopeOf(req), String(req.params.id))); }));
router.post('/workspaces/:id/items', wrap(async (req, res) => { res.status(201).json(await science().attach(scopeOf(req), String(req.params.id), String(req.body?.sourceId ?? ''), req.body?.label, req.user!.id)); }));
router.get('/workspaces/:id/manifest', wrap(async (req, res) => {
  const m = await science().manifest(scopeOf(req), String(req.params.id));
  res.set({ 'Content-Disposition': 'attachment; filename="science-manifest.json"', 'X-Manifest-SHA256': m.manifestSha256 }); res.json(m);
}));

export default router;
