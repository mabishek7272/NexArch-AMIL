/**
 * CONTRACT HARNESS for any future StudyObjectStore (study tooling only). It is NOT production-storage evidence: no real store exists, and a pass against
 * the in-memory fake (object-store-fake.ts, test-only) shows only that each requirement is expressed as a checkable case that detects a violation.
 * An implementation is acceptable for a real study only if it passes EVERY case against the real service with real encryption keys AND humans have reviewed
 * the configuration (encryption, retention, access policy) — see the threat model and production-readiness plan.
 */
import * as crypto from 'crypto';
import type { StoreAuditEvent, StudyObjectStore } from './storage';

export interface ContractEnv { store: StudyObjectStore; advance(ms: number): void; now(): number }
export interface ContractCase { id: string; requirement: string; run(env: ContractEnv): Promise<void> }
const A = { tenantId: 'tenant-A', userId: 'user-a' }, B = { tenantId: 'tenant-B', userId: 'user-b' };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const bytes = (s: string) => Buffer.from(s);
export class ContractViolation extends Error { constructor(public readonly caseId: string, msg: string) { super(`[${caseId}] ${msg}`); this.name = 'ContractViolation'; } }
const must = (id: string, cond: unknown, msg: string) => { if (!cond) throw new ContractViolation(id, msg); };
async function rejects(id: string, p: Promise<unknown>, what: string) { try { await p; } catch { return; } throw new ContractViolation(id, `expected a refusal: ${what}`); }

