/**
 * Versioned BaaS API /v1 (plan §13). Contract: docs/openapi-v1.json (served at
 * GET /v1/openapi.json). Tenant isolation: every resource resolves to a patient
 * whose tenant_id must equal the caller's tenant; anything else → 404.
 * The same workflow service as the dashboard is used — no parallel logic.
 * Clinical sign-off is NOT available over the API (dashboard, provisioned
 * clinician only). POSTs honour an Idempotency-Key header.
 */
import { Router, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { buildOpenApiV1 } from '../openapi-v1';
import multer from 'multer';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perTenantRateLimit, quotaCheck } from '../middleware/rate-limit';
import { usageMeter } from '../middleware/usage-meter';
import { db } from '../../db';
import { logger } from '../../logger';
import { safeErrorSummary } from '../../security/redact';
import {
  WorkflowError, ingestDocument, documentReview, decideCandidate, correctObservation, createSnapshot,
  runSnapshotRules, createReport, getReport, exportReportHtml, exportReportPdf,
} from '../../documents/workflow';
import { retrieveReferences } from '../../ai/reference-corpus';
import { runRules, RULE_ENGINE_VERSION } from '../../documents/rules';
import { modelRoles } from '../../ai/openrouter';
import { SPECIALTIES } from '../../specialties/registry';
import { isUtcDay, pgReport } from '../../ai/spend';
import { alphaFold } from '../../sciencedata/alphafold-service';
import { science, Scope as SciScope } from '../../sciencedata/service';
import { PROVIDER_IDS, ProviderId } from '../../sciencedata/types';
import { listInterpretationRoutes } from '../../interpretation/jobs/routes';

export const V1_VERSION = '1.0.0';
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const guards = [requireAuth, perTenantRateLimit, quotaCheck, usageMeter];

type Resolver = (req: AuthRequest) => Promise<string | null>;
const viaPatient = (sql: string, param: string): Resolver => async (req) =>
  (await db.queryOne<{ patient_id: string }>(sql, [String(req.params[param])]))?.patient_id ?? null;
const R = {
  patient: (async (req) => String(req.params.patientId)) as Resolver,
  document: viaPatient('SELECT patient_id FROM documents WHERE id = $1', 'documentId'),
  candidate: viaPatient('SELECT d.patient_id FROM observation_candidates c JOIN documents d ON d.id = c.document_id WHERE c.id = $1', 'candidateId'),
  observation: viaPatient('SELECT patient_id FROM observations WHERE id = $1', 'observationId'),
  snapshot: viaPatient('SELECT patient_id FROM case_snapshots WHERE id = $1', 'snapshotId'),
  report: viaPatient('SELECT patient_id FROM reports WHERE id = $1', 'reportId'),
};

/** Resource must belong to a patient owned by the caller's tenant. */
function owned(resolve: Resolver) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const pid = await resolve(req);
      const ok = pid && (await db.queryOne('SELECT 1 FROM patients WHERE id = $1 AND tenant_id = $2', [pid, req.tenant!.tenant_id]));
      if (!ok) { res.status(404).json(err('not_found', 'Resource not found.')); return; }
      next();
    } catch (e) { fail(res, e); }
  };
}

const actor = (req: AuthRequest) => `tenant:${req.tenant!.tenant_id}`;
const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details ? { details } : {}) } });

function fail(res: Response, e: unknown): void {
  if (e instanceof WorkflowError) { res.status(e.status).json(err(e.code, e.message, e.details)); return; }
  logger.error(`v1 error: ${safeErrorSummary(e)}`);
  if (!res.headersSent) res.status(500).json(err('internal', 'Internal error.'));
}

