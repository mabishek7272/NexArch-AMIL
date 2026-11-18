/**
 * Pluggable storage for the OCR-study workspace layer.
 *
 *   local_synthetic  the ONLY implemented adapter. Files under an explicitly configured directory (ANUCLAW_STUDY_LOCAL_ROOT; there is no default).
 *                    Allowed only outside production, and only for SYNTHETIC datasets (provenanceKind synthetic_fixture): it provides no
 *                    encryption at rest, retention enforcement or independent access control beyond file permissions.
 *   object_store     the PRODUCTION contract (StudyObjectStore below). No implementation ships in this repository. Selecting it requires every setting
 *                    in OBJECT_STORE_REQUIRED; even when all are present the factory still refuses (`not_implemented`) — it never falls back to local
 *                    files, never guesses defaults and never contacts a provider. No cloud credentials, buckets or uploads exist in this repository.
 *
 * Fail-closed rule: when the configuration is missing, invalid or production-unsafe, `createStudyStorage` returns `{ ready: false, reasons }` and every
 * study route answers 503 `study_storage_unavailable`. Nothing is written anywhere.
 */
export interface StorePrincipal { tenantId: string; userId: string }
export interface PutResult { versionId: string; sha256: string; encryption: { algorithm: string; keyRef: string } }
export interface StoreAuditEvent { at: number; action: string; tenantId: string; userId: string; key?: string; versionId?: string; outcome: 'ok' | 'denied' | 'error' }
/**
 * The production object-store CONTRACT. No implementation ships. Any future implementation must pass `runObjectStoreContract`
 * (src/validation/study/object-store-contract.ts); passing it against the in-memory fake proves only that the contract is checkable, never that a real store is safe.
 */
export interface StudyObjectStore {
  /** Immutable put: every write creates a new version; an existing version is never overwritten. The write becomes visible atomically and only if the checksum matches. */
  put(p: StorePrincipal, key: string, bytes: Buffer, meta: { sha256: string; retainUntil: string }): Promise<PutResult>;
  /** Verifies the stored checksum before returning bytes; a mismatch must throw. Another tenant's key must behave as not found. */
  get(p: StorePrincipal, key: string, versionId?: string): Promise<Buffer>;
  list(p: StorePrincipal, prefix: string): Promise<string[]>;
  versions(p: StorePrincipal, key: string): Promise<Array<{ versionId: string; sha256: string; encryption: PutResult['encryption'] }>>;
  /** Retention can only be extended, never shortened. */
  setRetention(p: StorePrincipal, key: string, versionId: string, retainUntil: string): Promise<void>;
  placeHold(p: StorePrincipal, key: string, versionId: string): Promise<void>;
  releaseHold(p: StorePrincipal, key: string, versionId: string): Promise<void>;
  /** Refused while retention has not expired or a hold exists. */
  delete(p: StorePrincipal, key: string, versionId: string): Promise<void>;
  /** Time-limited access token for ONE key version; expires and can be revoked. */
  signAccess(p: StorePrincipal, key: string, versionId: string, ttlSeconds: number): Promise<{ token: string; expiresAt: number }>;
  fetchSigned(token: string): Promise<Buffer>;
  /** Revokes a user's access (including their outstanding signed tokens) immediately. */
  revokeAccess(tenantId: string, userId: string): Promise<void>;
  /** Every operation, allowed or refused, is recorded. */
  auditEvents(): Promise<StoreAuditEvent[]>;
}
/** What an object-store deployment MUST provide before it may hold a real study (checked by configuration, enforced by the store). */
export const OBJECT_STORE_REQUIRED = {
  ANUCLAW_STUDY_OBJECT_STORE: 'identifier of the configured provider/adapter',
  ANUCLAW_STUDY_OBJECT_STORE_CREDENTIAL_REF: 'reference to a credential in the secrets manager (never the secret itself)',
  ANUCLAW_STUDY_OBJECT_STORE_ENCRYPTION_KEY_REF: 'reference to a customer-managed encryption key (encryption at rest is mandatory)',
  ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS: 'retention period in days from the approved protocol (> 0)',
  ANUCLAW_STUDY_OBJECT_STORE_ACCESS_POLICY_REF: 'reference to a least-privilege access policy (per-role, audited)',
} as const;

export type StudyStorageStatus =
  | { ready: true; kind: 'local_synthetic'; root: string; syntheticOnly: true; limitations: string[] }
  | { ready: false; kind: 'local_synthetic' | 'object_store' | 'unconfigured'; reasons: string[] };

export function createStudyStorage(env: NodeJS.ProcessEnv = process.env): StudyStorageStatus {
  const mode = (env.ANUCLAW_STUDY_STORAGE ?? '').trim();
  const prod = env.NODE_ENV === 'production';
  if (!mode) return { ready: false, kind: 'unconfigured', reasons: ['ANUCLAW_STUDY_STORAGE is not set (local_synthetic for development, object_store for production). Study routes are disabled.'] };
  if (mode === 'local_synthetic') {
    const reasons: string[] = [];
    if (prod) reasons.push('local_synthetic storage is refused in production (no encryption at rest, retention or access control).');
    const root = (env.ANUCLAW_STUDY_LOCAL_ROOT ?? '').trim();
    if (!root) reasons.push('ANUCLAW_STUDY_LOCAL_ROOT must be set explicitly (there is no default location).');
    else if (!root.startsWith('/')) reasons.push('ANUCLAW_STUDY_LOCAL_ROOT must be an absolute path.');
    if (reasons.length) return { ready: false, kind: 'local_synthetic', reasons };
    return { ready: true, kind: 'local_synthetic', root, syntheticOnly: true, limitations: ['synthetic datasets only', 'no encryption at rest', 'no retention enforcement', 'file permissions are the only access control'] };
  }
  if (mode === 'object_store') {
    const missing = Object.keys(OBJECT_STORE_REQUIRED).filter((k) => !(env[k] ?? '').trim());
    const reasons = missing.map((k) => `${k} is required (${OBJECT_STORE_REQUIRED[k as keyof typeof OBJECT_STORE_REQUIRED]}).`);
    const days = Number(env.ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS); if (!missing.includes('ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS') && !(Number.isInteger(days) && days > 0)) reasons.push('ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS must be a positive integer.');
    if (!reasons.length) reasons.push('not_implemented: no StudyObjectStore implementation ships in this repository, so the object_store mode cannot be used. It does not fall back to local files.');
    return { ready: false, kind: 'object_store', reasons };
  }
  return { ready: false, kind: 'unconfigured', reasons: [`ANUCLAW_STUDY_STORAGE must be local_synthetic or object_store (got "${mode}").`] };
}
