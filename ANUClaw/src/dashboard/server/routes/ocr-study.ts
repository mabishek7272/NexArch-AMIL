/**
 * OCR validation-study workspaces — mounted at /api/ocr-study. STUDY TOOLING ONLY: synthetic data does not establish OCR accuracy, clinical validation or
 * release approval. Identity comes from the verified dashboard session; study role and tenant come from PostgreSQL membership; the request body never
 * supplies a user, tenant, role or lock state (such fields are refused). Storage fails closed (503) unless configured; only the synthetic local adapter exists.
 */
import { Router, Request, Response } from 'express';
import { requireDashAuth, requireRole, AuthRequest } from '../auth';
import { db } from '../../../db';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';
import { createStudyStorage, StudyStorageStatus } from '../../../validation/study/storage';
import * as pol from '../../../ocr-policy/store';
import { readinessReport, ReviewState } from '../../../ocr-policy/readiness';
import { assertPolicyAllows, ERROR_TYPES, OcrPolicyView, Policy, PolicyError, policyAuditReport, Purpose, requestActivation, stampOf, viewOf } from '../../../ocr-policy/policy';
import { Actor, STUDY_NOTICE, StudyWorkspaces } from '../../../validation/study/workspace';
import { canonical, loadManifest, SPLITS, StudyError, UNLOCK_SCHEMA, UnlockAuthorization } from '../../../validation/study/manifest';
import { csrfGuard, depthGuard, LIMITS, page, policySummary, rateLimit, requireFreshAuth, securityHeaders, sniffForbidden } from '../ocr-study-security';
import { activeOwnerCount, TWO_PERSON_ROLES, auditStudy, can, DASH_ROLES_ALLOWED, forbiddenField, INTERNAL_ROLES, loadMembership, MATRIX, newId, Perm, sha, STUDY_ROLES, StudyRole, StudyRow, tenantOf } from '../ocr-study-access';

const router = Router();
const HEADER_NOTICE = STUDY_NOTICE.replace('—', '-');
const MEDIA = ['text/plain', 'application/pdf', 'image/png', 'image/jpeg'];
const MAX_SOURCES = LIMITS.maxSources, MAX_SOURCE_BYTES = LIMITS.maxSourceBytes, MAX_TOTAL_BYTES = LIMITS.maxTotalSourceBytes;
const CUSTODY_NOTE = 'This check compares the dataset with a lock digest YOU supply from outside this system. Anyone with write access to the study directory can rewrite the manifest AND its hashes, so independent custody exists only if the digest was recorded elsewhere (for example in the signed preregistration) and that recorded value is supplied here. The repository-local manifest cannot prove its own authenticity.';

const services = new Map<string, StudyWorkspaces>();
function service(status: StudyStorageStatus & { ready: true }): StudyWorkspaces { let s = services.get(status.root); if (!s) { s = new StudyWorkspaces(status.root); services.set(status.root, s); } return s; }

function fail(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}) { res.status(status).json({ error, code, notice: STUDY_NOTICE, ...extra }); }
function handle(res: Response, err: unknown): void {
  if (err instanceof StudyError) { fail(res, err.status, err.code, err.message); return; }
  if (err instanceof PolicyError) { fail(res, err.code === 'policy_invalid' ? 400 : err.code === 'acceptance_report_not_available' ? 403 : 409, err.code, err.message, err.missing.length ? { missingFields: err.missing } : {}); return; }
  logger.error(`ocr-study route error: ${safeErrorSummary(err)}`);
  if (!res.headersSent) fail(res, 500, 'internal', 'Internal error.');
}
const wrap = (fn: (req: AuthRequest, res: Response) => Promise<void>) => (req: Request, res: Response) => { fn(req as AuthRequest, res).catch((e) => handle(res, e)); };

router.use(securityHeaders);
router.use(requireDashAuth, requireRole(...DASH_ROLES_ALLOWED));
router.use((_req, res, next) => { res.set('X-Study-Tooling-Notice', HEADER_NOTICE); next(); });
router.use(csrfGuard, depthGuard, rateLimit('general'));
router.use((req, res, next) => { const f = forbiddenField(req.body); if (f) { fail(res, 400, 'forbidden_field', `The request body may not contain "${f}": identity, tenant, role and lock state are derived by the server, never accepted from the client.`); return; } next(); });

interface Ctx { svc: StudyWorkspaces; ws: StudyRow; role: StudyRole; actor: Actor; userId: string }
const wsParam = (req: Request) => String(req.params.id ?? '');
async function ctx(req: AuthRequest, res: Response, perm: Perm): Promise<Ctx | null> {
  const st = createStudyStorage(); if (!st.ready) { fail(res, 503, 'study_storage_unavailable', 'Study storage is not available; nothing was read or written.', { reasons: st.reasons }); return null; }
  const userId = req.user!.id; const wsId = wsParam(req); const m = await loadMembership(userId, wsId);
  const safeWs = /^w-[0-9a-f]{12}$/.test(wsId) ? wsId : 'invalid';
  if (!m) { await auditStudy(userId, 'denied', safeWs, { code: 'not_found', perm }); fail(res, 404, 'not_found', 'Study not found.'); return null; }
  if (!can(m.role, perm)) { await auditStudy(userId, 'denied', safeWs, { code: 'forbidden', perm, role: m.role }); fail(res, 403, 'forbidden', `Your study role (${m.role}) does not permit this operation.`); return null; }
  return { svc: service(st), ws: m.ws, role: m.role, actor: { userId, scope: { kind: 'tenant', id: m.ws.tenant_id } }, userId };
}
interface DsRow { policy_id?: string | null; policy_version?: number | null; policy_sha256?: string | null; workspace_id: string; dataset_id: string; name: string; split: string; provenance_kind: string; annotator_a: string; annotator_b: string; registered_by: string; registered_at: number }
async function dataset(c: Ctx, req: Request, res: Response): Promise<DsRow | null> {
  const row = await db.queryOne<DsRow>('SELECT * FROM ocr_study_datasets WHERE workspace_id = $1 AND dataset_id = $2', [c.ws.id, String(req.params.ds ?? '')]);
  if (!row) { fail(res, 404, 'not_found', 'Dataset not found.'); return null; }
  return row;
}
const assigned = (d: DsRow, userId: string) => d.annotator_a === userId || d.annotator_b === userId;
async function denyUnassigned(c: Ctx, d: DsRow, perm: string, res: Response) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'forbidden', perm, datasetId: d.dataset_id, role: c.role }); fail(res, 403, 'forbidden', 'You are not assigned to this dataset.'); }
/**
 * The policy version a dataset is evaluated under: the version bound at LOCK time for a locked set (verified against the recorded hash), otherwise the current synthetic-test
 * version. The synthetic policy is the only one usable here: real data is refused earlier, and real-study policies cannot be active in this build.
 */
async function policyFor(c: Ctx, d: DsRow, purpose: Purpose): Promise<OcrPolicyView> {
  await pol.ensureWorkspacePolicies(c.ws.id, c.userId); let p: Policy;
  if (d.policy_sha256 && d.policy_id && d.policy_version) { p = await pol.version(d.policy_id, Number(d.policy_version)); if (p.sha256 !== d.policy_sha256) throw new PolicyError('policy_tampered', 'the policy version bound to this locked dataset no longer matches its recorded hash'); }
  else p = await pol.current(pol.syntheticId(c.ws.id));
  assertPolicyAllows(p, { purpose, data: 'synthetic' }); return viewOf(p);
}
const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const str = (v: unknown, what: string, max = 500): string => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new StudyError('bad_input', `${what} is required (1–${max} characters).`); return v.trim(); };

// ── overview ───────────────────────────────────────────────────────────────
router.get('/', wrap(async (req, res) => {
  const st = createStudyStorage(); const mine = await db.query('SELECT w.id, w.name, m.study_role FROM ocr_study_workspaces w JOIN ocr_study_members m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at DESC', [req.user!.id]);
  res.json({ notice: STUDY_NOTICE, storage: st.ready ? { ready: true, kind: st.kind, syntheticOnly: true, limitations: st.limitations } : { ready: false, kind: st.kind, reasons: st.reasons },
    roles: STUDY_ROLES, permissions: MATRIX, security: policySummary(), studies: mine.map((r: { id: string; name: string; study_role: string }) => ({ id: r.id, name: r.name, myRole: r.study_role })) });
}));

