/**
 * Document workflow routes (plan §7, first milestone). Mounted at /api/clinical.
 * Every route resolves the owning patient and enforces role + per-patient grant
 * (see ../patient-access.ts); missing access answers 404.
 */
import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireDashAuth, requireRole } from '../auth';
import { requireActiveClinician, hasActiveClinicianCredential } from '../clinicians';
import { reviewEngineRun, getModelReview } from '../../../ai/engine-review-service';
import * as mon from '../../../monitoring/service';
import { isUtcDay, pgReport } from '../../../ai/spend';
import { SPECIALTIES } from '../../../specialties/registry';
import { linkSubject, importFromUpstream, importSignedBundle, importUnverifiedPayload, postureSummary } from '../../../integrations/posturepulse/service';
import { addReferenceDocument, approveReferenceDocument, indexReferenceDocument, retrieveReferences } from '../../../ai/reference-corpus';
import { db } from '../../../db';
import { AccessLevel, getGrantedLevel, levelSatisfies, roleAllows, PatientAccessRequest } from '../patient-access';
import {
  WorkflowError, ingestDocument, documentReview, decideCandidate, correctObservation, createSnapshot,
  runSnapshotRules, createReport, getReport, reviewReport, exportReportHtml, exportReportPdf,
} from '../../../documents/workflow';
import { paddleServiceEngine } from '../../../documents/ocr';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

type Resolver = (req: PatientAccessRequest) => Promise<string | null>;
const byParam = (sql: string, param: string): Resolver => async (req) =>
  (await db.queryOne<{ patient_id: string }>(sql, [String(req.params[param])]))?.patient_id ?? null;

const R = {
  patient: (async (req) => String(req.params.id)) as Resolver,
  document: byParam('SELECT patient_id FROM documents WHERE id = $1', 'docId'),
  candidate: byParam('SELECT d.patient_id FROM observation_candidates c JOIN documents d ON d.id = c.document_id WHERE c.id = $1', 'candId'),
  observation: byParam('SELECT patient_id FROM observations WHERE id = $1', 'obsId'),
  snapshot: byParam('SELECT patient_id FROM case_snapshots WHERE id = $1', 'snapId'),
  report: byParam('SELECT patient_id FROM reports WHERE id = $1', 'reportId'),
  device: byParam('SELECT patient_id FROM monitoring_devices WHERE id = $1', 'deviceId'),
  alert: byParam('SELECT d.patient_id FROM monitoring_alerts a JOIN monitoring_devices d ON d.id = a.device_id WHERE a.id = $1', 'alertId'),
};

function access(level: AccessLevel, resolve: Resolver) {
  return async (req: PatientAccessRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roleAllows(req.user.role, level)) { res.status(403).json({ error: 'Your role does not permit this operation.' }); return; }
    try {
      const patientId = await resolve(req);
      if (!patientId || !levelSatisfies(await getGrantedLevel(req.user.id, patientId), level)) { res.status(404).json({ error: 'Not found' }); return; }
      (req as any).patientId = patientId;
      next();
    } catch (err) { handle(res, err); }
  };
}

function handle(res: Response, err: unknown): void {
  if (err instanceof WorkflowError) { res.status(err.status).json({ error: err.message, code: err.code, details: err.details }); return; }
  logger.error(`documents route error: ${safeErrorSummary(err)}`);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
}

const wrap = (fn: (req: PatientAccessRequest, res: Response) => Promise<void>) =>
  (req: PatientAccessRequest, res: Response) => { fn(req, res).catch((e) => handle(res, e)); };

router.use(requireDashAuth);

router.post('/patients/:id/documents', access('write', R.patient), upload.single('file'), wrap(async (req, res) => {
  const file = (req as any).file as { buffer: Buffer } | undefined;
  if (!file) { res.status(400).json({ error: 'file is required (multipart field "file").' }); return; }
  const ocr = process.env.OCR_SERVICE_URL || process.env.ANUCLAW_OCR_ENABLED === 'true' ? paddleServiceEngine() : undefined;
  const out = await ingestDocument({ patientId: String(req.params.id), userId: req.user!.id, buffer: file.buffer, purpose: String(req.body?.purpose ?? ''), ocr });
  res.status(out.duplicate ? 409 : 201).json(out.duplicate ? { error: 'This document was already uploaded for this patient.', documentId: out.documentId } : out);
}));

