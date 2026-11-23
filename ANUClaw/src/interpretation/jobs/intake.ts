/**
 * Intake of an interpretation request (interpretation engine, P3a): validate, split identity off, store, enqueue.
 *
 * Everything that must hold together happens in ONE transaction: the job row, the immutable source payload (identity
 * removed), the sealed identity and the audit entry. Idempotency is decided by the database: a unique
 * (tenant_id, idempotency_key) index means two simultaneous requests with one key can never both create a job. The
 * stored request fingerprint distinguishes a true retry (same body: the original job is returned) from key misuse
 * (different body: 409).
 */
import * as crypto from 'crypto';
import { db } from '../../db';
import { canonicalize, contentHash } from '../../cds/hashing';
import type { Tenant } from '../../api/tenant-store';
import { TenancyError } from '../tenancy/keys';
import { AuditCtx, ensureTenantAuditReady, recordTenantEvent } from '../tenancy/audit';
import { checkSkillAccess } from '../skills/registry';
import { getAdapterImplementation } from '../adapters';
import { AdapterError, type StoredRequest } from '../adapters/types';
import { validateInterpretationRequest } from '../contracts/validate';
import { VaultError, currentVaultKey, sealIdentity } from './vault';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

export interface JobView {
  id: string; status: string; skillId: string; analysisType: string; subjectRef: string | null; capturedAt: string | null;
  attempts: number; errorCode: string | null; originalPayloadSha256: string | null; findingsSha256: string | null;
  adapter: { id: string; version: string } | null; createdAt: number; updatedAt: number; completedAt: number | null;
}

export function toJobView(r: any): JobView {
  return {
    id: r.id, status: r.status, skillId: r.skill_id, analysisType: r.analysis_type, subjectRef: r.status === 'erased' ? null : r.subject_ref, capturedAt: r.status === 'erased' ? null : r.captured_at,
    attempts: Number(r.attempts), errorCode: r.error_code ?? null, originalPayloadSha256: r.original_payload_sha256 ?? null,
    findingsSha256: r.findings_sha256 ?? null, adapter: r.adapter_id ? { id: r.adapter_id, version: r.adapter_version } : null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), completedAt: r.completed_at == null ? null : Number(r.completed_at),
  };
}

export interface IntakeResult { job: JobView; replayed: boolean }