/** Idempotency-Key support for POST: same key + route replays the stored response. */
function idempotent(handler: (req: AuthRequest) => Promise<{ status: number; body: unknown }>) {
  return async (req: AuthRequest, res: Response) => {
    try {
      const key = req.header('idempotency-key');
      const route = `${req.method} ${req.baseUrl}${req.path}`;
      if (key !== undefined) {
        if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) { res.status(400).json(err('bad_idempotency_key', 'Idempotency-Key must be 8–200 safe characters.')); return; }
        const prior = await db.queryOne<any>('SELECT route, status, body_json FROM idempotency_keys WHERE tenant_id = $1 AND key = $2', [req.tenant!.tenant_id, key]);
        if (prior) {
          if (prior.route !== route) { res.status(422).json(err('idempotency_key_reused', 'This Idempotency-Key was used for a different request.')); return; }
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(prior.status).json(JSON.parse(prior.body_json));
          return;
        }
      }
      const out = await handler(req);
      if (key !== undefined && out.status < 500) {
        await db.query(`INSERT INTO idempotency_keys (tenant_id, key, route, status, body_json, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [req.tenant!.tenant_id, key, route, out.status, JSON.stringify(out.body), Date.now()]);
      }
      res.status(out.status).json(out.body);
    } catch (e) { fail(res, e); }
  };
}

const get = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: AuthRequest, res: Response) => { fn(req, res).catch((e) => fail(res, e)); };

// ── Contract & capabilities ───────────────────────────────────────────────────
router.get('/v1/openapi.json', (_req, res) => { res.json(buildOpenApiV1()); });

router.get('/v1/engines', ...guards, get(async (_req, res) => {
  const rules = runRules([]);
  res.json({
    version: V1_VERSION,
    engines: [{ id: 'rules', version: RULE_ENGINE_VERSION, rules: rules.rules, clinicalState: rules.clinicalState, validation: 'software-tested; no clinical rules released' }],
    models: { roles: modelRoles(), note: 'Model roles are configurable; availability is recorded in docs/INTEGRATION-STATUS.md.' },
    signOff: { available: false, reason: 'Clinical sign-off is restricted to provisioned clinicians in the dashboard.' },
  });
}));

router.get('/v1/spend', ...guards, get(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(req.query.from ?? today), to = String(req.query.to ?? today);
  if (!isUtcDay(from) || !isUtcDay(to) || from > to) { res.status(400).json(err('validation', 'from/to must be YYYY-MM-DD (UTC days).')); return; }
  // Always the caller's own tenant scope — never another tenant's or the global ledger.
  res.json(await pgReport({ fromPeriod: from, toPeriod: to, scope: { kind: 'tenant', id: req.tenant!.tenant_id } }));
}));

router.get('/v1/specialties', ...guards, get(async (_req, res) => {
  res.json({ version: V1_VERSION, note: 'No module is approved for clinical use in this build.', modules: SPECIALTIES });
}));

// ── Patients (tenant-owned subjects) ─────────────────────────────────────────
router.post('/v1/patients', ...guards, idempotent(async (req) => {
  const { external_ref, display_name } = req.body ?? {};
  if (typeof display_name !== 'string' || !display_name.trim() || display_name.length > 200) return { status: 400, body: err('validation', 'display_name is required (≤ 200 chars).') };
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.query(`INSERT INTO patients (id, uid, name, created_at, updated_at, created_by, tenant_id) VALUES ($1,$2,$3,$4,$4,$5,$6)`,
    [id, `T-${crypto.randomUUID()}`, display_name.trim(), now, actor(req), req.tenant!.tenant_id]);
  return { status: 201, body: { id, external_ref: typeof external_ref === 'string' ? external_ref.slice(0, 200) : null, created_at: now } };
}));

router.get('/v1/patients/:patientId/documents', ...guards, owned(R.patient), get(async (req, res) => {
  res.json({ documents: await db.query('SELECT id, media_type, page_count, status, purpose, created_at FROM documents WHERE patient_id = $1 ORDER BY created_at DESC', [String(req.params.patientId)]) });
}));

router.get('/v1/patients/:patientId/observations', ...guards, owned(R.patient), get(async (req, res) => {
  res.json({ observations: await db.query('SELECT * FROM observations WHERE patient_id = $1 ORDER BY created_at', [String(req.params.patientId)]) });
}));

// ── Documents ─────────────────────────────────────────────────────────────────
router.post('/v1/patients/:patientId/documents', ...guards, owned(R.patient), upload.single('file'), idempotent(async (req) => {
  const file = (req as any).file as { buffer: Buffer } | undefined;
  if (!file) return { status: 400, body: err('validation', 'multipart field "file" is required.') };
  const out = await ingestDocument({ patientId: String(req.params.patientId), userId: actor(req), buffer: file.buffer, purpose: String(req.body?.purpose ?? '') });
  return out.duplicate ? { status: 409, body: err('duplicate', 'Document already uploaded for this patient.', { documentId: out.documentId }) } : { status: 201, body: out };
}));

router.get('/v1/documents/:documentId', ...guards, owned(R.document), get(async (req, res) => { res.json(await documentReview(String(req.params.documentId))); }));

router.post('/v1/candidates/:candidateId/decision', ...guards, owned(R.candidate), idempotent(async (req) => {
  const { action, correction, reason } = req.body ?? {};
  if (!['confirm', 'reject', 'correct'].includes(action)) return { status: 400, body: err('validation', 'action must be confirm, reject or correct.') };
  return { status: 200, body: await decideCandidate({ candidateId: String(req.params.candidateId), userId: actor(req), action, correction, reason }) };
}));

router.post('/v1/observations/:observationId/correction', ...guards, owned(R.observation), idempotent(async (req) => {
  const { correction, reason } = req.body ?? {};
  return { status: 200, body: await correctObservation({ observationId: String(req.params.observationId), userId: actor(req), correction: correction ?? {}, reason }) };
}));

// ── Cases: snapshots, analyses (rule runs = server-owned execution records) ────
router.post('/v1/documents/:documentId/snapshots', ...guards, owned(R.document), idempotent(async (req) => ({
  status: 201, body: await createSnapshot({ documentId: String(req.params.documentId), userId: actor(req) }),
})));

router.post('/v1/snapshots/:snapshotId/analyses', ...guards, owned(R.snapshot), idempotent(async (req) => ({
  status: 201, body: await runSnapshotRules({ snapshotId: String(req.params.snapshotId), userId: actor(req) }),
})));

router.get('/v1/jobs/:jobId', ...guards, get(async (req, res) => {
  const r = await db.queryOne<any>(
    `SELECT e.id, e.status, e.engine, e.engine_version, e.output_sha256, e.created_at, s.patient_id
       FROM engine_runs e JOIN case_snapshots s ON s.id = e.snapshot_id WHERE e.id = $1`, [String(req.params.jobId)]);
  const ok = r && (await db.queryOne('SELECT 1 FROM patients WHERE id = $1 AND tenant_id = $2', [r.patient_id, req.tenant!.tenant_id]));
  if (!ok) { res.status(404).json(err('not_found', 'Resource not found.')); return; }
  res.json({ id: r.id, kind: 'analysis', status: r.status, engine: r.engine, engine_version: r.engine_version, output_sha256: r.output_sha256, created_at: r.created_at });
}));

// ── Reports ──────────────────────────────────────────────────────────────────
router.post('/v1/snapshots/:snapshotId/reports', ...guards, owned(R.snapshot), idempotent(async (req) => {
  const engineRunId = req.body?.analysis_id;
  if (typeof engineRunId !== 'string') return { status: 400, body: err('validation', 'analysis_id (a server-issued analysis for this snapshot) is required.') };
  return { status: 201, body: await createReport({ snapshotId: String(req.params.snapshotId), engineRunId, userId: actor(req) }) };
}));

router.get('/v1/reports/:reportId', ...guards, owned(R.report), get(async (req, res) => {
  const { row, structured } = await getReport(String(req.params.reportId));
  res.json({ id: row.id, version: row.version, status: row.status, reviewed_at: row.reviewed_at, report: structured });
}));

router.post('/v1/reports/:reportId/review', ...guards, owned(R.report), (_req: AuthRequest, res: Response) => {
  res.status(403).json(err('sign_off_not_available', 'Clinical sign-off is restricted to provisioned clinicians in the dashboard.'));
});

router.get('/v1/reports/:reportId/export.html', ...guards, owned(R.report), get(async (req, res) => {
  const out = await exportReportHtml(String(req.params.reportId));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-SHA256', out.sha256);
  res.setHeader('X-Report-Status', out.status);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.send(out.html);
}));

router.get('/v1/reports/:reportId/export.pdf', ...guards, owned(R.report), get(async (req, res) => {
  const out = await exportReportPdf(String(req.params.reportId));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Content-SHA256', out.sha256);
  res.setHeader('X-Report-Status', out.status);
  res.send(out.pdf);
}));

// ── Evidence (approved reference corpus; global + caller's tenant) ───────────
router.get('/v1/evidence/search', ...guards, get(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q || q.length > 1000) { res.status(400).json(err('validation', 'q is required (≤ 1000 chars).')); return; }
  res.json(await retrieveReferences({ tenantId: req.tenant!.tenant_id, query: q, k: Number(req.query.k ?? 5) }));
}));

// ── Public scientific data (research-only; tenant-scoped searches, retrievals, workspaces) ──────────────────
const sciScope = (req: AuthRequest): SciScope => ({ kind: 'tenant', id: req.tenant!.tenant_id });
const sciProvider = (v: unknown): ProviderId => { if (!PROVIDER_IDS.includes(v as ProviderId)) throw new WorkflowError(400, 'bad_provider', `provider must be one of ${PROVIDER_IDS.join(', ')}.`); return v as ProviderId; };
router.post('/v1/science/alphafold/lookup', ...guards, get(async (req,res) => { const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); }); res.json(await alphaFold().lookup(sciScope(req),actor(req),req.body?.operation,req.body?.value,req.body?.refresh === true,controller.signal)); }));
router.get('/v1/science/alphafold/lookups/:id', ...guards, get(async (req,res) => { res.json(await alphaFold().getLookup(sciScope(req),String(req.params.id))); }));
router.post('/v1/science/alphafold/import', ...guards, get(async (req,res) => { const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); }); res.status(201).json(await alphaFold().importFile(sciScope(req),actor(req),req.body ?? {},controller.signal)); }));
router.get('/v1/science/alphafold/imports/:id', ...guards, get(async (req,res) => { res.json(await alphaFold().getImport(sciScope(req),String(req.params.id))); }));
router.get('/v1/science', ...guards, get(async (_req, res) => { res.json(science().catalog()); }));
router.post('/v1/science/search', ...guards, get(async (req, res) => { res.json(await science().search(sciScope(req), sciProvider(req.body?.provider), req.body?.query)); }));
router.post('/v1/science/describe', ...guards, get(async (req, res) => { res.json(await science().describe(sciScope(req), sciProvider(req.body?.provider), req.body?.accession)); }));
router.post('/v1/science/retrieve', ...guards, get(async (req, res) => { res.status(201).json(await science().retrieve(sciScope(req), sciProvider(req.body?.provider), req.body?.accession, req.body?.files, { refresh: req.body?.refresh === true })); }));
router.get('/v1/science/sources/:sourceId', ...guards, get(async (req, res) => { res.json(await science().getSource(sciScope(req), String(req.params.sourceId))); }));
router.get('/v1/science/sources/:sourceId/content', ...guards, get(async (req, res) => {
  const { bytes, source } = await science().readContent(sciScope(req), String(req.params.sourceId));
  res.set({ 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': source.sha256, 'X-Research-Only': 'true', 'X-Source-Classification': source.classification, 'X-Content-Type-Options': 'nosniff' }); res.send(bytes);
}));
router.post('/v1/science/workspaces', ...guards, get(async (req, res) => { res.status(201).json(await science().createWorkspace(sciScope(req), req.body?.name, req.body?.purpose)); }));
router.get('/v1/science/workspaces', ...guards, get(async (req, res) => { res.json({ workspaces: await science().listWorkspaces(sciScope(req)) }); }));
router.get('/v1/science/workspaces/:workspaceId', ...guards, get(async (req, res) => { res.json(await science().getWorkspace(sciScope(req), String(req.params.workspaceId))); }));
router.post('/v1/science/workspaces/:workspaceId/items', ...guards, get(async (req, res) => { res.status(201).json(await science().attach(sciScope(req), String(req.params.workspaceId), String(req.body?.sourceId ?? ''), req.body?.label, actor(req))); }));
router.get('/v1/science/workspaces/:workspaceId/manifest', ...guards, get(async (req, res) => { res.json(await science().manifest(sciScope(req), String(req.params.workspaceId))); }));

export function listV1Routes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of (router as any).stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path });
  }
  // Interpretation routes live in their own router; the one OpenAPI contract covers both.
  return [...out, ...listInterpretationRoutes()];
}

export default router;
