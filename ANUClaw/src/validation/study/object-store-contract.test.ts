/**
 * Contract-harness tests. CONTRACT HARNESS, NOT PRODUCTION-STORAGE EVIDENCE: the fake is in-memory and test-only; these tests show that the harness
 * detects each class of violation. No real object store exists, and none is configured by this repository.
 */
import { describe, expect, it } from 'vitest';
import { CONTRACT, runObjectStoreContract } from './object-store-contract';
import { createFakeStore, Defect } from './object-store-fake';
import { createStudyStorage } from './storage';

describe('object-store contract harness (synthetic fake only)', () => {
  it('a conforming fake passes every case — this proves the cases are satisfiable, not that any real store is safe', async () => {
    const r = await runObjectStoreContract(() => createFakeStore().env()); expect(r.violations).toEqual([]); expect(r.passed.sort()).toEqual(CONTRACT.map((c) => c.id).sort());
    expect(CONTRACT.map((c) => c.id)).toEqual(expect.arrayContaining(['tenant-isolation', 'encryption-metadata', 'immutable-versions', 'retention-lock', 'deletion-hold', 'signed-access-expiry', 'checksum-verification', 'atomic-visibility', 'access-revocation', 'audit-events']));
  });
  const EXPECT: Record<Defect, string> = { cross_tenant_read: 'tenant-isolation', no_encryption_metadata: 'encryption-metadata', overwrite: 'immutable-versions', delete_ignores_retention: 'retention-lock', shorten_retention: 'retention-lock', hold_ignored: 'deletion-hold',
    token_never_expires: 'signed-access-expiry', no_checksum_check: 'checksum-verification', no_corruption_detection: 'checksum-verification', partial_write_visible: 'atomic-visibility', revocation_ignored: 'access-revocation', no_audit: 'audit-events', audit_leaks_content: 'audit-events' };
  for (const [defect, caseId] of Object.entries(EXPECT)) it(`detects the defect "${defect}" (case ${caseId})`, async () => {
    const r = await runObjectStoreContract(() => createFakeStore({ defect: defect as Defect }).env()); expect(r.violations.map((v) => v.id)).toContain(caseId);
    expect(r.violations.find((v) => v.id === caseId)!.message).toContain(`[${caseId}]`);
  });
  it('the production object_store mode stays unimplemented and never falls back to local files, even when fully configured', () => {
    const env = { ANUCLAW_STUDY_STORAGE: 'object_store', ANUCLAW_STUDY_OBJECT_STORE: 'x', ANUCLAW_STUDY_OBJECT_STORE_CREDENTIAL_REF: 'r', ANUCLAW_STUDY_OBJECT_STORE_ENCRYPTION_KEY_REF: 'k', ANUCLAW_STUDY_OBJECT_STORE_RETENTION_DAYS: '30', ANUCLAW_STUDY_OBJECT_STORE_ACCESS_POLICY_REF: 'p', ANUCLAW_STUDY_LOCAL_ROOT: '/tmp/x' };
    const s = createStudyStorage(env); expect(s.ready).toBe(false); expect((s as { reasons: string[] }).reasons.join(' ')).toMatch(/not_implemented/);
  });
});
