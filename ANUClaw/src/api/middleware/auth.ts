import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getTenantByApiKey, getTenantById, Tenant } from '../tenant-store';
import { getApiJwtSecret } from '../../security/jwt-secrets';

// No fallback secret: getApiJwtSecret() throws AuthConfigError when
// ANUCLAW_JWT_SECRET is missing/unsafe (Phase 1 repair F02).
const JWT_EXPIRES_IN = '1h';

export interface AuthRequest extends Request {
  tenant?: Tenant;
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

/** Throws AuthConfigError if the API signing secret is missing/unsafe. Call at startup. */
export function assertApiAuthConfigured(): void {
  getApiJwtSecret();
}

export function signToken(tenantId: string): string {
  return jwt.sign({ sub: tenantId }, getApiJwtSecret(), { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' });
}

function verifyToken(token: string, secret: string): { sub: string } | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { sub?: unknown };
    return typeof payload.sub === 'string' ? { sub: payload.sub } : null;
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
      res.status(401).json({ error: 'Tenant not found or suspended.' });
      return;
    }
    req.tenant = tenant;
    next();
    return;
  }

  // 2. API key header
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (apiKey) {
    const tenant = await getTenantByApiKey(apiKey);
    if (!tenant || tenant.status !== 'active') {
      res.status(401).json({ error: 'Invalid API key or account suspended.' });
      return;
    }
    req.tenant = tenant;
    next();
    return;
  }

  res.status(401).json({
    error: 'Authentication required.',
    hint: 'Provide X-API-Key header or Authorization: Bearer <token>',
  });
}
