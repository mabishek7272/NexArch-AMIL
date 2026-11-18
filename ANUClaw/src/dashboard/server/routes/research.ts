/**
 * Research workspace routes (plan phase 7) — mounted at /api/research.
 * Roles: admin, operator, clinician. Datasets and runs are OWNER-ONLY (404 otherwise).
 * Research output is never clinical evidence; see src/research/service.ts.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { requireDashAuth, requireRole, AuthRequest } from '../auth';
import { WorkflowError } from '../../../documents/workflow';
import { createDataset, listDatasets, runAnalysis, getRun, rerun, artifact } from '../../../research/service';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

function handle(res: Response, err: unknown): void {
  if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message, code: err.code, details: err.details }); return; }
  logger.error(`research route error: ${safeErrorSummary(err)}`);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
}
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: AuthRequest, res: Response) => { fn(req, res).catch((e) => handle(res, e)); };
const parseJsonField = (v: unknown) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } };

router.use(requireDashAuth, requireRole('admin', 'operator', 'clinician'));

router.get('/', wrap(async (_req, res) => {
  res.json({
    purpose: 'Reproducible research workspaces. Outputs are research-only and unvalidated; clinical claims are prohibited.',
    analyses: [
      { id: 'descriptive', gated: false }, { id: 'molecular_properties', gated: false, note: 'Computed properties from SMILES (engine cross-checked vs RDKit); not activity, docking or ADMET.' }, { id: 'compare_groups', gated: false }, { id: 'proportions', gated: false }, { id: 'rates', gated: false }, { id: 'standardised_rates', gated: false, note: 'Direct standardisation with researcher-supplied standard weights (Fay–Feuer interval).' },
      { id: 'prediction_evaluation', gated: true, note: 'Requires acknowledgeResearchOnly; evaluates SUPPLIED scores only; no model training.' },
      { id: 'biomarker_screen', gated: true, note: 'Exploratory; requires acknowledgeResearchOnly; replication and analytical validation are out of scope.' },
    ],
  });
}));

router.post('/datasets', upload.single('file'), wrap(async (req, res) => {
  const file = (req as any).file as { buffer: Buffer } | undefined;
  if (!file) { res.status(400).json({ error: 'multipart field "file" (CSV) is required.' }); return; }
  const b = req.body ?? {};
  res.status(201).json(await createDataset({
    userId: req.user!.id, name: b.name, purpose: b.purpose, csv: file.buffer.toString('utf8'),
    dictionary: parseJsonField(b.dictionary), attestation: parseJsonField(b.attestation),
  }));
}));

router.get('/datasets', wrap(async (req, res) => { res.json({ datasets: await listDatasets(req.user!.id) }); }));

router.post('/datasets/:id/runs', wrap(async (req, res) => {
  const b = req.body ?? {};
  res.status(201).json(await runAnalysis({ userId: req.user!.id, datasetId: String(req.params.id), analysis: b.analysis, params: b.params, plan: b.plan, acknowledgeResearchOnly: b.acknowledgeResearchOnly }));
}));

router.get('/runs/:id', wrap(async (req, res) => {
  const r = await getRun(String(req.params.id), req.user!.id);
  res.json({ id: r.run.id, analysis: r.run.analysis, status: r.run.status, errorCode: r.run.error_code, reproduced: r.run.reproduced, rerunOf: r.run.rerun_of, integrity: r.integrity, output: r.output });
}));

router.post('/runs/:id/rerun', wrap(async (req, res) => { res.status(201).json(await rerun(String(req.params.id), req.user!.id)); }));

router.get('/runs/:id/artifact.json', wrap(async (req, res) => {
  const a = await artifact(String(req.params.id), req.user!.id);
  res.setHeader('Content-Disposition', `attachment; filename="research-run-${String(req.params.id)}.json"`);
  res.json(a);
}));

export default router;