// ── studies and membership ─────────────────────────────────────────────────
router.post('/studies', wrap(async (req, res) => {
  const st = createStudyStorage(); if (!st.ready) { fail(res, 503, 'study_storage_unavailable', 'Study storage is not available; nothing was created.', { reasons: st.reasons }); return; }
  const name = str(req.body?.name, 'name', 200), purpose = str(req.body?.purpose, 'purpose', 500); const tenant = tenantOf(req.user!);
  const doc = service(st).createWorkspace({ userId: req.user!.id, scope: { kind: 'tenant', id: tenant } }, name, purpose, INTERNAL_ROLES.study_owner);
  await db.query('INSERT INTO ocr_study_workspaces (id, tenant_id, name, purpose, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [doc.id, tenant, name, purpose, req.user!.id, Date.now()]);
  await db.query('INSERT INTO ocr_study_members (workspace_id, user_id, study_role, added_by, added_at) VALUES ($1,$2,$3,$4,$5)', [doc.id, req.user!.id, 'study_owner', req.user!.id, Date.now()]);
  await pol.ensureWorkspacePolicies(doc.id, req.user!.id);
  await auditStudy(req.user!.id, 'study_created', doc.id, { studyRole: 'study_owner' }); res.status(201).json({ id: doc.id, name, notice: STUDY_NOTICE });
}));
router.get('/studies/:id', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_study'); if (!c) return;
  const members = await db.query("SELECT m.user_id, m.study_role, u.email FROM ocr_study_members m LEFT JOIN dash_users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.status = 'active' ORDER BY m.added_at LIMIT 200", [c.ws.id]);
  const seeAll = ['study_owner', 'clinical_lead', 'auditor'].includes(c.role);
  const dsRows = await db.query<DsRow>('SELECT * FROM ocr_study_datasets WHERE workspace_id = $1 ORDER BY registered_at LIMIT 200', [c.ws.id]);
  const visible = dsRows.filter((d) => c.role !== 'annotator' || assigned(d, c.userId));
  res.json({ notice: STUDY_NOTICE, id: c.ws.id, name: c.ws.name, purpose: c.ws.purpose, myRole: c.role, severityMap: await pol.ensureWorkspacePolicies(c.ws.id, c.userId).then(() => pol.current(pol.syntheticId(c.ws.id))).then((p) => (p.fields.severityMap as { value: Record<string, string> }).value),
    members: members.filter((m: { user_id: string }) => seeAll || m.user_id === c.userId).map((m: { user_id: string; study_role: string; email: string | null }) => ({ userId: m.user_id, email: m.email, studyRole: m.study_role })),
    datasets: visible.map((d) => ({ datasetId: d.dataset_id, name: d.name, split: d.split, provenanceKind: d.provenance_kind, registeredAt: d.registered_at, ...(['study_owner', 'dataset_custodian', 'clinical_lead', 'auditor'].includes(c.role) ? { annotators: [d.annotator_a, d.annotator_b] } : {}), assignedToMe: assigned(d, c.userId) })) });
}));
router.post('/studies/:id/members', wrap(async (req, res) => {
  const c = await ctx(req, res, 'manage_members'); if (!c) return;
  const email = str(req.body?.memberEmail, 'memberEmail', 254).toLowerCase(); const studyRole = req.body?.studyRole as StudyRole;
  if (!STUDY_ROLES.includes(studyRole)) throw new StudyError('bad_input', `studyRole must be one of ${STUDY_ROLES.join(', ')}.`);
  const u = await db.queryOne<{ id: string; role: string }>('SELECT id, role FROM dash_users WHERE lower(email) = $1', [email]);
  if (!u || !DASH_ROLES_ALLOWED.includes(u.role)) throw new StudyError('not_found', 'No eligible account with that email.', 404);
  if (await db.queryOne('SELECT 1 AS x FROM ocr_study_members WHERE workspace_id = $1 AND user_id = $2', [c.ws.id, u.id])) throw new StudyError('already_member', 'That account already has a role in this study (one role per user).', 409);
  await db.query('INSERT INTO ocr_study_members (workspace_id, user_id, study_role, added_by, added_at) VALUES ($1,$2,$3,$4,$5)', [c.ws.id, u.id, studyRole, c.userId, Date.now()]);
  c.svc.trustedSetMembership(c.actor.scope, c.ws.id, u.id, INTERNAL_ROLES[studyRole]); await auditStudy(c.userId, 'member_added', c.ws.id, { memberId: u.id, studyRole }); res.status(201).json({ userId: u.id, studyRole });
}));

