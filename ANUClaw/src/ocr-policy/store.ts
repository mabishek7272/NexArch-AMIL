/** PostgreSQL store for OCR study-policy records: immutable versions, hash chain per policy id, tamper detection on every load. */
import { db } from '../db';
import { blankRealPolicy, FIELD_KEYS, Policy, PolicyContent, PolicyError, policyHash, SYNTHETIC_LABEL, seal, syntheticPolicy, validateFieldValue, FieldState } from './policy';

export const syntheticId = (wsId: string) => `${wsId}:synthetic`;
export const realId = (wsId: string) => `${wsId}:real`;
interface Row { policy_id: string; version: number; workspace_id: string; kind: string; content_json: string; sha256: string; prev_sha256: string | null }
const insert = (p: Policy, wsId: string) => db.query('INSERT INTO ocr_policies (policy_id, version, workspace_id, kind, state, content_json, sha256, prev_sha256, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [p.policyId, p.version, wsId, p.kind, 'draft', JSON.stringify(contentOf(p)), p.sha256, p.prevSha256, p.createdBy, Date.parse(p.createdAt)]);
const contentOf = (p: Policy): PolicyContent => { const { sha256, ...c } = p; void sha256; return c; };

/** Creates version 1 of the synthetic-test chain and the blank real-study chain (idempotent). */
export async function ensureWorkspacePolicies(wsId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  for (const p of [syntheticPolicy(syntheticId(wsId), userId, now), blankRealPolicy(realId(wsId), userId, now)]) {
    const ex = await db.queryOne('SELECT 1 AS x FROM ocr_policies WHERE policy_id = $1 AND version = 1', [p.policyId]); if (!ex) await insert(p, wsId);
  }
}
function verifyRow(r: Row, prev: Row | null): Policy {
  const c = JSON.parse(r.content_json) as PolicyContent;
  if (policyHash(c) !== r.sha256 || c.policyId !== r.policy_id || c.version !== r.version) throw new PolicyError('policy_tampered', `policy ${r.policy_id}@${r.version} no longer matches its recorded hash`);
  if ((prev?.sha256 ?? null) !== (r.prev_sha256 ?? null) || (c.prevSha256 ?? null) !== (r.prev_sha256 ?? null)) throw new PolicyError('policy_tampered', `policy ${r.policy_id}@${r.version} breaks the version chain`);
  return { ...c, sha256: r.sha256 };
}
/** All versions, oldest first, each verified against its hash and the chain. Throws PolicyError('policy_tampered') on any mismatch. */
export async function history(policyId: string): Promise<Policy[]> {
  const rows = await db.query<Row>('SELECT policy_id, version, workspace_id, kind, content_json, sha256, prev_sha256 FROM ocr_policies WHERE policy_id = $1 ORDER BY version', [policyId]); const out: Policy[] = []; let prev: Row | null = null;
  for (const r of rows) { out.push(verifyRow(r, prev)); prev = r; } return out;
}
export async function current(policyId: string): Promise<Policy> { const h = await history(policyId); if (!h.length) throw new PolicyError('policy_missing', 'no such policy'); return h[h.length - 1]; }
export async function version(policyId: string, v: number): Promise<Policy> { const p = (await history(policyId)).find((x) => x.version === v); if (!p) throw new PolicyError('policy_missing', `no such policy version ${policyId}@${v}`); return p; }

export type FieldInput = { value: unknown; sourceRef?: string };
/** Appends a new draft version with the supplied fields changed. A real-study field needs a source-reference string (presence is NOT verification); a synthetic field always carries the synthetic label. */
export async function putVersion(policyId: string, input: { fields: Record<string, FieldInput | null>; clinicalLeadDecisionRef?: string | null; independentReviewRef?: string | null }, userId: string): Promise<Policy> {
  const base = await current(policyId); const problems: string[] = []; const fields: Record<string, FieldState> = { ...base.fields }; const now = new Date().toISOString();
  for (const [k, f] of Object.entries(input.fields ?? {})) {
    if (!FIELD_KEYS.includes(k)) { problems.push(`unknown field ${k}`); continue; }
    if (f === null) { fields[k] = { status: 'unconfigured' }; continue; }       // un-configuring is allowed on a draft
    for (const pr of validateFieldValue(k, f.value)) problems.push(`${k}: ${pr}`);
    let ref = f.sourceRef?.trim() ?? ''; if (base.kind === 'synthetic_test') ref = SYNTHETIC_LABEL; else if (!ref || ref.length > 500) problems.push(`${k}: a real-study field needs a source reference (1–500 chars); it is recorded, not verified`);
    fields[k] = { status: 'configured', value: f.value, sourceRef: ref, setBy: userId, setAt: now };
  }
  for (const r of [input.clinicalLeadDecisionRef, input.independentReviewRef]) if (r !== undefined && r !== null && (typeof r !== 'string' || r.length > 300)) problems.push('references must be strings of at most 300 characters');
  if (problems.length) throw new PolicyError('policy_invalid', problems.slice(0, 15).join('; '));
  const next = seal({ ...contentOf(base), version: base.version + 1, fields, clinicalLeadDecisionRef: input.clinicalLeadDecisionRef !== undefined ? input.clinicalLeadDecisionRef : base.clinicalLeadDecisionRef, independentReviewRef: input.independentReviewRef !== undefined ? input.independentReviewRef : base.independentReviewRef, prevSha256: base.sha256, createdBy: userId, createdAt: now });
  const wsId = (await db.queryOne<{ workspace_id: string }>('SELECT workspace_id FROM ocr_policies WHERE policy_id = $1 LIMIT 1', [policyId]))!.workspace_id;
  try { await insert(next, wsId); } catch (e) { if (/duplicate key/i.test(String((e as Error).message))) throw new PolicyError('policy_conflict', 'another version was written concurrently; reload and retry'); throw e; }
  return next;
}
