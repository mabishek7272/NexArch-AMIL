import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: { query: vi.fn(async () => [{ id: 1, ts: 1, action: 'x' }]), queryOne: vi.fn() } }));
// Auth is covered elsewhere; here we exercise the signing-key behaviour only.
vi.mock('./auth', () => ({
  requireDashAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u', email: 'a@b.invalid', role: 'auditor' }; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import auditRouter from './routes/audit';
import { getAuditHmacSecret } from '../../security/jwt-secrets';

let server: Server;
let base: string;
const saved = process.env.ANUCLAW_AUDIT_HMAC_SECRET;

beforeAll(async () => {
  const app = express();
  app.use('/api/audit', auditRouter);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (saved === undefined) delete process.env.ANUCLAW_AUDIT_HMAC_SECRET;
  else process.env.ANUCLAW_AUDIT_HMAC_SECRET = saved;
});
beforeEach(() => { delete process.env.ANUCLAW_AUDIT_HMAC_SECRET; });

describe('audit export signing key', () => {
  it('has no fallback: the old default and missing values are rejected', () => {
    expect(() => getAuditHmacSecret({})).toThrow();
    expect(() => getAuditHmacSecret({ ANUCLAW_AUDIT_HMAC_SECRET: 'audit-hmac-secret' })).toThrow();
    // Not borrowed from the JWT secret either.
    expect(() => getAuditHmacSecret({ ANUCLAW_JWT_SECRET: crypto.randomBytes(32).toString('hex') })).toThrow();
  });

  it('export answers 503 when the key is not configured', async () => {
    const r = await fetch(`${base}/api/audit/export`);
    expect(r.status).toBe(503);
  });

  it('export signs rows verifiably with the configured key', async () => {
    const key = crypto.randomBytes(32).toString('hex');
    process.env.ANUCLAW_AUDIT_HMAC_SECRET = key;
    const lines = (await (await fetch(`${base}/api/audit/export`)).text()).trim().split('\n').map((l) => JSON.parse(l));
    const row = lines[1];
    const { _sig, ...data } = row;
    expect(_sig).toBe(crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex'));
    expect(lines.at(-1)._type).toBe('export_footer');
  });
});