// ── member lifecycle: suspend / remove / reinstate (rows are NEVER deleted; history stays attributable) ──
interface MemberRow { user_id: string; study_role: StudyRole; status: string; email: string | null; status_changed_at: number | null }
const MEMBER_WARNING = 'Suspending or removing a member revokes ALL their access to this study immediately. Their annotations, adjudications and audit entries are kept unchanged and stay attributable to them; nothing is deleted. A removed member cannot be re-added to this study.';
router.get('/studies/:id/members', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_members'); if (!c) return; const pg = page(req);
  const rows = await db.query<MemberRow>('SELECT m.user_id, m.study_role, m.status, m.status_changed_at, u.email FROM ocr_study_members m LEFT JOIN dash_users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY m.added_at LIMIT $2 OFFSET $3', [c.ws.id, pg.limit, pg.offset]);
  const actions = await db.query('SELECT id, target_user_id, action, requested_by, status, approved_by FROM ocr_study_member_actions WHERE workspace_id = $1 AND status IN (\'requested\',\'approved\') ORDER BY requested_at DESC LIMIT 50', [c.ws.id]);
  res.json({ notice: STUDY_NOTICE, warning: MEMBER_WARNING, twoPersonRoles: TWO_PERSON_ROLES, ...pg, members: rows.map((m) => ({ userId: m.user_id, email: m.email, studyRole: m.study_role, status: m.status, statusChangedAt: m.status_changed_at ? Number(m.status_changed_at) : null })),
    pendingActions: actions.map((a: { id: string; target_user_id: string; action: string; requested_by: string; status: string; approved_by: string | null }) => ({ actionId: a.id, targetUserId: a.target_user_id, action: a.action, requestedBy: a.requested_by, status: a.status, approvedBy: a.approved_by })) });
}));
async function target(c: Ctx, req: Request): Promise<MemberRow> {
  const t = await db.queryOne<MemberRow>('SELECT m.user_id, m.study_role, m.status, m.status_changed_at, NULL AS email FROM ocr_study_members m WHERE m.workspace_id = $1 AND m.user_id = $2', [c.ws.id, String(req.params.uid ?? '')]);
  if (!t) throw new StudyError('not_found', 'No such member.', 404); return t;
}
async function applyStatus(c: Ctx, t: MemberRow, status: 'active' | 'suspended' | 'removed', reason: string, extra: Record<string, unknown> = {}): Promise<void> {
  const claim = await db.query("UPDATE ocr_study_members SET status = $1, status_reason_sha256 = $2, status_reason_length = $3, status_changed_by = $4, status_changed_at = $5 WHERE workspace_id = $6 AND user_id = $7 AND status = $8 RETURNING user_id", [status, sha(reason), reason.length, c.userId, Date.now(), c.ws.id, t.user_id, t.status]);
  if (!claim.length) throw new StudyError('conflict', 'The member changed state concurrently; reload and retry.', 409);
  try { c.svc.trustedSetMembership(c.actor.scope, c.ws.id, t.user_id, status === 'active' ? INTERNAL_ROLES[t.study_role] : []); } catch { /* file-store mirror is belt-and-braces; the database gate already applies */ }
  await auditStudy(c.userId, `member_${status === 'active' ? 'reinstated' : status}`, c.ws.id, { targetId: t.user_id, studyRole: t.study_role, status, reasonSha256: sha(reason), reasonLength: reason.length, ...extra });
}
async function guardLastOwner(c: Ctx, t: MemberRow) { if (t.study_role === 'study_owner' && t.status === 'active' && (await activeOwnerCount(c.ws.id, t.user_id)) < 1) throw new StudyError('last_owner', 'The last active study owner cannot be suspended or removed. Add another study owner first.', 409); }
for (const act of ['suspend', 'remove'] as const) {
  router.post(`/studies/:id/members/:uid/${act}`, rateLimit('sensitive'), wrap(async (req, res) => {
    const c = await ctx(req, res, 'manage_members'); if (!c) return; if (!(await requireFreshAuth(req, res, 'member_change', c.ws.id))) return;
    const t = await target(c, req); const reason = str(req.body?.reason, 'reason', LIMITS.maxReasonChars);
    if (t.status === 'removed' || (act === 'suspend' && t.status !== 'active')) throw new StudyError('bad_state', `The member is already ${t.status}.`, 409);
    if (TWO_PERSON_ROLES.includes(t.study_role)) { fail(res, 409, 'second_authorization_required', `${t.study_role} changes need a second authorized actor: create a request at /members/${t.user_id}/requests and have a different study owner or clinical lead approve it.`); return; }
    await guardLastOwner(c, t); await applyStatus(c, t, act === 'suspend' ? 'suspended' : 'removed', reason); res.json({ userId: t.user_id, status: act === 'suspend' ? 'suspended' : 'removed', warning: MEMBER_WARNING, notice: STUDY_NOTICE });
  }));
}
router.post('/studies/:id/members/:uid/reinstate', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'manage_members'); if (!c) return; if (!(await requireFreshAuth(req, res, 'member_change', c.ws.id))) return;
  const t = await target(c, req); const reason = str(req.body?.reason, 'reason', LIMITS.maxReasonChars);
  if (t.status !== 'suspended') throw new StudyError('bad_state', t.status === 'removed' ? 'A removed member cannot be reinstated in this study.' : 'Only suspended members can be reinstated.', 409);
  if (TWO_PERSON_ROLES.includes(t.study_role) && t.user_id === c.userId) throw new StudyError('forbidden', 'You cannot reinstate yourself.', 403);
  await applyStatus(c, t, 'active', reason); res.json({ userId: t.user_id, status: 'active', notice: STUDY_NOTICE });
}));
router.post('/studies/:id/members/:uid/requests', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'manage_members'); if (!c) return; if (!(await requireFreshAuth(req, res, 'member_change', c.ws.id))) return;
  const t = await target(c, req); const reason = str(req.body?.reason, 'reason', LIMITS.maxReasonChars); const action = req.body?.action;
  if (action !== 'suspend' && action !== 'remove') throw new StudyError('bad_input', 'action must be suspend or remove.');
  if (!TWO_PERSON_ROLES.includes(t.study_role)) throw new StudyError('bad_input', 'Two-person authorization applies only to dataset custodians and clinical leads; use the direct route for other roles.');
  if (t.status !== 'active') throw new StudyError('bad_state', `The member is ${t.status}.`, 409);
  if (await db.queryOne("SELECT 1 AS x FROM ocr_study_member_actions WHERE workspace_id = $1 AND target_user_id = $2 AND status IN ('requested','approved')", [c.ws.id, t.user_id])) throw new StudyError('request_open', 'A request for this member is already open.', 409);
  const id = newId('m-'); await db.query('INSERT INTO ocr_study_member_actions (id, workspace_id, target_user_id, action, requested_by, requested_at, reason_sha256, reason_length, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, c.ws.id, t.user_id, action, c.userId, Date.now(), sha(reason), reason.length, 'requested']);
  await auditStudy(c.userId, 'member_action_requested', c.ws.id, { targetId: t.user_id, action, requestId: id, reasonSha256: sha(reason), reasonLength: reason.length }); res.status(201).json({ requestId: id, status: 'requested', next: 'A different study owner or clinical lead must approve; then the requester executes.', warning: MEMBER_WARNING, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/members/:uid/requests/:rid/approve', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'approve_member_action'); if (!c) return; if (!(await requireFreshAuth(req, res, 'member_change', c.ws.id))) return;
  const a = await db.queryOne<{ id: string; target_user_id: string; requested_by: string; status: string }>('SELECT id, target_user_id, requested_by, status FROM ocr_study_member_actions WHERE id = $1 AND workspace_id = $2 AND target_user_id = $3', [String(req.params.rid), c.ws.id, String(req.params.uid)]);
  if (!a) { fail(res, 404, 'not_found', 'Request not found.'); return; } const reason = str(req.body?.reason, 'reason', LIMITS.maxReasonChars);
  if (a.status !== 'requested') throw new StudyError('bad_state', `The request is ${a.status}.`, 409);
  if (a.requested_by === c.userId || a.target_user_id === c.userId) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'approver_must_differ', perm: 'approve_member_action', requestId: a.id }); fail(res, 403, 'approver_must_differ', 'The approver must be a different user from both the requester and the member concerned.'); return; }
  await db.query("UPDATE ocr_study_member_actions SET status = 'approved', approved_by = $1, approved_at = $2, approval_reason_sha256 = $3 WHERE id = $4 AND status = 'requested'", [c.userId, Date.now(), sha(reason), a.id]);
  await auditStudy(c.userId, 'member_action_approved', c.ws.id, { targetId: a.target_user_id, requestId: a.id, approvedBy: c.userId, requestedBy: a.requested_by, reasonSha256: sha(reason), reasonLength: reason.length }); res.json({ requestId: a.id, status: 'approved', notice: STUDY_NOTICE });
}));
router.post('/studies/:id/members/:uid/requests/:rid/execute', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'manage_members'); if (!c) return; if (!(await requireFreshAuth(req, res, 'member_change', c.ws.id))) return;
  const a = await db.queryOne<{ id: string; target_user_id: string; action: 'suspend' | 'remove'; requested_by: string; status: string; approved_by: string | null }>('SELECT id, target_user_id, action, requested_by, status, approved_by FROM ocr_study_member_actions WHERE id = $1 AND workspace_id = $2 AND target_user_id = $3', [String(req.params.rid), c.ws.id, String(req.params.uid)]);
  if (!a) { fail(res, 404, 'not_found', 'Request not found.'); return; }
  if (a.requested_by !== c.userId) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'forbidden', perm: 'execute_member_action', requestId: a.id }); fail(res, 403, 'forbidden', 'Only the requester can execute the request.'); return; }
  if (a.status === 'executed') throw new StudyError('authorization_already_used', 'This request was already executed.', 409);
  if (a.status !== 'approved' || !a.approved_by || a.approved_by === c.userId) throw new StudyError('not_authorized', 'The request has not been approved by a different user.', 409);
  const approver = await loadMembership(a.approved_by, c.ws.id); if (!approver || !can(approver.role, 'approve_member_action')) throw new StudyError('not_authorized', 'The approver no longer holds an active role that can approve.', 409);
  const t = await target(c, req); if (t.status !== 'active') throw new StudyError('bad_state', `The member is ${t.status}.`, 409); await guardLastOwner(c, t);
  const claim = await db.query("UPDATE ocr_study_member_actions SET status = 'executed', executed_at = $1 WHERE id = $2 AND status = 'approved' RETURNING id", [Date.now(), a.id]); if (!claim.length) throw new StudyError('authorization_already_used', 'This request was already executed.', 409);
  await applyStatus(c, t, a.action === 'suspend' ? 'suspended' : 'removed', 'two-person request', { requestId: a.id, approvedBy: a.approved_by }); res.json({ userId: t.user_id, status: a.action === 'suspend' ? 'suspended' : 'removed', warning: MEMBER_WARNING, notice: STUDY_NOTICE });
}));
router.put('/studies/:id/severity-map', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'configure_severity'); if (!c) return; if (!(await requireFreshAuth(req, res, 'configure_severity', c.ws.id))) return;
  const map = req.body?.map; if (!map || typeof map !== 'object' || Array.isArray(map)) throw new StudyError('bad_input', 'map must be an object of error type → label.');
  for (const [k, v] of Object.entries(map)) { if (!(ERROR_TYPES as readonly string[]).includes(k)) throw new StudyError('bad_input', `unknown error type "${k}" (allowed: ${ERROR_TYPES.join(', ')}).`); if (typeof v !== 'string' || !/^[A-Za-z0-9 _-]{1,40}$/.test(v)) throw new StudyError('bad_input', `label for ${k} must be 1–40 plain characters.`); }
  await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const cur = await pol.current(pol.syntheticId(c.ws.id)); const merged = { ...(cur.fields.severityMap as { value: Record<string, string> }).value, ...map };
  const next = await pol.putVersion(pol.syntheticId(c.ws.id), { fields: { severityMap: { value: merged } } }, c.userId);
  await auditStudy(c.userId, 'severity_map_set', c.ws.id, { severityMapSha256: sha(canonical(map)), policyVersion: next.version, policySha256: next.sha256 }); res.json({ ok: true, policy: stampOf(viewOf(next)), note: 'Severity labels are descriptive and are stored in the SYNTHETIC test policy chain of this workspace. A real-study policy is edited through /policy. Setting labels does not accept or approve anything.' });
}));
router.post('/studies/:id/acceptance', wrap(async (req, res) => {
  const wsId = wsParam(req); const m = await loadMembership(req.user!.id, wsId); if (!m) { await auditStudy(req.user!.id, 'denied', /^w-[0-9a-f]{12}$/.test(wsId) ? wsId : 'invalid', { code: 'not_found', perm: 'acceptance' }); fail(res, 404, 'not_found', 'Study not found.'); return; }
  await auditStudy(req.user!.id, 'denied', m.ws.id, { code: 'acceptance_not_available', role: m.role });
  fail(res, 403, 'acceptance_not_available', 'Marking a study accepted is not available in this software, for any role. Acceptance is a human decision recorded outside it, against criteria fixed in the approved protocol.');
}));

