/**
 * TEST-ONLY in-memory fake of StudyObjectStore. It exists to prove the contract harness can detect violations (each `defect` switches one requirement off).
 * It stores nothing durably, encrypts nothing (it only records metadata), and must never be wired into any route, factory or configuration path.
 */
import * as crypto from 'crypto';
import type { PutResult, StoreAuditEvent, StorePrincipal, StudyObjectStore } from './storage';

export type Defect = 'cross_tenant_read' | 'no_encryption_metadata' | 'overwrite' | 'delete_ignores_retention' | 'shorten_retention' | 'hold_ignored' | 'token_never_expires' | 'no_checksum_check' | 'no_corruption_detection' | 'partial_write_visible' | 'revocation_ignored' | 'no_audit' | 'audit_leaks_content';
interface Ver { id: string; bytes: Buffer; sha256: string; retainUntil: number; hold: boolean; enc: PutResult['encryption'] }
export function createFakeStore(opts: { defect?: Defect; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 1_700_000_000_000 }; const d = opts.defect; const data = new Map<string, Ver[]>(); const revoked = new Set<string>(); const tokens = new Map<string, { tenant: string; key: string; ver: string; exp: number; user: string }>(); const events: StoreAuditEvent[] = [];
  const k = (t: string, key: string) => `${t}\u0000${key}`;
  const audit = (p: StorePrincipal, action: string, outcome: StoreAuditEvent['outcome'], key?: string, extra = '') => { if (d !== 'no_audit') events.push({ at: clock.t, action, tenantId: p.tenantId, userId: p.userId, key: d === 'audit_leaks_content' ? `${key}${extra}` : key, outcome }); };
  const deny = (p: StorePrincipal, action: string, key: string, msg: string): never => { audit(p, action, 'denied', key); throw new Error(msg); };
  const live = (p: StorePrincipal, action: string, key: string) => { if (d !== 'revocation_ignored' && revoked.has(`${p.tenantId}/${p.userId}`)) deny(p, action, key, 'access revoked'); };
  const scope = (p: StorePrincipal, key: string) => (d === 'cross_tenant_read' ? [...data.entries()].find(([kk]) => kk.endsWith(`\u0000${key}`))?.[1] : data.get(k(p.tenantId, key)));
  const store: StudyObjectStore & { __corrupt(key: string, versionId: string): void; __tenantOfLast?: string } = {
    async put(p, key, bytes, meta) {
      live(p, 'put', key);
      if (d !== 'no_checksum_check' && crypto.createHash('sha256').update(bytes).digest('hex') !== meta.sha256) { if (d === 'partial_write_visible') data.set(k(p.tenantId, key), [{ id: 'partial', bytes, sha256: meta.sha256, retainUntil: 0, hold: false, enc: { algorithm: 'x', keyRef: 'y' } }]); deny(p, 'put', key, 'checksum mismatch'); }
      const list = data.get(k(p.tenantId, key)) ?? []; const v: Ver = { id: crypto.randomUUID(), bytes: Buffer.from(bytes), sha256: meta.sha256, retainUntil: Date.parse(meta.retainUntil), hold: false, enc: d === 'no_encryption_metadata' ? (undefined as never) : { algorithm: 'AES-256-GCM (recorded only)', keyRef: 'kms-key-ref-1' } };
      if (d === 'overwrite') { v.id = list[0]?.id ?? v.id; data.set(k(p.tenantId, key), [v]); } else data.set(k(p.tenantId, key), [...list, v]);
      audit(p, 'put', 'ok', key); return { versionId: v.id, sha256: v.sha256, encryption: v.enc };
    },
    async get(p, key, versionId) {
      live(p, 'get', key); const list = scope(p, key); if (!list?.length) return deny(p, 'get', key, 'not found');
      const v = versionId ? list.find((x) => x.id === versionId) : list[list.length - 1]; if (!v) return deny(p, 'get', key, 'not found');
      if (d !== 'no_corruption_detection' && crypto.createHash('sha256').update(v.bytes).digest('hex') !== v.sha256) return deny(p, 'get', key, 'checksum mismatch on read');
      audit(p, 'get', 'ok', key, d === 'audit_leaks_content' ? v.bytes.toString() : ''); return Buffer.from(v.bytes);
    },
    async list(p, prefix) { live(p, 'list', prefix); const out = [...data.entries()].filter(([kk]) => (d === 'cross_tenant_read' ? true : kk.startsWith(`${p.tenantId}\u0000`))).map(([kk]) => kk.split('\u0000')[1]).filter((x) => x.startsWith(prefix)); audit(p, 'list', 'ok', prefix); return out; },
    async versions(p, key) { live(p, 'versions', key); const l = scope(p, key) ?? []; return l.map((v) => ({ versionId: v.id, sha256: v.sha256, encryption: v.enc })); },
    async setRetention(p, key, versionId, until) { live(p, 'setRetention', key); const v = data.get(k(p.tenantId, key))?.find((x) => x.id === versionId); if (!v) return deny(p, 'setRetention', key, 'not found'); const t = Date.parse(until); if (t < v.retainUntil && d !== 'shorten_retention') return deny(p, 'setRetention', key, 'cannot shorten retention'); v.retainUntil = t; audit(p, 'setRetention', 'ok', key); },
    async placeHold(p, key, versionId) { live(p, 'placeHold', key); const v = data.get(k(p.tenantId, key))?.find((x) => x.id === versionId); if (!v) return deny(p, 'placeHold', key, 'not found'); v.hold = true; audit(p, 'placeHold', 'ok', key); },
    async releaseHold(p, key, versionId) { live(p, 'releaseHold', key); const v = data.get(k(p.tenantId, key))?.find((x) => x.id === versionId); if (!v) return deny(p, 'releaseHold', key, 'not found'); v.hold = false; audit(p, 'releaseHold', 'ok', key); },
    async delete(p, key, versionId) {
      live(p, 'delete', key); const l = data.get(k(p.tenantId, key)); const v = l?.find((x) => x.id === versionId); if (!l || !v) return deny(p, 'delete', key, 'not found');
      if (d !== 'delete_ignores_retention' && v.retainUntil > clock.t) return deny(p, 'delete', key, 'under retention'); if (d !== 'hold_ignored' && v.hold) return deny(p, 'delete', key, 'under hold');
      data.set(k(p.tenantId, key), l.filter((x) => x.id !== versionId)); audit(p, 'delete', 'ok', key);
    },
    async signAccess(p, key, versionId, ttl) {
      live(p, 'sign', key); if (!(ttl > 0) || ttl > 3600) return deny(p, 'sign', key, 'ttl out of range'); const v = data.get(k(p.tenantId, key))?.find((x) => x.id === versionId); if (!v) return deny(p, 'sign', key, 'not found');
      const token = crypto.randomBytes(24).toString('hex'); const exp = clock.t + ttl * 1000; tokens.set(token, { tenant: p.tenantId, key, ver: versionId, exp, user: p.userId }); audit(p, 'sign', 'ok', key); return { token, expiresAt: exp };
    },
    async fetchSigned(token) {
      const t = tokens.get(token); if (!t) throw new Error('invalid token'); if (d !== 'token_never_expires' && clock.t > t.exp) throw new Error('token expired');
      if (d !== 'revocation_ignored' && revoked.has(`${t.tenant}/${t.user}`)) throw new Error('access revoked'); const v = data.get(k(t.tenant, t.key))?.find((x) => x.id === t.ver); if (!v) throw new Error('not found'); return Buffer.from(v.bytes);
    },
    async revokeAccess(tenantId, userId) { revoked.add(`${tenantId}/${userId}`); events.push({ at: clock.t, action: 'revoke', tenantId, userId, outcome: 'ok' }); },
    async auditEvents() { return events.map((e) => ({ ...e })); },
    __corrupt(key, versionId) { for (const [kk, l] of data) if (kk.endsWith(`\u0000${key}`)) { const v = l.find((x) => x.id === versionId); if (v) v.bytes = Buffer.concat([v.bytes, Buffer.from('!')]); } },
  };
  return { store, clock, env: () => ({ store, now: () => clock.t, advance: (ms: number) => { clock.t += ms; } }) };
}
