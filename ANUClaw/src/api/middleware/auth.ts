import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { lookupTenantApiKey, isTenantKeyActive, getTenantById, Tenant } from '../tenant-store';
import { getApiJwtSecret } from '../../security/jwt-secrets';

// No fallback secret: getApiJwtSecret() throws AuthConfigError when
// ANUCLAW_JWT_SECRET is missing/unsafe (Phase 1 repair F02).
const JWT_EXPIRES_IN = '1h';

export interface AuthRequest extends Request {
  tenant?: Tenant;
  /** The API key this request (or the JWT it carries) was issued from. Absent for tokens minted before keys were tracked. */
  apiKeyId?: string;
  /** Scopes granted to that key (`*` = all). Set only on API-key authentication. */
  apiKeyScopes?: string[];
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

/** Throws AuthConfigError if the API signing secret is missing/unsafe. Call at startup. */
export function assertApiAuthConfigured(): void {
  getApiJwtSecret();
}

/** `keyId` binds the token to the API key that minted it, so revoking or expiring that key also ends its tokens. */
export function signToken(tenantId: string, keyId?: string): string {
  return jwt.sign(keyId ? { sub: tenantId, key: keyId } : { sub: tenantId }, getApiJwtSecret(), { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}

function verifyToken(token: string, secret: string): { sub: string; key?: string } | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub?: unknown; key?: unknown };
    if (typeof payload.sub !== 'string') return null;
    return typeof payload.key === 'string' ? { sub: payload.sub, key: payload.key } : { sub: payload.sub };
  } catch {
    return null;
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Accepts either:
 *   Authorization: Bearer <jwt>
 *   X-API-Key: amgi_live_<key>
 *
 * Attaches req.tenant on success.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // 1. JWT bearer token
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let secret: string;
    try {
      secret = getApiJwtSecret();
    } catch {
      res.status(503).json({ error: 'Authentication is not configured on this server.' });
      return;
    }
    const payload = verifyToken(token, secret);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token.' });
      return;
    }
    const tenant = await getTenantById(payload.sub);
    if (!tenant || tenant.status !== 'active') {
      res.status(401).json({ error: 'Tenant not found or suspended.', code: 'tenant_suspended' });
      return;
    }
    if (payload.key) {
      // A token minted from a key stops working the moment that key is revoked or expires.
      if (!(await isTenantKeyActive(tenant.tenant_id, payload.key))) {
        res.status(401).json({ error: 'The API key this token was issued from is no longer valid.', code: 'key_revoked' });
        return;
      }
      req.apiKeyId = payload.key;
    }
    req.tenant = tenant;
    next();
    return;
  }

  // 2. API key header
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    const found = await lookupTenantApiKey(apiKey);
    if (found.status === 'revoked' || found.status === 'expired') {
      res.status(401).json({ error: `API key ${found.status}.`, code: found.status === 'revoked' ? 'key_revoked' : 'key_expired' });
      return;
    }
    if (found.status !== 'ok') {
      res.status(401).json({ error: 'Invalid API key or account suspended.', code: 'unauthorized' });
      return;
    }
    if (found.tenant.status !== 'active') {
      res.status(401).json({ error: 'Invalid API key or account suspended.', code: 'tenant_suspended' });
      return;
    }
    req.tenant = found.tenant;
    req.apiKeyId = found.keyId;
    req.apiKeyScopes = found.scopes;
    next();
    return;
  }

  res.status(401).json({
    error: 'Authentication required.',
    hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
  });
}
