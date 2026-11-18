/**
 * OCR-study access control (study tooling only; synthetic data). Membership and roles live in PostgreSQL and are the ONLY source of authority:
 * the caller's identity comes from the verified dashboard session, never from the request body (bodies carrying identity/tenant/role/lock fields are refused).
 * One study role per user per study (least privilege): the roles below cannot be combined, so no one can both annotate and adjudicate, or hold data and approve its unlock.
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { Role } from '../../validation/study/workspace';

export const STUDY_ROLES = ['study_owner', 'dataset_custodian', 'annotator', 'adjudicator', 'statistician', 'clinical_lead', 'auditor'] as const;
export type StudyRole = typeof STUDY_ROLES[number];
/** Dashboard account roles that may use study routes at all (viewer accounts cannot). The study role then decides everything. */
export const DASH_ROLES_ALLOWED = ['admin', 'operator', 'clinician', 'auditor', 'compliance'];

export type Perm = 'view_study' | 'manage_members' | 'configure_severity' | 'register_dataset' | 'attest' | 'manifest' | 'view_manifest' | 'verify' | 'list_cases' | 'read_source'
  | 'import_annotations' | 'own_annotations' | 'agreement_summary' | 'review_queue' | 'adjudicate' | 'build_truth' | 'lock' | 'request_unlock' | 'authorize_unlock' | 'execute_unlock'
  | 'evaluate' | 'export_report' | 'view_audit' | 'view_members' | 'approve_member_action' | 'view_policy' | 'edit_policy' | 'review_policy';
export const MATRIX: Record<Perm, StudyRole[]> = {
  view_study: [...STUDY_ROLES],
  manage_members: ['study_owner'],
  configure_severity: ['clinical_lead'],
  register_dataset: ['dataset_custodian'], attest: ['dataset_custodian'], manifest: ['dataset_custodian'], build_truth: ['dataset_custodian'], lock: ['dataset_custodian'],
  request_unlock: ['dataset_custodian'], execute_unlock: ['dataset_custodian'],
  authorize_unlock: ['study_owner', 'clinical_lead'],
  view_manifest: ['study_owner', 'dataset_custodian', 'statistician', 'clinical_lead', 'auditor'],
  verify: ['study_owner', 'dataset_custodian', 'statistician', 'clinical_lead', 'auditor'],
  list_cases: ['annotator', 'dataset_custodian'], read_source: ['annotator', 'dataset_custodian'],
  import_annotations: ['annotator'], own_annotations: ['annotator'],
  agreement_summary: ['statistician', 'clinical_lead', 'study_owner'],
  review_queue: ['adjudicator'], adjudicate: ['adjudicator'],
  evaluate: ['statistician'],
  export_report: ['statistician', 'clinical_lead', 'study_owner', 'auditor'],
  view_audit: ['auditor', 'study_owner'],
  view_members: ['study_owner', 'clinical_lead', 'auditor'],
  view_policy: ['study_owner', 'clinical_lead', 'statistician', 'auditor', 'dataset_custodian'],
  edit_policy: ['study_owner', 'clinical_lead', 'statistician'],
  review_policy: ['study_owner', 'clinical_lead', 'statistician'],
  approve_member_action: ['study_owner', 'clinical_lead'],
};
/** Internal file-store roles for each study role (the file store re-checks, so a policy mistake here is not the only line of defence). */
export const INTERNAL_ROLES: Record<StudyRole, Role[]> = { study_owner: ['analyst'], dataset_custodian: ['owner'], annotator: ['annotator'], adjudicator: ['adjudicator'], statistician: ['analyst'], clinical_lead: ['analyst'], auditor: ['analyst'] };