router.get('/patients/:id/documents', access('read', R.patient), wrap(async (req, res) => {
  const docs = await db.query('SELECT id, media_type, page_count, status, purpose, created_at FROM documents WHERE patient_id = $1 ORDER BY created_at DESC', [String(req.params.id)]);
  res.json({ documents: docs });
}));

// ── Physiological monitoring (plan §9.2): staff-entered/gateway data and a labelled simulator ──
router.get('/monitoring/alert-policy', wrap(async (_req, res) => { res.json(mon.ALERT_GATE); }));

router.post('/patients/:id/monitoring/devices', access('write', R.patient), wrap(async (req, res) => {
  res.status(201).json(await mon.pairDevice({ patientId: String(req.params.id), userId: req.user!.id, kind: req.body?.kind, label: req.body?.label, purpose: req.body?.purpose }));
}));
router.get('/patients/:id/monitoring/devices', access('read', R.patient), wrap(async (req, res) => { res.json({ devices: await mon.listDevices(String(req.params.id)) }); }));

router.post('/monitoring/devices/:deviceId/unpair', access('write', R.device), wrap(async (req, res) => { res.json(await mon.unpairDevice(String(req.params.deviceId))); }));
router.post('/monitoring/devices/:deviceId/observations', access('write', R.device), wrap(async (req, res) => {
  res.status(201).json(await mon.ingest({ deviceId: String(req.params.deviceId), userId: req.user!.id, observations: req.body?.observations, fhir: req.body?.fhir }));
}));
router.post('/monitoring/devices/:deviceId/simulate', access('write', R.device), wrap(async (req, res) => {
  res.status(201).json(await mon.simulateInto({ deviceId: String(req.params.deviceId), userId: req.user!.id, options: req.body ?? {} }));
}));
router.get('/monitoring/devices/:deviceId/status', access('read', R.device), wrap(async (req, res) => { res.json(await mon.status(String(req.params.deviceId))); }));
router.get('/monitoring/devices/:deviceId/observations', access('read', R.device), wrap(async (req, res) => { res.json({ observations: await mon.history(String(req.params.deviceId), Number(req.query.limit ?? 100)) }); }));

router.post('/monitoring/devices/:deviceId/alerts', access('write', R.device), wrap(async (req, res) => { res.status(201).json(await mon.openSimulationAlert(String(req.params.deviceId))); }));
router.get('/monitoring/devices/:deviceId/alerts', access('read', R.device), wrap(async (req, res) => { res.json({ alerts: await mon.listAlerts(String(req.params.deviceId)), gate: mon.ALERT_GATE }); }));
router.post('/monitoring/alerts/:alertId/acknowledge', access('write', R.alert), wrap(async (req, res) => { res.json(await mon.acknowledgeAlert(String(req.params.alertId), req.user!.email)); }));
router.post('/monitoring/alerts/:alertId/close', access('write', R.alert), wrap(async (req, res) => { res.json(await mon.closeAlert(String(req.params.alertId), req.user!.email)); }));

router.get('/spend', requireRole('admin', 'auditor', 'compliance'), wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = String(req.query.from ?? today), to = String(req.query.to ?? today);
  if (!isUtcDay(from) || !isUtcDay(to) || from > to) { res.status(400).json({ error: 'from/to must be YYYY-MM-DD (UTC days).' }); return; }
  const scope = req.query.scope_kind && req.query.scope_id ? { kind: String(req.query.scope_kind) as 'user' | 'tenant' | 'system', id: String(req.query.scope_id) } : undefined;
  if (scope && !['user', 'tenant', 'system'].includes(scope.kind)) { res.status(400).json({ error: 'scope_kind must be user, tenant or system.' }); return; }
  res.json(await pgReport({ fromPeriod: from, toPeriod: to, scope }));
}));