export async function acceptInterpretation(tenant: Tenant, body: unknown, idempotencyKey: string | undefined, ctx: AuditCtx, now = Date.now()): Promise<IntakeResult> {
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new TenancyError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-200 safe characters.');
  }
  const v = validateInterpretationRequest(body);
  if (!v.ok) throw new TenancyError(400, 'validation_failed', 'The request does not match interpretation-request/v1.', v.errors);
  const req = body as StoredRequest & { subject: StoredRequest['subject'] & { identity?: Record<string, unknown> } };

  const keys = new Set<string>();
  for (const f of req.findings ?? []) {
    if (keys.has(f.key)) throw new TenancyError(400, 'validation_failed', `Duplicate finding key "${f.key}".`);
    keys.add(f.key);
  }

  const access = await checkSkillAccess(tenant, req.skillId);
  if (!access.ok) throw new TenancyError(access.status, access.code, access.message);
  const manifest = access.skill.manifest as { acceptsAnalysisTypes?: string[]; adapterId?: string };
  if (!manifest.acceptsAnalysisTypes?.includes(req.analysisType)) {
    throw new TenancyError(400, 'analysis_type_not_accepted', 'This skill does not accept that analysisType.');
  }
  const adapter = manifest.adapterId ? getAdapterImplementation(manifest.adapterId) : undefined;
  if (!adapter) throw new TenancyError(503, 'skill_unavailable', 'This skill is not available yet.');
  // Each skill reads exactly one input form: generic findings, or the tenant's native payload.
  if (adapter.input === 'findings' && req.findings === undefined) throw new TenancyError(400, 'input_form_not_accepted', 'This skill needs generic `findings`.');
  if (adapter.input === 'findings' && req.nativePayload !== undefined) throw new TenancyError(400, 'input_form_not_accepted', 'This skill does not accept a nativePayload; send generic `findings`.');
  if (adapter.input === 'native' && req.findings !== undefined) throw new TenancyError(400, 'input_form_not_accepted', 'This skill does not accept generic `findings`; send its nativePayload.');
  if (adapter.input === 'native' && req.nativePayload === undefined) throw new TenancyError(400, 'input_form_not_accepted', 'This skill needs a nativePayload.');

  // Split identity off BEFORE anything is stored, hashed or queued.
  const { identity, ...subjectRest } = req.subject;
  let stored: StoredRequest = { ...req, subject: subjectRest };
  if (adapter.prepare) {
    // Native input is verified here, where secrets and the clock are available; a refusal reaches the tenant immediately.
    try { stored = adapter.prepare(stored); } catch (e) {
      if (e instanceof AdapterError) throw new TenancyError(e.status, e.code, e.message, e.details);
      throw e;
    }
  }
  const payloadJson = JSON.stringify(stored);
  const payloadSha = contentHash(stored);

  const hasIdentity = identity !== undefined && Object.keys(identity).length > 0;
  if (hasIdentity) {
    try { currentVaultKey(); } catch (e) {
      if (e instanceof VaultError) throw new TenancyError(503, 'identity_storage_unavailable', 'Identity storage is not configured; send the request without subject.identity or ask the platform administrator.');
      throw e;
    }
  }

  // The idempotency fingerprint covers the WHOLE body, identity included. A plain hash of a name or email could be tested
  // against guesses, so when identity is present it is keyed (HMAC under a key derived from the vault key); an
  // identity-free body has nothing to guess and keeps the plain hash.
  const fingerprint = hasIdentity
    ? crypto.createHmac('sha256', currentVaultKey().key).update(`idempotency-fingerprint|${canonicalize(body)}`, 'utf8').digest('hex')
    : contentHash(body);

  await ensureTenantAuditReady();
  const id = `job_${crypto.randomBytes(12).toString('hex')}`;
  return db.transaction(async (tx) => {
    const ins = await tx.query(
      `INSERT INTO interpretation_jobs (id, tenant_id, skill_id, analysis_type, subject_ref, idempotency_key, request_fingerprint, status, run_after, captured_at, original_payload_sha256, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$8,$8)
       ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
      [id, tenant.tenant_id, req.skillId, req.analysisType, req.subject.externalRef, idempotencyKey ?? null, fingerprint, now, req.acquisition.capturedAt, payloadSha]);
    if (!ins.rows.length) {
      const prior = await tx.query('SELECT * FROM interpretation_jobs WHERE tenant_id = $1 AND idempotency_key = $2', [tenant.tenant_id, idempotencyKey]);
      const row = prior.rows[0];
      if (!row) throw new TenancyError(409, 'idempotency_conflict', 'Idempotency-Key conflict; retry.');
      if (row.request_fingerprint !== fingerprint) throw new TenancyError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request body.');
      return { job: toJobView(row), replayed: true };
    }
    await tx.query(`INSERT INTO source_payloads (job_id, tenant_id, schema_version, payload_json, payload_sha256, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, tenant.tenant_id, stored.schemaVersion, payloadJson, payloadSha, now]);
    if (hasIdentity) {
      // Re-seal with the real job id so the ciphertext is bound to this job.
      const s = sealIdentity(tenant.tenant_id, id, identity!);
      await tx.query(`INSERT INTO identity_vault (job_id, tenant_id, subject_ref, kid, sealed, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, tenant.tenant_id, req.subject.externalRef, s.kid, s.sealed, now]);
    }
    // Audit carries ids and hashes only: no identity, no values, no subject reference.
    await recordTenantEvent(tx, tenant.tenant_id, ctx, 'interpretation.accepted', { job_id: id, skill_id: req.skillId, original_payload_sha256: payloadSha, identity_stored: hasIdentity });
    return { job: toJobView(ins.rows[0]), replayed: false };
  });
}