export const FORBIDDEN_BODY_KEYS = ['userId', 'user_id', 'actorId', 'tenantId', 'tenant_id', 'role', 'studyRoleOverride', 'lockState', 'lock_state', 'lock', 'accepted', 'acceptance'];
/** Request bodies may not carry identity, tenant, role or lock-state claims. Returns the offending key, if any (checked at the top level and in `file`/`options`). */
export function forbiddenField(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const k of FORBIDDEN_BODY_KEYS) if (k in b) return k;
  for (const nested of ['options', 'record', 'authorization']) { const v = b[nested]; if (v && typeof v === 'object') for (const k of FORBIDDEN_BODY_KEYS) if (k in (v as object)) return `${nested}.${k}`; }
  return null;
}

export interface StudyRow { id: string; tenant_id: string; name: string; purpose: string; created_by: string; created_at: number; severity_map_json: string; severity_set_by: string | null; severity_set_at: number | null }
export async function loadMembership(userId: string, wsId: string): Promise<{ ws: StudyRow; role: StudyRole } | null> {
  if (!/^w-[0-9a-f]{12}$/.test(wsId)) return null;
  const row = await db.queryOne<StudyRow & { study_role: StudyRole }>(
    `SELECT w.*, m.study_role FROM ocr_study_workspaces w JOIN ocr_study_members m ON m.workspace_id = w.id WHERE w.id = $1 AND m.user_id = $2 AND m.status = 'active'`, [wsId, userId]);
  if (!row) return null; const { study_role, ...ws } = row; return { ws, role: study_role };
}
export const tenantOf = (user: { id: string }) => `dashboard:${user.id}`;
export const can = (role: StudyRole, perm: Perm) => MATRIX[perm].includes(role);

const SAFE_VALUE = /^[A-Za-z0-9._:@/+=-]{0,200}$/;
const SAFE_KEYS = new Set(['datasetId', 'runId', 'caseId', 'queueId', 'requestId', 'authorizationId', 'role', 'studyRole', 'memberId', 'mode', 'split', 'provenanceKind', 'count', 'manifestSha256', 'lockDigest', 'reportSha256',
  'recordSha256', 'authorizationSha256', 'reasonSha256', 'reasonLength', 'authorizedBy', 'requestedBy', 'code', 'perm', 'sha256', 'version', 'source', 'field', 'ok', 'openDisagreements', 'sources', 'severityMapSha256', 'limit', 'bucket', 'policy', 'status', 'action', 'targetId', 'approvedBy', 'ageSeconds', 'policyId', 'policyVersion', 'policySha256', 'kind', 'fieldCount', 'decision', 'reviewId', 'noteLength']);
/** Audit metadata is an allow-list of identifiers, hashes and counts. Anything else is dropped, and a value that is not a plain token is dropped too. */
export function safeMeta(meta: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) { if (!SAFE_KEYS.has(k)) continue; if (typeof v === 'number' || typeof v === 'boolean') out[k] = v; else if (typeof v === 'string' && SAFE_VALUE.test(v)) out[k] = v; }
  return out;
}
export async function auditStudy(actorId: string, action: string, wsId: string, meta: Record<string, unknown> = {}): Promise<void> {
  await db.query(`INSERT INTO audit_events (ts, action, actor_id, actor_type, channel, group_id, target_type, target_id, meta) VALUES ($1, $2, $3, 'dashboard_user', 'dashboard', NULL, 'ocr_study', $4, $5)`,
    [Date.now(), `ocr_study.${action}`, actorId, wsId, JSON.stringify(safeMeta(meta))]);
}
export const newId = (prefix: string) => `${prefix}${crypto.randomBytes(6).toString('hex')}`;
export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Suspending/removing these roles needs a second, different authorized actor. */
export const TWO_PERSON_ROLES: StudyRole[] = ['dataset_custodian', 'clinical_lead'];
export type MemberStatus = 'active' | 'suspended' | 'removed';
export async function activeOwnerCount(wsId: string, excludingUserId?: string): Promise<number> {
  const r = await db.queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ocr_study_members WHERE workspace_id = $1 AND study_role = 'study_owner' AND status = 'active' AND ($2::text IS NULL OR user_id <> $2)`, [wsId, excludingUserId ?? null]);
  return Number(r?.n ?? 0);
}