router.get('/specialties', wrap(async (_req, res) => {
  res.json({ note: 'No module is approved for clinical use in this build; see each entry for what is implemented and what external approval is required.', modules: SPECIALTIES });
}));

router.get('/patients/:id/reports', access('read', R.patient), wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT r.id, r.version, r.status, r.created_at, r.reviewed_at, r.snapshot_id, s.document_id, s.superseded_at
       FROM reports r JOIN case_snapshots s ON s.id = r.snapshot_id WHERE r.patient_id = $1 ORDER BY r.created_at DESC`, [String(req.params.id)]);
  res.json({ reports: rows });
}));

router.get('/documents/:docId', access('read', R.document), wrap(async (req, res) => {
  res.json(await documentReview(String(req.params.docId)));
}));

router.post('/candidates/:candId/decision', access('write', R.candidate), wrap(async (req, res) => {
  const { action, correction, reason } = req.body ?? {};
  if (!['confirm', 'reject', 'correct'].includes(action)) { res.status(400).json({ error: 'action must be confirm, reject or correct.' }); return; }
  res.json(await decideCandidate({ candidateId: String(req.params.candId), userId: req.user!.id, action, correction, reason }));
}));

router.post('/observations/:obsId/correct', access('write', R.observation), wrap(async (req, res) => {
  const { correction, reason } = req.body ?? {};
  res.json(await correctObservation({ observationId: String(req.params.obsId), userId: req.user!.id, correction: correction ?? {}, reason }));
}));

router.post('/documents/:docId/snapshots', access('write', R.document), wrap(async (req, res) => {
  res.status(201).json(await createSnapshot({ documentId: String(req.params.docId), userId: req.user!.id }));
}));

router.post('/snapshots/:snapId/rule-runs', access('write', R.snapshot), wrap(async (req, res) => {
  res.status(201).json(await runSnapshotRules({ snapshotId: String(req.params.snapId), userId: req.user!.id }));
}));

router.post('/snapshots/:snapId/reports', access('write', R.snapshot), wrap(async (req, res) => {
  const engineRunId = req.body?.engineRunId;
  if (typeof engineRunId !== 'string') { res.status(400).json({ error: 'engineRunId is required (a server-issued rule run for this snapshot).' }); return; }
  res.status(201).json(await createReport({ snapshotId: String(req.params.snapId), engineRunId, userId: req.user!.id }));
}));

// AI review over a VERIFIED stored engine run (Decision 1 → Gemma). Assistive only.
router.post('/snapshots/:snapId/engine-runs/:runId/model-review', requireRole('admin', 'operator', 'clinician'), access('write', R.snapshot), wrap(async (req, res) => {
  const out = await reviewEngineRun({ snapshotId: String(req.params.snapId), engineRunId: String(req.params.runId), userId: req.user!.id });
  res.status(out.status === 'completed' ? 201 : 502).json({ ...out, label: 'AI-assisted review — model output, not clinical approval' });
}));

router.get('/model-reviews/:reviewId', wrap(async (req, res) => {
  const r = await getModelReview(String(req.params.reviewId));
  const patient = await db.queryOne<{ patient_id: string }>('SELECT patient_id FROM case_snapshots WHERE id = $1', [r.snapshot_id]);
  if (!patient || !roleAllows(req.user!.role, 'read') || !levelSatisfies(await getGrantedLevel(req.user!.id, patient.patient_id), 'read')) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...r, checks: r.checks_json ? JSON.parse(r.checks_json) : null, review: r.review_json ? JSON.parse(r.review_json) : null, problems: JSON.parse(r.problems_json) });
}));

// Reference corpus (separate from patient data). Drafts by admin; approval by a provisioned clinician.
router.post('/references', requireRole('admin'), wrap(async (req, res) => {
  res.status(201).json(await addReferenceDocument({ tenantId: null, meta: req.body?.meta, sections: req.body?.sections, userId: req.user!.id }));
}));
router.post('/references/:refId/approve', requireActiveClinician, wrap(async (req, res) => {
  res.json(await approveReferenceDocument({ documentId: String(req.params.refId), approverId: req.user!.id }));
}));
router.post('/references/:refId/index', requireRole('admin'), wrap(async (req, res) => {
  res.json(await indexReferenceDocument(String(req.params.refId)));
}));
router.get('/references/search', requireRole('admin', 'operator', 'clinician'), wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q || q.length > 1000) { res.status(400).json({ error: 'q is required (≤ 1000 chars).' }); return; }
  res.json(await retrieveReferences({ tenantId: null, query: q, k: Number(req.query.k ?? 5) }));
}));

// ── PosturePulse (plan §9.1) ───────────────────────────────────────────────────
router.post('/patients/:id/posture/links', requireRole('admin'), wrap(async (req, res) => {
  const { subjectPseudoId, consentRecordId, purpose } = req.body ?? {};
  const exists = await db.queryOne('SELECT 1 FROM patients WHERE id = $1', [String(req.params.id)]);
  if (!exists) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(201).json(await linkSubject({ patientId: String(req.params.id), subjectPseudoId, consentRecordId, purpose, userId: req.user!.id }));
}));

// Verified path (a): fetched from the CONFIGURED upstream (no URL accepted from the request).
router.post('/patients/:id/posture/import', access('write', R.patient), wrap(async (req, res) => {
  const { sessionId, reportAccessToken, clinicianToken } = req.body ?? {};
  if (typeof sessionId !== 'string' || typeof reportAccessToken !== 'string' || typeof clinicianToken !== 'string') {
    res.status(400).json({ error: 'sessionId, reportAccessToken and clinicianToken (upstream credentials) are required.' }); return;
  }
  res.status(201).json(await importFromUpstream({ patientId: String(req.params.id), userId: req.user!.id, sessionId, reportAccessToken, clinicianToken }));
}));

// Verified path (b): signed bundle (HMAC with ANUCLAW_POSTUREPULSE_IMPORT_SECRET).
router.post('/patients/:id/posture/import-signed', access('write', R.patient), wrap(async (req, res) => {
  res.status(201).json(await importSignedBundle({ patientId: String(req.params.id), userId: req.user!.id, bundle: req.body?.bundle }));
}));

// Unverified payloads: stored + labelled; never part of the released clinical record.
router.post('/patients/:id/posture/import-unverified', requireRole('admin', 'operator'), access('write', R.patient), wrap(async (req, res) => {
  const b = req.body ?? {};
  const out = await importUnverifiedPayload({ patientId: String(req.params.id), userId: req.user!.id, consentRecord: b.consentRecord, session: b.session, report: b.report, symptomReports: b.symptomReports });
  res.status(201).json({ ...out, label: 'UNVERIFIED payload — not a verified clinical release.' });
}));

router.get('/patients/:id/posture', access('read', R.patient), wrap(async (req, res) => {
  res.json({ reports: await postureSummary(String(req.params.id), { includeUnverified: req.query.include_unverified === 'true' }) });
}));

router.get('/reports/:reportId', access('read', R.report), wrap(async (req, res) => {
  const { row, structured } = await getReport(String(req.params.reportId));
  res.json({ id: row.id, version: row.version, status: row.status, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, report: structured });
}));

// Clinical sign-off: ONLY a provisioned licensed clinician with a write grant on the
// patient. Admin/operator accounts cannot sign off (separation of duties).
router.post('/reports/:reportId/review', requireActiveClinician, access('write', R.report), wrap(async (req, res) => {
  res.status(201).json(await reviewReport({ reportId: String(req.params.reportId), reviewerId: req.user!.id }));
}));

router.get('/reports/:reportId/export.html', access('read', R.report), wrap(async (req, res) => {
  const out = await exportReportHtml(String(req.params.reportId));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-SHA256', out.sha256);
  res.setHeader('X-Report-Status', out.status);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.html);
}));

router.get('/reports/:reportId/export.pdf', access('read', R.report), wrap(async (req, res) => {
  const out = await exportReportPdf(String(req.params.reportId));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="report-${String(req.params.reportId)}.pdf"`);
  res.setHeader('X-Content-SHA256', out.sha256);
  res.setHeader('X-Report-Status', out.status);
  res.setHeader('Cache-Control', 'no-store');
  res.send(out.pdf);
}));

export default router;