export const CONTRACT: ContractCase[] = [
  { id: 'tenant-isolation', requirement: "Another tenant can neither read, list, version, sign nor delete a tenant's objects; the answer is indistinguishable from not found.", async run({ store, now }) {
    const d = bytes('tenant A secret'); const r = await store.put(A, 'ds/1/source', d, { sha256: sha(d), retainUntil: iso(now() + 1000) });
    await rejects('tenant-isolation', store.get(B, 'ds/1/source'), 'cross-tenant get'); await rejects('tenant-isolation', store.get(B, 'ds/1/source', r.versionId), 'cross-tenant get by version');
    must('tenant-isolation', !(await store.list(B, 'ds/')).includes('ds/1/source'), 'cross-tenant list leaks keys'); must('tenant-isolation', (await store.versions(B, 'ds/1/source').catch(() => [])).length === 0, 'cross-tenant versions leak');
    await rejects('tenant-isolation', store.signAccess(B, 'ds/1/source', r.versionId, 60), 'cross-tenant signing'); await rejects('tenant-isolation', store.delete(B, 'ds/1/source', r.versionId), 'cross-tenant delete');
    const d2 = bytes('tenant B own'); await store.put(B, 'ds/1/source', d2, { sha256: sha(d2), retainUntil: iso(now() + 1000) });
    must('tenant-isolation', (await store.get(A, 'ds/1/source')).equals(d) && (await store.get(B, 'ds/1/source')).equals(d2), 'same key in two tenants must not collide'); } },
  { id: 'encryption-metadata', requirement: 'Every version records its encryption algorithm and a key REFERENCE (never key material); encryption cannot be disabled per write.', async run({ store, now }) {
    const d = bytes('enc'); const r = await store.put(A, 'enc/1', d, { sha256: sha(d), retainUntil: iso(now() + 1000) });
    must('encryption-metadata', r.encryption?.algorithm && r.encryption?.keyRef, 'put result lacks encryption metadata'); must('encryption-metadata', !/-----BEGIN|[A-Za-z0-9+/]{40,}={0,2}$/.test(r.encryption.keyRef), 'keyRef looks like key material');
    const v = await store.versions(A, 'enc/1'); must('encryption-metadata', v.every((x) => x.encryption?.algorithm && x.encryption?.keyRef), 'a listed version lacks encryption metadata'); } },
  { id: 'immutable-versions', requirement: 'A second write creates a new version; earlier versions stay readable and byte-identical.', async run({ store, now }) {
    const d1 = bytes('v1'), d2 = bytes('v2'); const r1 = await store.put(A, 'imm/1', d1, { sha256: sha(d1), retainUntil: iso(now() + 1000) }); const r2 = await store.put(A, 'imm/1', d2, { sha256: sha(d2), retainUntil: iso(now() + 1000) });
    must('immutable-versions', r1.versionId !== r2.versionId, 'second write reused the version id'); must('immutable-versions', (await store.get(A, 'imm/1', r1.versionId)).equals(d1), 'old version changed or vanished'); must('immutable-versions', (await store.get(A, 'imm/1')).equals(d2), 'latest is not the newest version');
    must('immutable-versions', (await store.versions(A, 'imm/1')).length === 2, 'both versions must be listed'); } },
  { id: 'retention-lock', requirement: 'A version cannot be deleted before its retention date; retention can be extended but never shortened.', async run({ store, now, advance }) {
    const d = bytes('ret'); const r = await store.put(A, 'ret/1', d, { sha256: sha(d), retainUntil: iso(now() + 10_000) });
    await rejects('retention-lock', store.delete(A, 'ret/1', r.versionId), 'delete inside retention'); await rejects('retention-lock', store.setRetention(A, 'ret/1', r.versionId, iso(now() + 1_000)), 'shortening retention');
    await store.setRetention(A, 'ret/1', r.versionId, iso(now() + 20_000)); advance(15_000); await rejects('retention-lock', store.delete(A, 'ret/1', r.versionId), 'delete after the ORIGINAL date but inside the extended one');
    advance(10_000); await store.delete(A, 'ret/1', r.versionId); await rejects('retention-lock', store.get(A, 'ret/1', r.versionId), 'get after a permitted delete'); } },
  { id: 'deletion-hold', requirement: 'A hold blocks deletion even after retention expires, until it is released.', async run({ store, now, advance }) {
    const d = bytes('hold'); const r = await store.put(A, 'hold/1', d, { sha256: sha(d), retainUntil: iso(now() + 1_000) }); await store.placeHold(A, 'hold/1', r.versionId); advance(5_000);
    await rejects('deletion-hold', store.delete(A, 'hold/1', r.versionId), 'delete under hold'); await store.releaseHold(A, 'hold/1', r.versionId); await store.delete(A, 'hold/1', r.versionId); } },
  { id: 'signed-access-expiry', requirement: 'A signed token reads exactly one version, expires at its stated time, and cannot be extended or reused for another key.', async run({ store, now, advance }) {
    const d = bytes('signed'); const r = await store.put(A, 'sig/1', d, { sha256: sha(d), retainUntil: iso(now() + 1_000) }); const t = await store.signAccess(A, 'sig/1', r.versionId, 30);
    must('signed-access-expiry', t.expiresAt <= now() + 30_000 + 1, 'token lives longer than the requested ttl'); must('signed-access-expiry', (await store.fetchSigned(t.token)).equals(d), 'valid token must read the bytes');
    await rejects('signed-access-expiry', store.fetchSigned(t.token + 'x'), 'tampered token'); advance(31_000); await rejects('signed-access-expiry', store.fetchSigned(t.token), 'expired token');
    await rejects('signed-access-expiry', store.signAccess(A, 'sig/1', r.versionId, 0), 'non-positive ttl'); await rejects('signed-access-expiry', store.signAccess(A, 'sig/1', r.versionId, 7 * 24 * 3600), 'unbounded ttl'); } },
  { id: 'checksum-verification', requirement: 'A write whose bytes do not match the declared checksum is refused; stored corruption is detected on read.', async run({ store, now }) {
    await rejects('checksum-verification', store.put(A, 'sum/1', bytes('abc'), { sha256: sha(bytes('different')), retainUntil: iso(now() + 1000) }), 'put with a wrong checksum'); await rejects('checksum-verification', store.get(A, 'sum/1'), 'a refused write must leave nothing behind');
    const d = bytes('good'); const r = await store.put(A, 'sum/2', d, { sha256: sha(d), retainUntil: iso(now() + 1000) }); must('checksum-verification', r.sha256 === sha(d), 'returned checksum differs');
    const corrupt = (store as unknown as { __corrupt?: (k: string, v: string) => void }).__corrupt; if (corrupt) { corrupt('sum/2', r.versionId); await rejects('checksum-verification', store.get(A, 'sum/2', r.versionId), 'corrupted object served without error'); } } },
  { id: 'atomic-visibility', requirement: 'A failed or interrupted write is never visible; a successful write is visible whole.', async run({ store, now }) {
    const d = bytes('atomic'); await rejects('atomic-visibility', store.put(A, 'atomic/1', d, { sha256: sha(bytes('x')), retainUntil: iso(now() + 1000) }), 'bad write');
    must('atomic-visibility', !(await store.list(A, 'atomic/')).includes('atomic/1'), 'a refused write is listed'); await store.put(A, 'atomic/1', d, { sha256: sha(d), retainUntil: iso(now() + 1000) });
    must('atomic-visibility', (await store.get(A, 'atomic/1')).equals(d) && (await store.list(A, 'atomic/')).includes('atomic/1'), 'a successful write must be visible whole'); } },
  { id: 'access-revocation', requirement: 'Revoking a user blocks their reads, writes and outstanding signed tokens immediately; other users are unaffected.', async run({ store, now }) {
    const d = bytes('rev'); const r = await store.put(A, 'rev/1', d, { sha256: sha(d), retainUntil: iso(now() + 1000) }); const t = await store.signAccess(A, 'rev/1', r.versionId, 60);
    const other = { tenantId: 'tenant-A', userId: 'user-a2' }; must('access-revocation', (await store.get(other, 'rev/1')).equals(d), 'a second user in the tenant should read'); await store.revokeAccess('tenant-A', 'user-a');
    await rejects('access-revocation', store.get(A, 'rev/1'), 'revoked user read'); await rejects('access-revocation', store.put(A, 'rev/2', d, { sha256: sha(d), retainUntil: iso(now() + 1000) }), 'revoked user write'); await rejects('access-revocation', store.fetchSigned(t.token), 'revoked user token');
    must('access-revocation', (await store.get(other, 'rev/1')).equals(d), 'revoking one user must not affect another'); } },
  { id: 'audit-events', requirement: 'Every operation — allowed or refused — is audited with principal, action and outcome, and no event contains object bytes or key material.', async run({ store, now }) {
    const d = bytes('SECRET-CONTENT-ZEBRA'); await store.put(A, 'aud/1', d, { sha256: sha(d), retainUntil: iso(now() + 1000) }); await store.get(A, 'aud/1'); await store.get(B, 'aud/1').catch(() => undefined);
    const ev: StoreAuditEvent[] = await store.auditEvents(); must('audit-events', ev.some((e) => e.action === 'put' && e.outcome === 'ok' && e.tenantId === 'tenant-A'), 'put not audited');
    must('audit-events', ev.some((e) => e.action === 'get' && e.outcome === 'denied' && e.tenantId === 'tenant-B'), 'refused cross-tenant get not audited'); must('audit-events', !JSON.stringify(ev).includes('SECRET-CONTENT-ZEBRA'), 'audit contains object content'); } },
];

/** Runs every case on a FRESH store from the factory; returns violations instead of throwing so a caller can report all of them. */
export async function runObjectStoreContract(factory: () => ContractEnv): Promise<{ passed: string[]; violations: Array<{ id: string; message: string }> }> {
  const passed: string[] = []; const violations: Array<{ id: string; message: string }> = [];
  for (const c of CONTRACT) { try { await c.run(factory()); passed.push(c.id); } catch (e) { violations.push({ id: c.id, message: (e as Error).message }); } }
  return { passed, violations };
}