// ── datasets ───────────────────────────────────────────────────────────────
router.post('/studies/:id/datasets', rateLimit('upload'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'register_dataset'); if (!c) return;
  const b = req.body ?? {};
  if (b.provenanceKind !== 'synthetic_fixture') { await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const real = await pol.current(pol.realId(c.ws.id)); await auditStudy(c.userId, 'denied', c.ws.id, { code: 'policy_not_active', perm: 'register_dataset', kind: 'real_study' }); assertPolicyAllows(real, { purpose: 'real_registration', data: 'real' }); }
  if (b.provenanceKind !== 'synthetic_fixture') throw new StudyError('real_data_refused', 'Only synthetic_fixture datasets are accepted: the available storage adapter is synthetic-only (no encryption at rest, retention or access control).', 400);
  if (!SPLITS.includes(b.split)) throw new StudyError('bad_input', `split must be one of ${SPLITS.join(', ')}.`);
  if (!Array.isArray(b.annotatorEmails) || b.annotatorEmails.length !== 2) throw new StudyError('bad_input', 'annotatorEmails must list exactly two annotators.');
  const ids: string[] = [];
  for (const e of b.annotatorEmails) {
    const u = await db.queryOne<{ id: string }>('SELECT u.id FROM dash_users u JOIN ocr_study_members m ON m.user_id = u.id WHERE lower(u.email) = $1 AND m.workspace_id = $2 AND m.study_role = $3', [String(e).toLowerCase(), c.ws.id, 'annotator']);
    if (!u) throw new StudyError('bad_input', 'Both annotators must be members of this study with the annotator role.'); ids.push(u.id);
  }
  if (ids[0] === ids[1]) throw new StudyError('bad_input', 'The two annotators must be different people.');
  if (!Array.isArray(b.sources) || !b.sources.length || b.sources.length > MAX_SOURCES) throw new StudyError('bad_input', `sources must have 1–${MAX_SOURCES} entries.`);
  let total = 0; const sources = b.sources.map((s: { contentBase64?: unknown; pages?: unknown; mediaType?: unknown }, i: number) => {
    if (typeof s.contentBase64 !== 'string' || !MEDIA.includes(String(s.mediaType)) || !Number.isInteger(s.pages)) throw new StudyError('bad_input', `source ${i}: contentBase64, an allowed mediaType (${MEDIA.join(', ')}) and integer pages are required.`);
    const bytes = Buffer.from(s.contentBase64, 'base64'); total += bytes.length; const bad = sniffForbidden(bytes); if (bad) throw new StudyError('archive_refused', `source ${i}: ${bad} content is refused (archives, compressed and executable files are never accepted, whatever the declared type).`, 400); if (!bytes.length || bytes.length > MAX_SOURCE_BYTES || total > MAX_TOTAL_BYTES) throw new StudyError('bad_input', 'source empty or too large (synthetic datasets only: 1 MiB each, 3 MB per request).');
    return { bytes, mediaType: String(s.mediaType), pages: Number(s.pages) };
  });
  const r = c.svc.registerDataset(c.actor, c.ws.id, { name: str(b.name, 'name', 200), studyRef: str(b.studyRef, 'studyRef', 200), provenanceKind: 'synthetic_fixture', split: b.split, origin: str(b.origin, 'origin', 300), annotators: [ids[0], ids[1]], sources });
  await db.query('INSERT INTO ocr_study_datasets (workspace_id, dataset_id, name, split, provenance_kind, annotator_a, annotator_b, registered_by, registered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [c.ws.id, r.datasetId, String(b.name).slice(0, 200), b.split, 'synthetic_fixture', ids[0], ids[1], c.userId, Date.now()]);
  await auditStudy(c.userId, 'dataset_registered', c.ws.id, { datasetId: r.datasetId, split: b.split, provenanceKind: 'synthetic_fixture', count: sources.length }); res.status(201).json({ ...r, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/datasets/:ds/attestation', wrap(async (req, res) => {
  const c = await ctx(req, res, 'attest'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const r = c.svc.attestDeidentification(c.actor, c.ws.id, d.dataset_id, req.body?.record); await auditStudy(c.userId, 'deidentification_attested', c.ws.id, { datasetId: d.dataset_id, recordSha256: r.recordSha256 }); res.status(201).json({ ...r, note: 'Recorded and hashed. This software cannot verify the attestation.' });
}));
router.post('/studies/:id/datasets/:ds/manifest', wrap(async (req, res) => {
  const c = await ctx(req, res, 'manifest'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const m = c.svc.generateManifest(c.actor, c.ws.id, d.dataset_id); await auditStudy(c.userId, 'manifest_generated', c.ws.id, { datasetId: d.dataset_id, manifestSha256: m.manifestSha256 }); res.status(201).json({ manifestSha256: m.manifestSha256, cases: m.cases.length, lockState: m.lock.state, notice: STUDY_NOTICE });
}));
router.get('/studies/:id/datasets/:ds/manifest', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_manifest'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id); res.json({ notice: STUDY_NOTICE, lockState: m.lock.state, everUnlocked: m.lock.everUnlocked, manifest: m });
}));
router.post('/studies/:id/datasets/:ds/verify', rateLimit('expensive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'verify'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id); const expected = req.body?.expectedLockDigest;
  if (m.lock.state === 'locked' && !isHex64(expected)) { fail(res, 400, 'expected_lock_digest_required', 'Verifying a locked dataset requires expectedLockDigest: the 64-hex digest recorded OUTSIDE this system when the lock was made.', { custody: CUSTODY_NOTE }); return; }
  if (expected !== undefined && !isHex64(expected)) { fail(res, 400, 'bad_input', 'expectedLockDigest must be 64 lowercase hex characters.'); return; }
  const r = c.svc.verify(c.actor, c.ws.id, d.dataset_id, expected); await auditStudy(c.userId, 'verified', c.ws.id, { datasetId: d.dataset_id, ok: r.ok });
  res.json({ ...r, lockState: m.lock.state, custody: m.lock.state === 'locked' ? CUSTODY_NOTE : 'The dataset is not locked, so there is no lock digest to anchor; integrity is checked against the repository-local manifest only.', notice: STUDY_NOTICE });
}));

