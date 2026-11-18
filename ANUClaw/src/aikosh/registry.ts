/** PostgreSQL-backed AIKosh registry: immutable inventory snapshots, immutable approval records, an append-only hash-chained decision log, and the use checker. */
import * as crypto from 'crypto';
import { db } from '../db';
import { canonical } from '../validation/study/manifest';
import { identityOf, Inventory, InventoryFile } from './inventory';
import { ApprovalRecord, Decision, evaluateUse, FileIdentity, Use, UseCheck, USES, validateApprovalContent } from './policy';

export class RegistryError extends Error { constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'RegistryError'; } }
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const zero = '0'.repeat(64);
export const APPROVER_ROLES = ['admin', 'compliance'];

export async function syncInventory(inv: Inventory, userId: string): Promise<{ registered: number; unchanged: number }> {
  let registered = 0, unchanged = 0;
  for (const f of inv.files) {
    const r = await db.query('INSERT INTO aikosh_files (path, sha256, size_bytes, format, row_count, inventory_json, registered_at, registered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (path, sha256) DO NOTHING RETURNING path', [f.path, f.sha256, f.sizeBytes, f.format, f.rowCount, JSON.stringify(f), Date.now(), userId]);
    if (r.length) registered++; else unchanged++;
  }
  return { registered, unchanged };
}
export async function registeredFile(path: string, sha256?: string): Promise<InventoryFile | null> {
  const row = await db.queryOne<{ inventory_json: string }>(sha256 ? 'SELECT inventory_json FROM aikosh_files WHERE path = $1 AND sha256 = $2' : 'SELECT inventory_json FROM aikosh_files WHERE path = $1 ORDER BY registered_at DESC LIMIT 1', sha256 ? [path, sha256] : [path]);
  return row ? (JSON.parse(row.inventory_json) as InventoryFile) : null;
}

