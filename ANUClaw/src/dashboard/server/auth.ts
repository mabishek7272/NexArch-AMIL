import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { db } from '../../db';
import { getDashboardJwtSecret } from '../../security/jwt-secrets';

// No fallback secret: getDashboardJwtSecret() throws AuthConfigError when the
// secret is missing/unsafe (Phase 1 repair F02).
const ACCESS_TTL  = 15 * 60;       // 15 min
const REFRESH_TTL = 7 * 24 * 3600; // 7 days

export interface DashUser {
  id: string;
  email: string;
  name: string | null;
  role: 'admin' | 'operator' | 'viewer' | 'auditor' | 'compliance' | 'clinician';
  scope_json: string;
}

export interface AuthRequest extends Request {
  user?: DashUser;
  /** jti of the dashboard session that authenticated this request. */
  sessionJti?: string;
}

export interface DashTokenPayload {
  sub: string;
  jti: string;
  type: 'access' | 'refresh';
}

/** Throws AuthConfigError if the dashboard signing secret is missing/unsafe. Call at startup. */
export function assertDashboardAuthConfigured(): void {
  getDashboardJwtSecret();
}

/** Why a session could not be issued. Callers map every kind to 401. */
export class SessionIssueError extends Error {
  constructor(public readonly kind: 'user_missing' | 'password_changed' | 'session_inactive') {
    super(kind);
    this.name = 'SessionIssueError';
  }
}

export interface IssueOptions {
  /** Login: the exact password_hash that was just verified. Must still be current. */
  expectedPasswordHash?: string;
  /** Refresh: the session being rotated. Revoked atomically; must be active. */
  rotateFromJti?: string;
}

/**
 * Issue an access/refresh pair backed by a new dash_sessions row.
 *
 * Concurrency: runs in one transaction that takes FOR SHARE on the user row.
 * Password changes UPDATE that row (FOR UPDATE semantics) before revoking
 * sessions in their own transaction, so either the change waits for this
 * session to commit and then revokes it, or this waits for the change and then
 * sees the new hash (login) / revoked session (refresh) and refuses.
 */
export async function issueTokens(userId: string, opts: IssueOptions = {}): Promise<{ accessToken: string; refreshToken: string }> {
  const secret = getDashboardJwtSecret();
  const jti = crypto.randomUUID();
  const now = Date.now();

  await db.transaction(async (tx) => {
    const u = await tx.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM dash_users WHERE id = $1 FOR SHARE',
      [userId],
    );
    if (!u.rows[0]) throw new SessionIssueError('user_missing');
    if (opts.expectedPasswordHash !== undefined && u.rows[0].password_hash !== opts.expectedPasswordHash) {
      throw new SessionIssueError('password_changed');
    }
    if (opts.rotateFromJti !== undefined) {
      // Compare-and-set: exactly one concurrent refresh of a session can win.
      const r = await tx.query(
        `UPDATE dash_sessions SET revoked = 1
          WHERE jti = $1 AND user_id = $2 AND COALESCE(revoked, 0) = 0 AND expires_at > $3`,
        [opts.rotateFromJti, userId, now],
      );
      if (r.rowCount !== 1) throw new SessionIssueError('session_inactive');
    }
    await tx.query(
      `INSERT INTO dash_sessions (jti, user_id, expires_at, ip) VALUES ($1, $2, $3, 'local')`,
      [jti, userId, now + REFRESH_TTL * 1000],
    );
  });

  const accessToken  = jwt.sign({ sub: userId, jti, type: 'access'  }, secret, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
  const refreshToken = jwt.sign({ sub: userId, jti, type: 'refresh' }, secret, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
  return { accessToken, refreshToken };
}

/**
 * Set a user's password and revoke ALL of their sessions atomically. The
 * user-row UPDATE comes first so it serialises against issueTokens' FOR SHARE.
 */
export async function setPasswordAndRevokeSessions(userId: string, newHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const r = await tx.query('UPDATE dash_users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
    if (r.rowCount !== 1) return false;
    await tx.query('UPDATE dash_sessions SET revoked = 1 WHERE user_id = $1', [userId]);
    return true;
  });
}

/**
 * Upgrade a hash only if it is still exactly the one that was verified
 * (compare-and-set). Returns the hash now in force, or null if it changed.
 */
export async function upgradePasswordHash(userId: string, verifiedHash: string, newHash: string): Promise<string | null> {
  const r = await db.transaction((tx) =>
    tx.query('UPDATE dash_users SET password_hash = $1 WHERE id = $2 AND password_hash = $3', [newHash, userId, verifiedHash]),
  );
  return r.rowCount === 1 ? newHash : null;
}

/**
 * Verify a dashboard JWT's signature, expiry, algorithm and type.
 * Throws on any failure (including missing/unsafe secret).
 */
export function verifyDashToken(token: string, expectedType: DashTokenPayload['type']): DashTokenPayload {
  const payload = jwt.verify(token, getDashboardJwtSecret(), { algorithms: ['HS256'] }) as Partial<DashTokenPayload>;
  if (payload.type !== expectedType || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new Error('Wrong token type or malformed claims');
  }
  return payload as DashTokenPayload;
}

/**
 * A session is active only if its server-side row EXISTS, belongs to the
 * token's user, is not revoked, and has not expired. A missing row is rejected.
 */
export async function isSessionActive(jti: string, userId: string): Promise<boolean> {
  const session = await db.queryOne(
    'SELECT user_id, expires_at, revoked FROM dash_sessions WHERE jti = $1',
    [jti],
  ) as { user_id: string; expires_at: number | string; revoked: number | null } | undefined;
  if (!session) return false;
  if (session.revoked) return false;
  if (session.user_id !== userId) return false;
  const expiresAt = Number(session.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  return true;
}

export async function requireDashAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token =
    (req.cookies?.dash_token as string | undefined) ??
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);

  if (!token) {
    res.status(401).json({ error: 'Not authenticated.' });
    return;
  }

  try {
    getDashboardJwtSecret();
  } catch {
    res.status(503).json({ error: 'Authentication is not configured on this server.' });
    return;
  }

  try {
    const payload = verifyDashToken(token, 'access');

    if (!(await isSessionActive(payload.jti, payload.sub))) {
      res.status(401).json({ error: 'Session is not active.' });
      return;
    }

    const user = await db.queryOne('SELECT id, email, name, role, scope_json FROM dash_users WHERE id = $1', [payload.sub]) as DashUser | undefined;
    if (!user) { res.status(401).json({ error: 'User not found.' }); return; }

    req.user = user;
    req.sessionJti = payload.jti;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions.' });
      return;
    }
    next();
  };
}