// ── blind annotation ───────────────────────────────────────────────────────
router.get('/studies/:id/datasets/:ds/cases', wrap(async (req, res) => {
  const c = await ctx(req, res, 'list_cases'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  if (c.role === 'annotator' && !assigned(d, c.userId)) { await denyUnassigned(c, d, 'list_cases', res); return; }
  const pg = page(req); const all = c.svc.listCases(c.actor, c.ws.id, d.dataset_id); res.json({ notice: STUDY_NOTICE, total: all.length, ...pg, cases: all.slice(pg.offset, pg.offset + pg.limit) });
}));
router.get('/studies/:id/datasets/:ds/cases/:caseId/source', rateLimit('expensive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'read_source'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  if (c.role === 'annotator' && !assigned(d, c.userId)) { await denyUnassigned(c, d, 'read_source', res); return; }
  const s = c.svc.readCaseSource(c.actor, c.ws.id, d.dataset_id, String(req.params.caseId)); await auditStudy(c.userId, 'source_read', c.ws.id, { datasetId: d.dataset_id, caseId: String(req.params.caseId) });
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="case.bin"', 'X-Content-SHA256': s.sha256, 'X-Original-Media-Type': s.mediaType }); res.send(s.bytes);
}));
router.post('/studies/:id/datasets/:ds/annotations', wrap(async (req, res) => {
  const c = await ctx(req, res, 'import_annotations'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  if (!assigned(d, c.userId)) { await denyUnassigned(c, d, 'import_annotations', res); return; }
  const f = req.body?.file; if (!f || typeof f !== 'object') throw new StudyError('bad_input', 'file (the annotation file) is required.');
  if (f.annotatorId !== undefined && f.annotatorId !== c.userId) { fail(res, 400, 'forbidden_field', 'file.annotatorId may not name anyone else: the annotator is the signed-in user.'); return; }
  if (!Array.isArray(f.items) || f.items.length > LIMITS.maxAnnotationItems) throw new StudyError('too_large', `An annotation file may hold at most ${LIMITS.maxAnnotationItems} items.`, 413);
  const r = c.svc.importAnnotations(c.actor, c.ws.id, d.dataset_id, { ...f, annotatorId: c.userId }); await auditStudy(c.userId, 'annotations_imported', c.ws.id, { datasetId: d.dataset_id, version: r.version, sha256: r.sha256 }); res.status(201).json({ ...r, notice: STUDY_NOTICE });
}));
router.get('/studies/:id/datasets/:ds/my-annotations', wrap(async (req, res) => {
  const c = await ctx(req, res, 'own_annotations'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  if (!assigned(d, c.userId)) { await denyUnassigned(c, d, 'own_annotations', res); return; } res.json({ notice: STUDY_NOTICE, ...c.svc.ownAnnotations(c.actor, c.ws.id, d.dataset_id) });
}));

// ── agreement, disagreement review, adjudication ──────────────────────────
router.get('/studies/:id/datasets/:ds/agreement', wrap(async (req, res) => {
  const c = await ctx(req, res, 'agreement_summary'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const r = c.svc.agreementReport(c.actor, c.ws.id, d.dataset_id, await policyFor(c, d, 'synthetic_tooling'));
  res.json({ notice: STUDY_NOTICE, summary: { presence: r.agreement.presence, fields: r.agreement.fields, casesCompared: r.agreement.casesCompared, note: r.agreement.note }, missingness: r.missingness,
    queue: { open: r.queue.filter((q) => q.status === 'open').length, resolved: r.queue.filter((q) => q.status === 'resolved').length }, itemLevelDisagreements: 'visible to adjudicators only' });
}));
router.get('/studies/:id/datasets/:ds/queue', wrap(async (req, res) => {
  const c = await ctx(req, res, 'review_queue'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const r = c.svc.agreementReport(c.actor, c.ws.id, d.dataset_id, await policyFor(c, d, 'synthetic_tooling')); await auditStudy(c.userId, 'queue_viewed', c.ws.id, { datasetId: d.dataset_id, openDisagreements: r.queue.filter((q) => q.status === 'open').length });
  const pg = page(req); res.json({ notice: STUDY_NOTICE, blind: 'annotator identities are replaced by A and B', total: r.queue.length, open: r.queue.filter((q) => q.status === 'open').length, ...pg, queue: r.queue.slice(pg.offset, pg.offset + pg.limit).map((q) => ({ id: q.id, caseId: q.caseId, itemKey: q.itemKey, field: q.field, kind: q.kind, status: q.status, A: q.a.value, B: q.b.value })) });
}));
router.post('/studies/:id/datasets/:ds/adjudications', wrap(async (req, res) => {
  const c = await ctx(req, res, 'adjudicate'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const reason = str(req.body?.reason, 'reason', 1000); const src = req.body?.source; const mapped = src === 'A' ? 'a' : src === 'B' ? 'b' : src;
  if (!['a', 'b', 'other', 'ambiguous'].includes(mapped)) throw new StudyError('bad_input', 'source must be A, B, other or ambiguous.');
  const rec = c.svc.adjudicate(c.actor, c.ws.id, d.dataset_id, { queueId: str(req.body?.queueId, 'queueId', 40), source: mapped, finalValue: req.body?.finalValue, reason }, await policyFor(c, d, 'synthetic_tooling'));
  await auditStudy(c.userId, 'adjudicated', c.ws.id, { datasetId: d.dataset_id, queueId: rec.queueId, source: mapped, sha256: rec.hash, reasonSha256: sha(reason), reasonLength: reason.length });
  res.status(201).json({ recordHash: rec.hash, seq: rec.seq, note: 'Both original annotations are preserved in the record; adjudication never alters annotation files.', notice: STUDY_NOTICE });
}));
router.get('/studies/:id/datasets/:ds/adjudications', wrap(async (req, res) => {
  const c = await ctx(req, res, 'review_queue'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const pg = page(req); const allRecs = c.svc.adjudicationRecords(c.actor, c.ws.id, d.dataset_id); res.json({ notice: STUDY_NOTICE, total: allRecs.length, ...pg, records: allRecs.slice(pg.offset, pg.offset + pg.limit).map((r) => ({ seq: r.seq, queueId: r.queueId, caseId: r.caseId, field: r.field, original: { A: r.original.a.value, B: r.original.b.value, annotationVersions: { A: r.original.a.annotationVersion, B: r.original.b.annotationVersion } }, decision: r.decision, reason: r.reason, at: r.at, hash: r.hash })) });
}));

// ── truth, lock, unlock ────────────────────────────────────────────────────
router.post('/studies/:id/datasets/:ds/truth', rateLimit('expensive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'build_truth'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const t = c.svc.buildTruth(c.actor, c.ws.id, d.dataset_id, await policyFor(c, d, 'synthetic_tooling')); await auditStudy(c.userId, 'truth_built', c.ws.id, { datasetId: d.dataset_id, sha256: t.sha256, version: t.version, count: t.items }); res.status(201).json({ version: t.version, items: t.items, excludedAmbiguous: t.excludedAmbiguous, sha256: t.sha256, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/datasets/:ds/lock', wrap(async (req, res) => {
  const c = await ctx(req, res, 'lock'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const bound = await policyFor(c, d, 'synthetic_tooling'); c.svc.checkSecondReader(c.actor, c.ws.id, d.dataset_id, bound);
  const r = c.svc.lock(c.actor, c.ws.id, d.dataset_id); await db.query('UPDATE ocr_study_datasets SET policy_id = $1, policy_version = $2, policy_sha256 = $3 WHERE workspace_id = $4 AND dataset_id = $5', [bound.id, bound.version, bound.sha256, c.ws.id, d.dataset_id]);
  await auditStudy(c.userId, 'locked', c.ws.id, { datasetId: d.dataset_id, lockDigest: r.lockDigest, manifestSha256: r.manifestSha256, policyVersion: bound.version, policySha256: bound.sha256 }); res.status(201).json({ ...r, custody: CUSTODY_NOTE, notice: STUDY_NOTICE });
}));
interface UnlockRow { id: string; workspace_id: string; tenant_id: string; dataset_id: string; requested_by: string; requested_at: number; request_reason: string; manifest_sha256: string; lock_digest: string; status: string; authorized_by: string | null; authorizer_role_claim: string | null;
  authorizer_credential_ref: string | null; protocol_deviation_ref: string | null; authorization_reason: string | null; authorized_at: number | null; authorization_sha256: string | null; authorized_manifest_sha256: string | null; executed_at: number | null }
const authRecord = (u: UnlockRow): UnlockAuthorization => ({ schema: UNLOCK_SCHEMA, manifestSha256: u.authorized_manifest_sha256!, lockDigest: u.lock_digest, reason: u.authorization_reason!, protocolDeviationRef: u.protocol_deviation_ref!,
  authorizedBy: { name: u.authorized_by!, role: u.authorizer_role_claim!, credentialRef: u.authorizer_credential_ref! }, authorizedAt: new Date(Number(u.authorized_at)).toISOString() });
router.post('/studies/:id/datasets/:ds/unlock-requests', wrap(async (req, res) => {
  const c = await ctx(req, res, 'request_unlock'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id); if (m.lock.state !== 'locked') throw new StudyError('not_locked', 'The dataset is not locked.', 409);
  if (await db.queryOne("SELECT 1 AS x FROM ocr_study_unlocks WHERE workspace_id = $1 AND dataset_id = $2 AND status <> 'executed'", [c.ws.id, d.dataset_id])) throw new StudyError('request_open', 'An unlock request is already open for this dataset.', 409);
  const id = newId('u-'); await db.query('INSERT INTO ocr_study_unlocks (id, workspace_id, tenant_id, dataset_id, requested_by, requested_at, request_reason, manifest_sha256, lock_digest, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, c.ws.id, c.ws.tenant_id, d.dataset_id, c.userId, Date.now(), str(req.body?.reason, 'reason', 1000), m.manifestSha256, m.lock.lockDigest, 'requested']);
  await auditStudy(c.userId, 'unlock_requested', c.ws.id, { datasetId: d.dataset_id, requestId: id, manifestSha256: m.manifestSha256, lockDigest: m.lock.lockDigest ?? '' }); res.status(201).json({ requestId: id, status: 'requested', next: 'A different authenticated user (study owner or clinical lead) must authorize this request.', notice: STUDY_NOTICE });
}));
router.get('/studies/:id/datasets/:ds/unlock-requests', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_manifest'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const rows = await db.query<UnlockRow>('SELECT * FROM ocr_study_unlocks WHERE workspace_id = $1 AND dataset_id = $2 ORDER BY requested_at DESC', [c.ws.id, d.dataset_id]);
  res.json({ notice: STUDY_NOTICE, requests: rows.map((u) => ({ requestId: u.id, status: u.status, requestedBy: u.requested_by, requestedAt: Number(u.requested_at), authorizedBy: u.authorized_by, authorizedAt: u.authorized_at ? Number(u.authorized_at) : null, executedAt: u.executed_at ? Number(u.executed_at) : null })) });
}));
router.post('/studies/:id/datasets/:ds/unlock-requests/:rid/authorize', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'authorize_unlock'); if (!c) return; if (!(await requireFreshAuth(req, res, 'authorize_unlock', c.ws.id))) return; const d = await dataset(c, req, res); if (!d) return;
  const u = await db.queryOne<UnlockRow>('SELECT * FROM ocr_study_unlocks WHERE id = $1 AND workspace_id = $2 AND dataset_id = $3', [String(req.params.rid), c.ws.id, d.dataset_id]); if (!u) { fail(res, 404, 'not_found', 'Unlock request not found.'); return; }
  if (u.tenant_id !== c.ws.tenant_id) throw new StudyError('tenant_mismatch', 'The request belongs to a different tenant.', 409);
  if (u.status !== 'requested') throw new StudyError('bad_state', `The request is ${u.status}; an authorization is recorded once.`, 409);
  if (u.requested_by === c.userId) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'authorizer_must_differ', perm: 'authorize_unlock', requestId: u.id }); fail(res, 403, 'authorizer_must_differ', 'The authorizer must be a different authenticated user from the requester.'); return; }
  const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id); if (m.manifestSha256 !== u.manifest_sha256 || m.lock.lockDigest !== u.lock_digest || m.lock.state !== 'locked') throw new StudyError('manifest_mismatch', 'The dataset changed since the request was made; make a new request.', 409);
  const reason = str(req.body?.reason, 'reason', 1000), dev = str(req.body?.protocolDeviationRef, 'protocolDeviationRef', 200), cred = str(req.body?.credentialRef, 'credentialRef', 200), roleClaim = str(req.body?.roleClaim, 'roleClaim', 100); const at = Date.now();
  const rec: UnlockAuthorization = { schema: UNLOCK_SCHEMA, manifestSha256: m.manifestSha256, lockDigest: m.lock.lockDigest!, reason, protocolDeviationRef: dev, authorizedBy: { name: c.userId, role: roleClaim, credentialRef: cred }, authorizedAt: new Date(at).toISOString() };
  const authSha = sha(canonical(rec));
  await db.query("UPDATE ocr_study_unlocks SET status = 'authorized', authorized_by = $1, authorizer_role_claim = $2, authorizer_credential_ref = $3, protocol_deviation_ref = $4, authorization_reason = $5, authorized_at = $6, authorization_sha256 = $7, authorized_manifest_sha256 = $8 WHERE id = $9 AND status = 'requested'",
    [c.userId, roleClaim, cred, dev, reason, at, authSha, m.manifestSha256, u.id]);
  await auditStudy(c.userId, 'unlock_authorized', c.ws.id, { datasetId: d.dataset_id, requestId: u.id, authorizationSha256: authSha, authorizedBy: c.userId, requestedBy: u.requested_by, manifestSha256: m.manifestSha256, reasonSha256: sha(reason) });
  res.status(201).json({ requestId: u.id, status: 'authorized', authorizationSha256: authSha, note: 'Single-use. The requester can now execute the unlock; any change to the dataset in between voids it.', notice: STUDY_NOTICE });
}));
router.post('/studies/:id/datasets/:ds/unlock-requests/:rid/execute', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'execute_unlock'); if (!c) return; if (!(await requireFreshAuth(req, res, 'execute_unlock', c.ws.id))) return; const d = await dataset(c, req, res); if (!d) return;
  const u = await db.queryOne<UnlockRow>('SELECT * FROM ocr_study_unlocks WHERE id = $1 AND workspace_id = $2 AND dataset_id = $3', [String(req.params.rid), c.ws.id, d.dataset_id]); if (!u) { fail(res, 404, 'not_found', 'Unlock request not found.'); return; }
  if (u.tenant_id !== c.ws.tenant_id) throw new StudyError('authorization_mismatch', 'The authorization belongs to a different tenant.', 409);
  if (u.requested_by !== c.userId) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'forbidden', perm: 'execute_unlock', requestId: u.id }); fail(res, 403, 'forbidden', 'Only the user who made the request can execute it.'); return; }
  if (u.status === 'executed') throw new StudyError('authorization_already_used', 'This authorization was already used; it cannot be replayed.', 409);
  if (u.status !== 'authorized' || !u.authorized_by || u.authorized_by === c.userId) throw new StudyError('not_authorized', 'The request has not been authorized by a different user.', 409);
  const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id);
  if (m.manifestSha256 !== u.authorized_manifest_sha256 || m.lock.lockDigest !== u.lock_digest) throw new StudyError('authorization_mismatch', 'The authorization is bound to a different manifest or lock digest than the dataset now has.', 409);
  const claim = await db.query("UPDATE ocr_study_unlocks SET status = 'executed', executed_at = $1 WHERE id = $2 AND status = 'authorized' RETURNING id", [Date.now(), u.id]);
  if (!claim.length) throw new StudyError('authorization_already_used', 'This authorization was already used; it cannot be replayed.', 409);
  try { const after = c.svc.unlock(c.actor, c.ws.id, d.dataset_id, authRecord(u)); await auditStudy(c.userId, 'unlocked', c.ws.id, { datasetId: d.dataset_id, requestId: u.id, authorizationSha256: u.authorization_sha256 ?? '', authorizedBy: u.authorized_by, requestedBy: c.userId, manifestSha256: after.manifestSha256 });
    res.json({ lockState: after.lock.state, everUnlocked: after.lock.everUnlocked, epoch: after.lock.epoch, note: 'The dataset is permanently marked as having been unlocked; later reports say so.', notice: STUDY_NOTICE }); }
  catch (e) { await db.query("UPDATE ocr_study_unlocks SET status = 'authorized', executed_at = NULL WHERE id = $1", [u.id]); throw e; }
}));