export type ApprovalInput = Omit<ApprovalRecord, 'id' | 'recordedBy'>;
export async function recordApproval(input: ApprovalInput, userId: string, userRole: string): Promise<{ id: string; contentSha256: string }> {
  if (!APPROVER_ROLES.includes(userRole)) throw new RegistryError('forbidden', 'Only admin or compliance accounts may record data approvals.', 403);
  const problems = validateApprovalContent(input); if (problems.length) throw new RegistryError('incomplete_approval', problems.join('; '));
  const file = await registeredFile(input.path, input.sha256); if (!file) throw new RegistryError('unknown_file', 'The file (at this exact SHA-256) is not in the registry; sync the inventory first.', 404);
  const content = { ...input, permittedUses: [...input.permittedUses].sort(), licencePermitsUses: [...input.licencePermitsUses].sort(), externalFieldsReleased: [...(input.externalFieldsReleased ?? [])].sort() };
  const id = `ap-${crypto.randomBytes(6).toString('hex')}`; const cj = canonical(content);
  await db.query('INSERT INTO aikosh_approval_records (id, path, sha256, recorded_by, recorded_at, content_json, content_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, input.path, input.sha256, userId, Date.now(), cj, sha(cj)]);
  return { id, contentSha256: sha(cj) };
}
export async function decide(recordId: string, decision: 'approve' | 'revoke', userId: string, userRole: string, reason: string): Promise<{ hash: string }> {
  if (!APPROVER_ROLES.includes(userRole)) throw new RegistryError('forbidden', 'Only admin or compliance accounts may decide on data approvals.', 403);
  if (!reason?.trim()) throw new RegistryError('bad_input', 'A reason is required.');
  const rec = await db.queryOne<{ id: string; recorded_by: string }>('SELECT id, recorded_by FROM aikosh_approval_records WHERE id = $1', [recordId]); if (!rec) throw new RegistryError('not_found', 'No such approval record.', 404);
  if (decision === 'approve' && rec.recorded_by === userId) throw new RegistryError('approver_must_differ', 'The approver must be a different person from the person who recorded the approval.', 403);
  const last = await db.queryOne<{ hash: string; decision: string }>('SELECT hash, decision FROM aikosh_approval_decisions WHERE record_id = $1 ORDER BY decided_at DESC, id DESC LIMIT 1', [recordId]);
  if (decision === 'approve' && last?.decision === 'approve') throw new RegistryError('already_approved', 'Already approved.', 409);
  if (decision === 'revoke' && last?.decision !== 'approve') throw new RegistryError('not_approved', 'Only an approved record can be revoked. Approvals cannot be reinstated; record a new one.', 409);
  if (decision === 'approve' && last?.decision === 'revoke') throw new RegistryError('revoked', 'A revoked approval cannot be approved again; record a new one.', 409);
  const base = { id: `dc-${crypto.randomBytes(6).toString('hex')}`, record_id: recordId, decision, decided_by: userId, decided_at: Date.now(), reason_sha256: sha(reason), reason_length: reason.length, prev_hash: last?.hash ?? zero };
  const hash = sha(canonical(base));
  await db.query('INSERT INTO aikosh_approval_decisions (id, record_id, decision, decided_by, decided_at, reason_sha256, reason_length, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [base.id, recordId, decision, userId, base.decided_at, base.reason_sha256, base.reason_length, base.prev_hash, hash]);
  return { hash };
}
interface Loaded { approval: ApprovalRecord; latest: Decision | null }
async function loadApprovals(path: string): Promise<Loaded[]> {
  const recs = await db.query<{ id: string; recorded_by: string; content_json: string; content_sha256: string }>('SELECT id, recorded_by, content_json, content_sha256 FROM aikosh_approval_records WHERE path = $1 ORDER BY recorded_at DESC', [path]); const out: Loaded[] = [];
  for (const r of recs) {
    if (sha(r.content_json) !== r.content_sha256) continue;                                                              // a tampered record is ignored (fails closed)
    const d = await db.queryOne<{ decision: 'approve' | 'revoke'; decided_by: string; decided_at: string }>('SELECT decision, decided_by, decided_at FROM aikosh_approval_decisions WHERE record_id = $1 ORDER BY decided_at DESC, id DESC LIMIT 1', [r.id]);
    out.push({ approval: { ...(JSON.parse(r.content_json) as ApprovalRecord), id: r.id, recordedBy: r.recorded_by }, latest: d ? { decision: d.decision, decidedBy: d.decided_by, decidedAt: Number(d.decided_at) } : null });
  }
  return out;
}
/** The registry-backed UseChecker: passes if ANY record for this exact file hash allows the use. */
export async function checkUse(file: FileIdentity, currentSha256: string, use: Use, fields: string[] = []): Promise<UseCheck> {
  if (!USES.includes(use)) return { allowed: false, status: 'unknown_use', reasons: [`unknown use "${use}"`], blockedFields: [] };
  const loaded = await loadApprovals(file.path); let best: UseCheck | null = null;
  for (const l of loaded.length ? loaded : [{ approval: null, latest: null } as { approval: ApprovalRecord | null; latest: Decision | null }]) { const c = evaluateUse(file, currentSha256, use, l.approval, l.latest, fields); if (c.allowed) return c; best = best ?? c; }
  return best!;
}
export async function verifyDecisionChain(recordId: string): Promise<{ ok: boolean; entries: number }> {
  const rows = await db.query<{ id: string; record_id: string; decision: string; decided_by: string; decided_at: string; reason_sha256: string; reason_length: number; prev_hash: string; hash: string }>('SELECT * FROM aikosh_approval_decisions WHERE record_id = $1 ORDER BY decided_at, id', [recordId]); let prev = zero;
  for (const r of rows) { const { hash, ...rest } = r; const base = { id: rest.id, record_id: rest.record_id, decision: rest.decision, decided_by: rest.decided_by, decided_at: Number(rest.decided_at), reason_sha256: rest.reason_sha256, reason_length: rest.reason_length, prev_hash: rest.prev_hash }; if (rest.prev_hash !== prev || sha(canonical(base)) !== hash) return { ok: false, entries: rows.length }; prev = hash; }
  return { ok: true, entries: rows.length };
}
export async function listRegistry(inv: Inventory) {
  const out = [];
  for (const f of inv.files) { const loaded = await loadApprovals(f.path); const id = identityOf(f);
    out.push({ path: f.path, sha256: f.sha256, approvals: loaded.map((l) => ({ id: l.approval.id, appliesToCurrentBytes: l.approval.sha256 === f.sha256, recordedBy: l.approval.recordedBy, permittedUses: l.approval.permittedUses, sensitivity: l.approval.sensitivity, externalProcessing: l.approval.externalProcessing, state: l.latest?.decision ?? 'awaiting_second_person', decidedBy: l.latest?.decidedBy ?? null })),
      restrictedFields: [...id.narrativeColumns, ...id.identifierColumns] }); }
  return out;
}
