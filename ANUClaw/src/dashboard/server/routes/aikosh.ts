/**
 * AIKosh data registry — mounted at /api/aikosh. LOCAL GOVERNANCE ONLY: it records inventory, human-recorded provenance/licence/permitted-use approvals and second-person
 * decisions. It never reads dataset contents, calls no provider and approves nothing by itself. Identity and role come from the verified dashboard session.
 */
import { Router, Request, Response } from 'express';
import { requireDashAuth, requireRole, AuthRequest } from '../auth';
import { db } from '../../../db';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';
import { loadInventory, registryView } from '../../../aikosh/inventory';
import { APPROVER_ROLES, checkUse, decide, listRegistry, RegistryError, recordApproval, syncInventory, verifyDecisionChain } from '../../../aikosh/registry';
import { defaultStatus, SENSITIVITIES, USES, Use } from '../../../aikosh/policy';
import { csrfGuard, depthGuard, securityHeaders } from '../ocr-study-security';
import { forbiddenField } from '../ocr-study-access';

export const AIKOSH_NOTICE = 'AIKosh data governance only — no file is approved for RAG, embeddings, prompts, fine-tuning, external processing or clinical evidence unless a person records and a second person approves it. Nothing here is clinical validation.';
const router = Router();
const fail = (res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}) => res.status(status).json({ error, code, notice: AIKOSH_NOTICE, ...extra });
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: Request, res: Response) => { fn(req as AuthRequest, res).catch((e) => {
  if (e instanceof RegistryError) { fail(res, e.status, e.code, e.message); return; } logger.error(`aikosh route error: ${safeErrorSummary(e)}`); if (!res.headersSent) fail(res, 500, 'internal', 'Internal error.'); }); };
async function audit(actor: string, action: string, target: string, meta: Record<string, string | number | boolean>) {
  await db.query(`INSERT INTO audit_events (ts, action, actor_id, actor_type, channel, group_id, target_type, target_id, meta) VALUES ($1,$2,$3,'dashboard_user','dashboard',NULL,'aikosh_file',$4,$5)`, [Date.now(), `aikosh.${action}`, actor, target.slice(0, 200), JSON.stringify(meta)]);
}
router.use(securityHeaders, requireDashAuth, requireRole('admin', 'compliance', 'auditor', 'operator'), (_q, res, next) => { res.set('X-Aikosh-Notice', 'governance-only'); next(); }, csrfGuard, depthGuard);
router.use((req, res, next) => { const f = forbiddenField(req.body); if (f) { fail(res, 400, 'forbidden_field', `The body may not contain "${f}": identity and role come from the session.`); return; } next(); });

router.get('/', wrap(async (req, res) => {
  const inv = loadInventory(); const reg = await listRegistry(inv).catch(() => []); const view = registryView(inv); const byPath = new Map(reg.map((r) => [r.path, r]));
  res.json({ notice: AIKOSH_NOTICE, defaultStatus: defaultStatus(), uses: USES, sensitivities: SENSITIVITIES, approverRoles: APPROVER_ROLES, canApprove: APPROVER_ROLES.includes(req.user!.role), files: view.map((v) => ({ ...v, registry: byPath.get(v.path) ?? null })) });
}));
router.post('/sync', wrap(async (req, res) => {
  if (!APPROVER_ROLES.includes(req.user!.role)) { fail(res, 403, 'forbidden', 'Only admin or compliance accounts may register the inventory.'); return; }
  const r = await syncInventory(loadInventory(), req.user!.id); await audit(req.user!.id, 'inventory_synced', 'data/aikosh', { count: r.registered }); res.status(201).json({ ...r, notice: AIKOSH_NOTICE });
}));
router.post('/approvals', wrap(async (req, res) => {
  const b = req.body ?? {}; const rec = await recordApproval({ path: String(b.path ?? ''), sha256: String(b.sha256 ?? ''), provenance: String(b.provenance ?? ''), licenceName: String(b.licenceName ?? ''), licenceRef: String(b.licenceRef ?? ''), licencePermitsUses: Array.isArray(b.licencePermitsUses) ? b.licencePermitsUses : [],
    permittedUses: Array.isArray(b.permittedUses) ? b.permittedUses : [], sensitivity: b.sensitivity, consentRef: b.consentRef ?? null, deidentificationRef: b.deidentificationRef ?? null, externalProcessing: b.externalProcessing === 'approved' ? 'approved' : 'not_approved', dpaRef: b.dpaRef ?? null,
    clinicalOwnerRef: b.clinicalOwnerRef ?? null, datasetCardSha256: b.datasetCardSha256 ?? null, externalFieldsReleased: Array.isArray(b.externalFieldsReleased) ? b.externalFieldsReleased.map(String) : [] }, req.user!.id, req.user!.role);
  await audit(req.user!.id, 'approval_recorded', String(b.path), { sha256: String(b.sha256), recordSha256: rec.contentSha256, count: (b.permittedUses ?? []).length }); res.status(201).json({ ...rec, state: 'awaiting_second_person', notice: AIKOSH_NOTICE });
}));
router.post('/approvals/:id/decision', wrap(async (req, res) => {
  const d = req.body?.decision; if (d !== 'approve' && d !== 'revoke') { fail(res, 400, 'bad_input', 'decision must be approve or revoke.'); return; }
  const r = await decide(String(req.params.id), d, req.user!.id, req.user!.role, String(req.body?.reason ?? ''));
  await audit(req.user!.id, `approval_${d}d`, String(req.params.id), { recordSha256: r.hash, reasonLength: String(req.body?.reason ?? '').length }); res.status(201).json({ hash: r.hash, decision: d, notice: AIKOSH_NOTICE });
}));
router.get('/approvals/:id/chain', wrap(async (req, res) => { res.json({ ...(await verifyDecisionChain(String(req.params.id))), notice: AIKOSH_NOTICE }); }));
router.get('/check', wrap(async (req, res) => {
  const p = String(req.query.path ?? ''); const use = String(req.query.use ?? '') as Use; const f = loadInventory().files.find((x) => x.path === p); if (!f) { fail(res, 404, 'not_found', 'Unknown file.'); return; }
  const { identityOf } = await import('../../../aikosh/inventory'); const fields = String(req.query.fields ?? '').split(',').filter(Boolean);
  res.json({ ...(await checkUse(identityOf(f), f.sha256, use, fields)), notice: AIKOSH_NOTICE });
}));
export default router;