// ── evaluation and export ──────────────────────────────────────────────────
router.post('/studies/:id/datasets/:ds/evaluations', rateLimit('expensive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'evaluate'); if (!c) return; const d = await dataset(c, req, res); if (!d) return;
  const b = req.body ?? {}; const mode = b.mode; if (mode !== 'development' && mode !== 'locked') throw new StudyError('bad_input', 'mode must be development or locked.');
  if (b.options !== undefined) throw new StudyError('bad_input', 'options are not accepted: thresholds, minimums, tolerance and labels come from the OCR study policy (see /policy).');
  if (mode === 'locked' && !isHex64(b.expectedLockDigest)) { fail(res, 400, 'expected_lock_digest_required', 'A locked evaluation requires expectedLockDigest, recorded outside this system when the lock was made.', { custody: CUSTODY_NOTE }); return; }
  const rs = b.results as { documents?: Array<{ candidates?: unknown[] }> } | undefined; if (!rs || !Array.isArray(rs.documents) || rs.documents.length > LIMITS.maxResultDocuments || rs.documents.reduce((n, x) => n + (Array.isArray(x.candidates) ? x.candidates.length : 0), 0) > LIMITS.maxResultCandidates) throw new StudyError('too_large', 'results must have documents[] within the study limits.', 413);
  const policy = await policyFor(c, d, mode === 'locked' ? 'locked_evaluation' : 'synthetic_tooling');
  const r = c.svc.evaluate(c.actor, c.ws.id, d.dataset_id, { runId: str(b.runId, 'runId', 64), mode, results: b.results, expectLockDigest: mode === 'locked' ? b.expectedLockDigest : undefined, policy });
  await auditStudy(c.userId, mode === 'locked' ? 'locked_evaluation_run' : 'development_evaluation_run', c.ws.id, { datasetId: d.dataset_id, runId: String(b.runId), mode, reportSha256: r.reportSha256, policyVersion: policy.version, policySha256: policy.sha256 }); res.status(201).json({ reportSha256: r.reportSha256, report: r.report, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/datasets/:ds/evaluations/:runId/export', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'export_report'); if (!c) return; if (!(await requireFreshAuth(req, res, 'export_report', c.ws.id))) return; const d = await dataset(c, req, res); if (!d) return;
  const r = c.svc.exportReport(c.actor, c.ws.id, d.dataset_id, String(req.params.runId)); await auditStudy(c.userId, 'report_exported', c.ws.id, { datasetId: d.dataset_id, runId: String(req.params.runId), reportSha256: r.sha256 });
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="ocr-study-report-${String(req.params.runId).replace(/[^A-Za-z0-9._-]/g, '_')}.json"`, 'X-Report-SHA256': r.sha256 }); res.send(r.text);
}));


// ── OCR study policy ─────────────────────────────────────────────────────────
const policyKind = (req: Request) => (String(req.query.kind ?? 'real_study') === 'synthetic_test' ? 'synthetic_test' : 'real_study') as 'synthetic_test' | 'real_study';
const chainId = (c: Ctx, kind: 'synthetic_test' | 'real_study') => (kind === 'synthetic_test' ? pol.syntheticId(c.ws.id) : pol.realId(c.ws.id));
router.get('/studies/:id/policy', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_policy'); if (!c) return; await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const kind = policyKind(req); const h = await pol.history(chainId(c, kind)); const cur = h[h.length - 1];
  res.json({ notice: STUDY_NOTICE, policy: cur, effectiveState: policyAuditReport(cur).policy.effectiveState, versions: h.map((p) => ({ version: p.version, sha256: p.sha256, prevSha256: p.prevSha256, createdBy: p.createdBy, createdAt: p.createdAt })), chainVerified: true, stamp: cur.kind === 'synthetic_test' ? stampOf(viewOf(cur)) : null,
    statement: 'A real-study policy cannot be activated in this build. Presence of a source-reference field is not verification or approval.' });
}));
router.put('/studies/:id/policy', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'edit_policy'); if (!c) return; if (!(await requireFreshAuth(req, res, 'edit_policy', c.ws.id))) return; await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const kind = req.body?.kind === 'synthetic_test' ? 'synthetic_test' : 'real_study';
  if (!req.body?.fields || typeof req.body.fields !== 'object' || Array.isArray(req.body.fields)) throw new StudyError('bad_input', 'fields must be an object of field → {value, sourceRef} (or null to un-configure).');
  const next = await pol.putVersion(chainId(c, kind), { fields: req.body.fields, clinicalLeadDecisionRef: req.body.clinicalLeadDecisionRef, independentReviewRef: req.body.independentReviewRef }, c.userId);
  await auditStudy(c.userId, 'policy_version_saved', c.ws.id, { policyId: next.policyId.slice(-12), policyVersion: next.version, policySha256: next.sha256, kind: next.kind, fieldCount: Object.keys(req.body.fields).length });
  res.status(201).json({ version: next.version, sha256: next.sha256, kind: next.kind, effectiveState: policyAuditReport(next).policy.effectiveState, requiredFieldsUnconfigured: policyAuditReport(next).requiredFieldsUnconfigured, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/policy/activate', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'edit_policy'); if (!c) return; if (!(await requireFreshAuth(req, res, 'edit_policy', c.ws.id))) return; await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const p = await pol.current(pol.realId(c.ws.id));
  await auditStudy(c.userId, 'policy_activation_refused', c.ws.id, { policyVersion: p.version, policySha256: p.sha256 });
  requestActivation(p, { authorizationRef: req.body?.authorizationRef, independentReviewRef: req.body?.independentReviewRef });
}));
router.get('/studies/:id/policy/report', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_policy'); if (!c) return; await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const ds = await db.query<DsRow>('SELECT * FROM ocr_study_datasets WHERE workspace_id = $1', [c.ws.id]);
  const runs: Array<{ runId: string; mode: string; policyVersion: number | null; policySha256: string | null; datasetId: string }> = [];
  for (const d of ds) { const m = c.svc.getManifest(c.actor, c.ws.id, d.dataset_id); for (const o of m.outputs) runs.push({ datasetId: d.dataset_id, runId: o.runId, mode: o.mode, policyVersion: o.policy?.version ?? null, policySha256: o.policy?.sha256 ?? null }); }
  const syn = await pol.current(pol.syntheticId(c.ws.id)); const real = await pol.current(pol.realId(c.ws.id));
  res.json({ notice: STUDY_NOTICE, synthetic: policyAuditReport(syn, runs), realStudy: policyAuditReport(real, []), runs, engineeringDefaultsRemaining: [], note: 'The real-study policy has no effect on any run in this build.' });
}));


// ── draft-policy two-person REVIEW (records metadata + external references only; can never activate or approve anything) ──
interface SubRow { id: string; workspace_id: string; policy_id: string; version: number; policy_sha256: string; submitted_by: string; submitted_at: number }
interface DecRow { id: string; submission_id: string; reviewer_id: string; decision: 'reviewed' | 'changes_requested'; decided_at: number; policy_sha256: string; external_decision_ref: string | null; external_signature_ref: string | null }
const REVIEW_STATEMENT = 'A recorded review is metadata plus external references that this software cannot verify. It does not activate, approve, accept or release anything, and it does not make real-data registration or real-study evaluation available.';
const optRef = (v: unknown, what: string): string | null => { if (v === undefined || v === null || v === '') return null; if (typeof v !== 'string' || v.length > 300) throw new StudyError('bad_input', `${what} must be a string of at most 300 characters.`); return v.trim(); };
router.get('/studies/:id/policy/reviews', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_policy'); if (!c) return; const subs = await db.query<SubRow>('SELECT * FROM ocr_policy_review_submissions WHERE workspace_id = $1 ORDER BY submitted_at DESC LIMIT 100', [c.ws.id]); const out = [];
  for (const sub of subs) { const d = await db.queryOne<DecRow>('SELECT * FROM ocr_policy_review_decisions WHERE submission_id = $1', [sub.id]); out.push({ reviewId: sub.id, policyVersion: sub.version, policySha256: sub.policy_sha256, submittedBy: sub.submitted_by, submittedAt: Number(sub.submitted_at), status: d ? d.decision : 'awaiting_review',
    decision: d ? { reviewer: d.reviewer_id, decision: d.decision, decidedAt: Number(d.decided_at), externalDecisionRef: d.external_decision_ref, externalSignatureRef: d.external_signature_ref, referencesAreVerification: false } : null }); }
  res.json({ notice: STUDY_NOTICE, statement: REVIEW_STATEMENT, reviews: out });
}));
router.post('/studies/:id/policy/reviews', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'edit_policy'); if (!c) return; if (!(await requireFreshAuth(req, res, 'policy_review', c.ws.id))) return;
  await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const p = await pol.current(pol.realId(c.ws.id)); const note = req.body?.note === undefined ? '' : str(req.body.note, 'note', 1000);
  if (await db.queryOne('SELECT 1 AS x FROM ocr_policy_review_submissions WHERE policy_id = $1 AND version = $2', [p.policyId, p.version])) throw new StudyError('already_submitted', 'This policy version was already submitted for review; save a new draft version to submit again.', 409);
  const id = newId('pr-'); await db.query('INSERT INTO ocr_policy_review_submissions (id, workspace_id, policy_id, version, policy_sha256, submitted_by, submitted_at, note_sha256, note_length) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, c.ws.id, p.policyId, p.version, p.sha256, c.userId, Date.now(), sha(note), note.length]);
  await auditStudy(c.userId, 'policy_review_submitted', c.ws.id, { reviewId: id, policyVersion: p.version, policySha256: p.sha256, noteLength: note.length }); res.status(201).json({ reviewId: id, policyVersion: p.version, policySha256: p.sha256, status: 'awaiting_review', next: 'A different study member with a review role records the review.', statement: REVIEW_STATEMENT, notice: STUDY_NOTICE });
}));
router.post('/studies/:id/policy/reviews/:rid/decision', rateLimit('sensitive'), wrap(async (req, res) => {
  const c = await ctx(req, res, 'review_policy'); if (!c) return; if (!(await requireFreshAuth(req, res, 'policy_review', c.ws.id))) return;
  const sub = await db.queryOne<SubRow>('SELECT * FROM ocr_policy_review_submissions WHERE id = $1 AND workspace_id = $2', [String(req.params.rid), c.ws.id]); if (!sub) { fail(res, 404, 'not_found', 'Review not found.'); return; }
  const decision = req.body?.decision; if (decision !== 'reviewed' && decision !== 'changes_requested') throw new StudyError('bad_input', 'decision must be reviewed or changes_requested.');
  const decRef = optRef(req.body?.externalDecisionRef, 'externalDecisionRef'), sigRef = optRef(req.body?.externalSignatureRef, 'externalSignatureRef'); const note = req.body?.note === undefined ? '' : str(req.body.note, 'note', 1000);
  if (decision === 'reviewed' && (!decRef || !sigRef)) throw new StudyError('bad_input', 'A "reviewed" decision needs externalDecisionRef and externalSignatureRef (references to records kept outside this software; recorded, not verified).');
  if (await db.queryOne('SELECT 1 AS x FROM ocr_policy_review_decisions WHERE submission_id = $1', [sub.id])) throw new StudyError('review_already_decided', 'This review was already decided; a decision cannot be replayed or changed.', 409);
  const hist = await pol.history(sub.policy_id); const ver = hist.find((h) => h.version === sub.version);                                     // throws policy_tampered on a broken chain
  if (!ver || ver.sha256 !== sub.policy_sha256) throw new PolicyError('policy_tampered', 'the submitted policy version no longer matches its recorded hash');
  if (sub.submitted_by === c.userId || ver.createdBy === c.userId) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'reviewer_must_differ', perm: 'review_policy', reviewId: sub.id }); fail(res, 403, 'reviewer_must_differ', 'The reviewer must be a different study member from the person who submitted the draft and from the person who saved that draft version.'); return; }
  if (hist[hist.length - 1].sha256 !== sub.policy_sha256) { await auditStudy(c.userId, 'denied', c.ws.id, { code: 'stale_policy_review', perm: 'review_policy', reviewId: sub.id }); throw new StudyError('stale_policy_review', 'The policy changed after it was submitted; this review applies to an older version. Submit the current version.', 409); }
  const id = newId('pd-'); try { await db.query('INSERT INTO ocr_policy_review_decisions (id, submission_id, reviewer_id, decision, decided_at, policy_sha256, external_decision_ref, external_signature_ref, note_sha256, note_length) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, sub.id, c.userId, decision, Date.now(), sub.policy_sha256, decRef, sigRef, sha(note), note.length]); }
  catch (e) { if (/duplicate key|unique/i.test(String((e as Error).message))) throw new StudyError('review_already_decided', 'This review was already decided; a decision cannot be replayed or changed.', 409); throw e; }
  await auditStudy(c.userId, 'policy_review_decided', c.ws.id, { reviewId: sub.id, decision, policyVersion: sub.version, policySha256: sub.policy_sha256, noteLength: note.length });
  res.status(201).json({ reviewId: sub.id, decision, policyVersion: sub.version, effectiveState: 'draft — not effective (activation blocked)', referencesAreVerification: false, statement: REVIEW_STATEMENT, notice: STUDY_NOTICE });
}));
router.get('/studies/:id/policy/readiness', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_policy'); if (!c) return; await pol.ensureWorkspacePolicies(c.ws.id, c.userId); const p = await pol.current(pol.realId(c.ws.id));
  const sub = await db.queryOne<SubRow>('SELECT * FROM ocr_policy_review_submissions WHERE policy_id = $1 AND version = $2', [p.policyId, p.version]); const dec = sub ? await db.queryOne<DecRow>('SELECT * FROM ocr_policy_review_decisions WHERE submission_id = $1', [sub.id]) : undefined;
  const st: ReviewState = { submitted: !!sub, decision: dec?.decision ?? null, policySha256: sub?.policy_sha256 ?? null, externalDecisionRef: dec?.external_decision_ref ?? null, externalSignatureRef: dec?.external_signature_ref ?? null };
  res.json({ notice: STUDY_NOTICE, ...readinessReport(p, st) });
}));

// ── audit ──────────────────────────────────────────────────────────────────
router.get('/studies/:id/audit', wrap(async (req, res) => {
  const c = await ctx(req, res, 'view_audit'); if (!c) return; const pg = page(req);
  const rows = await db.query('SELECT ts, actor_id, action, meta FROM audit_events WHERE target_type = $1 AND target_id = $2 ORDER BY ts DESC, id DESC LIMIT $3 OFFSET $4', ['ocr_study', c.ws.id, pg.limit, pg.offset]);
  res.json({ notice: STUDY_NOTICE, note: 'Audit entries hold identifiers, hashes and counts only — never document or annotation content.', ...pg, fileStoreChain: c.svc.verifyAuditLog(c.actor, c.ws.id),
    events: rows.map((r: { ts: number; actor_id: string; action: string; meta: string | null }) => ({ ts: Number(r.ts), actor: r.actor_id, action: r.action, meta: r.meta ? JSON.parse(r.meta) : {} })) });
}));

export default router;
