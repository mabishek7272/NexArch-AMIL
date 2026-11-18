import { Router } from 'express';
import {
  requireDashAuth, requireRole, issueTokens, verifyDashToken, DashUser,
  SessionIssueError, setPasswordAndRevokeSessions, upgradePasswordHash, AuthRequest,
} from '../auth';
import { getDashboardJwtSecret } from '../../../security/jwt-secrets';
import { db } from '../../../db';
import * as crypto from 'crypto';
import { hashPassword, verifyPassword, dummyVerify, MAX_PASSWORD_LENGTH } from '../../../security/password';
import { logger } from '../../../logger';
import { validateScopeJson } from '../clinical-grants';
import { FixedWindowLimiter } from '../../../security/throttle';

const router = Router();

const VALID_ROLES = ['admin', 'operator', 'viewer', 'auditor', 'compliance', 'clinician'];
/** Roles assignable through generic create/update. `clinician` only via provisioning. */
const ASSIGNABLE_ROLES = VALID_ROLES.filter((r) => r !== 'clinician');

// Login throttling (in-process; see security/throttle.ts for the multi-process limitation).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new FixedWindowLimiter(LOGIN_WINDOW_MS);
const loginAttemptsPerIp = new FixedWindowLimiter(LOGIN_WINDOW_MS);
const MAX_FAILURES_PER_ACCOUNT_IP = Number(process.env.ANUCLAW_LOGIN_MAX_FAILURES ?? 5);
const MAX_ATTEMPTS_PER_IP = Number(process.env.ANUCLAW_LOGIN_MAX_PER_IP ?? 50);
/** Test helper. */
export const __loginThrottle = { loginFailures, loginAttemptsPerIp };
export const MIN_PASSWORD_LENGTH = 12;

function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > MAX_PASSWORD_LENGTH) return 'Password is too long.';
  return null;
}

/** Log server-side; return a generic 500 (no internal messages to clients). */
function serverError(res: any, where: string, err: unknown): void {
  logger.error(`users route error (${where}): ${err instanceof Error ? err.name : 'unknown'}`);
  res.status(500).json({ error: 'Internal error.' });
}

// List users (admin only)
router.get('/', requireDashAuth, requireRole('admin'), async (_req, res) => {
  try {
    const users = await db.query(`
      SELECT id, email, name, role, scope_json, created_at, last_login_at FROM dash_users ORDER BY created_at DESC
    `);
    res.json({ users });
  } catch (err) {
    serverError(res, 'list', err);
  }
});

// Create user (admin only)
router.post('/', requireDashAuth, requireRole('admin'), async (req, res) => {
  const { email, name, role, password, scope_json } = req.body as Record<string, string>;
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required.' });
    return;
  }
  if (role && !ASSIGNABLE_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')} (clinician requires provisioning)` });
    return;
  }
  const scopeErr = validateScopeJson(scope_json);
  if (scopeErr) { res.status(400).json({ error: scopeErr }); return; }
  const problem = passwordProblem(password);
  if (problem) { res.status(400).json({ error: problem }); return; }
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await db.query(`
      INSERT INTO dash_users (id, email, name, role, scope_json, password_hash, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, email, name ?? null, role ?? 'viewer', scope_json ?? '{}', await hashPassword(password), now]);
    res.status(201).json({ id });
  } catch (e: any) {
    if (e?.code === '23505' || e?.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Email already exists.' });
      return;
    }
    serverError(res, 'create', e);
  }
});

// Update user (admin only)
router.put('/:id', requireDashAuth, requireRole('admin'), async (req, res) => {
  const { name, role, scope_json } = req.body as Record<string, string>;
  const scopeProblem = validateScopeJson(scope_json);
  if (scopeProblem) { res.status(400).json({ error: scopeProblem }); return; }
  if (role && !ASSIGNABLE_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')} (clinician requires provisioning)` });
    return;
  }
  if (role) {
    const current = await db.queryOne<{ role: string }>('SELECT role FROM dash_users WHERE id=$1', [req.params.id]);
    if (current?.role === 'clinician') { res.status(400).json({ error: 'Revoke clinician provisioning to change this role.' }); return; }
  }
  try {
    await db.query(`
      UPDATE dash_users SET name=COALESCE($1,name), role=COALESCE($2,role), scope_json=COALESCE($3,scope_json) WHERE id=$4
    `, [name ?? null, role ?? null, scope_json ?? null, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    serverError(res, 'update', err);
  }
});

// Provision a licensed clinician (admin only; never self; audited). ANUClaw records
// the attestation — it does not verify licences itself.
router.post('/:id/clinician-provisioning', requireDashAuth, requireRole('admin'), async (req: any, res) => {
  const { license_number, jurisdiction, licensing_body, verification_note } = req.body ?? {};
  const fields = { license_number, jurisdiction, licensing_body, verification_note };
  const missing = Object.entries(fields).filter(([, v]) => typeof v !== 'string' || !v.trim() || v.length > 500).map(([k]) => k);
  if (missing.length) { res.status(400).json({ error: `Required: ${missing.join(', ')}` }); return; }
  if (req.user.id === req.params.id) { res.status(403).json({ error: 'Administrators cannot provision themselves (separation of duties).' }); return; }
  try {
    const out = await db.transaction(async (tx) => {
      const u = await tx.query<{ role: string }>('SELECT role FROM dash_users WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!u.rows[0]) return { status: 404, body: { error: 'User not found.' } };
      if (['admin', 'operator'].includes(u.rows[0].role)) return { status: 409, body: { error: 'Admin/operator accounts cannot hold the clinician role; use a separate account.' } };
      const now = Date.now();
      await tx.query(`INSERT INTO clinician_credentials (user_id, license_number, jurisdiction, licensing_body, verification_note, status, provisioned_by, provisioned_at)
                      VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
                      ON CONFLICT (user_id) DO UPDATE SET license_number=EXCLUDED.license_number, jurisdiction=EXCLUDED.jurisdiction,
                        licensing_body=EXCLUDED.licensing_body, verification_note=EXCLUDED.verification_note, status='active',
                        provisioned_by=EXCLUDED.provisioned_by, provisioned_at=EXCLUDED.provisioned_at, revoked_by=NULL, revoked_at=NULL`,
        [req.params.id, license_number.trim(), jurisdiction.trim(), licensing_body.trim(), verification_note.trim(), req.user.id, now]);
      await tx.query(`UPDATE dash_users SET role='clinician' WHERE id=$1`, [req.params.id]);
      await tx.query(`INSERT INTO audit_events (ts, action, actor_id, actor_type, channel, target_type, target_id, meta) VALUES ($1,'clinician.provision',$2,'dashboard_user','dashboard','user',$3,$4)`,
        [now, req.user.id, req.params.id, JSON.stringify({ jurisdiction: jurisdiction.trim(), licensing_body: licensing_body.trim() })]);
      return { status: 200, body: { ok: true, role: 'clinician' } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { serverError(res, 'clinician-provision', err); }
});

router.post('/:id/clinician-revocation', requireDashAuth, requireRole('admin'), async (req: any, res) => {
  try {
    const out = await db.transaction(async (tx) => {
      const r = await tx.query(`UPDATE clinician_credentials SET status='revoked', revoked_by=$2, revoked_at=$3 WHERE user_id=$1 AND status='active'`, [req.params.id, req.user.id, Date.now()]);
      if (r.rowCount !== 1) return { status: 404, body: { error: 'No active clinician credential.' } };
      await tx.query(`UPDATE dash_users SET role='viewer' WHERE id=$1`, [req.params.id]);
      await tx.query('UPDATE dash_sessions SET revoked=1 WHERE user_id=$1', [req.params.id]);
      await tx.query(`INSERT INTO audit_events (ts, action, actor_id, actor_type, channel, target_type, target_id, meta) VALUES ($1,'clinician.revoke',$2,'dashboard_user','dashboard','user',$3,'{}')`,
        [Date.now(), req.user.id, req.params.id]);
      return { status: 200, body: { ok: true, role: 'viewer', sessions_revoked: true } };
    });
    res.status(out.status).json(out.body);
  } catch (err) { serverError(res, 'clinician-revoke', err); }
});

// Change password (admin, or self). Revokes ALL of the user's sessions atomically.
router.patch('/:id/password', requireDashAuth, async (req: any, res) => {
  const isSelf = req.user?.id === req.params.id;
  const isAdmin = req.user?.role === 'admin';
  if (!isSelf && !isAdmin) {
    res.status(403).json({ error: 'Insufficient permissions.' });
    return;
  }
  const { password } = req.body as { password: string };
  const problem = passwordProblem(password);
  if (problem) { res.status(400).json({ error: problem }); return; }
  try {
    const updated = await setPasswordAndRevokeSessions(req.params.id, await hashPassword(password));
    if (!updated) { res.status(404).json({ error: 'User not found.' }); return; }
    res.json({ ok: true, sessions_revoked: true });
  } catch (err) {
    serverError(res, 'password', err);
  }
});

// Delete user (admin only, cannot delete self)
router.delete('/:id', requireDashAuth, requireRole('admin'), async (req: any, res) => {
  if (req.user?.id === req.params.id) {
    res.status(400).json({ error: 'Cannot delete your own account.' });
    return;
  }
  try {
    await db.query('UPDATE dash_sessions SET revoked=1 WHERE user_id=$1', [req.params.id]);
    await db.query('DELETE FROM dash_users WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    serverError(res, 'delete', err);
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  if (!email || !password) {
    res.status(400).json({ error: 'email and password required.' });
    return;
  }
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'email and password required.' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  const accountKey = `${ip}|${email.trim().toLowerCase()}`;
  const perIp = loginAttemptsPerIp.hit(ip, MAX_ATTEMPTS_PER_IP);
  if (!perIp.allowed || loginFailures.peek(accountKey) >= MAX_FAILURES_PER_ACCOUNT_IP) {
    res.setHeader('Retry-After', String(perIp.allowed ? Math.ceil(LOGIN_WINDOW_MS / 1000) : perIp.retryAfterSec));
    res.status(429).json({ error: 'Too many sign-in attempts. Try again later.', code: 'rate_limited' });
    return;
  }
  const failed = () => { loginFailures.hit(accountKey, Number.MAX_SAFE_INTEGER); };
  try {
    const user = await db.queryOne(
      'SELECT id, email, name, role, password_hash FROM dash_users WHERE email=$1',
      [email],
    ) as (DashUser & { password_hash: string | null }) | undefined;
    if (!user) {
      await dummyVerify(); // equalise timing for unknown accounts
      failed();
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    const v = await verifyPassword(password, user.password_hash);
    if (!v.ok) {
      if (v.malformed) logger.warn('Login refused: stored password hash is not in a recognised format.');
      failed();
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    // Upgrade legacy/outdated hashes only after successful verification, and only
    // if the stored hash is still exactly the one we verified (compare-and-set).
    let hashInForce = user.password_hash as string;
    if (v.needsRehash) {
      const upgraded = await upgradePasswordHash(user.id, hashInForce, await hashPassword(password));
      if (!upgraded) {
        res.status(401).json({ error: 'Credentials changed during sign-in. Please sign in again.' });
        return;
      }
      hashInForce = upgraded;
    }
    // Never issue a session if the password changed after verification.
    const { accessToken, refreshToken } = await issueTokens(user.id, { expectedPasswordHash: hashInForce });
    loginFailures.reset(accountKey);
    await db.query('UPDATE dash_users SET last_login_at=$1 WHERE id=$2', [Date.now(), user.id]);
    res
      .cookie('dash_token', accessToken, { httpOnly: true, sameSite: 'lax', maxAge: 15 * 60 * 1000 })
      .cookie('dash_refresh', refreshToken, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 })
      .json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    if (err instanceof SessionIssueError) {
      res.status(401).json({ error: 'Credentials changed during sign-in. Please sign in again.' });
      return;
    }
    serverError(res, 'login', err);
  }
});

// Logout
router.post('/logout', requireDashAuth, async (req: AuthRequest, res) => {
  // Revoke the session behind the access token used for this request…
  const jtis = new Set<string>();
  if (req.sessionJti) jtis.add(req.sessionJti);
  // …and the one behind the refresh cookie, if it belongs to the same user.
  const token = req.cookies?.dash_refresh;
  if (token) {
    try {
      const payload = verifyDashToken(token, 'refresh');
      if (payload.sub === req.user!.id) jtis.add(payload.jti);
    } catch { /* invalid refresh cookie: nothing to revoke */ }
  }
  try {
    for (const jti of jtis) {
      await db.query('UPDATE dash_sessions SET revoked=1 WHERE jti=$1 AND user_id=$2', [jti, req.user!.id]);
    }
  } catch (err) {
    serverError(res, 'logout', err);
    return;
  }
  res.clearCookie('dash_token').clearCookie('dash_refresh').json({ ok: true });
});

// Refresh access token
router.post('/refresh', async (req, res) => {
  const token = req.cookies?.dash_refresh;
  if (!token) { res.status(401).json({ error: 'No refresh token.' }); return; }
  try {
    getDashboardJwtSecret();
  } catch {
    res.status(503).json({ error: 'Authentication is not configured on this server.' });
    return;
  }
  try {
    const payload = verifyDashToken(token, 'refresh');
    // Rotation: the old session must be active and is revoked in the same
    // transaction that creates the new one (compare-and-set; one winner).
    const { accessToken, refreshToken } = await issueTokens(payload.sub, { rotateFromJti: payload.jti });
    res.cookie('dash_token', accessToken, { httpOnly: true, sameSite: 'lax', maxAge: 15 * 60 * 1000 })
       .cookie('dash_refresh', refreshToken, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 })
       .json({ ok: true });
  } catch (err) {
    if (!(err instanceof SessionIssueError) && !(err instanceof Error && /jwt|token|claims/i.test(err.message))) {
      logger.warn(`refresh failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }
    res.status(401).json({ error: 'Invalid or expired refresh token.' });
  }
});

// Current user profile (includes terms status)
router.get('/me', requireDashAuth, async (req: any, res) => {
  try {
    const user = await db.queryOne('SELECT id, email, name, role, created_at, last_login_at, terms_accepted_at FROM dash_users WHERE id=$1', [req.user.id]);
    res.json({ user });
  } catch (err) {
    serverError(res, 'me', err);
  }
});

// Accept terms / product acknowledgement
router.post('/accept-terms', requireDashAuth, async (req: any, res) => {
  const now = Date.now();
  try {
    await db.query('UPDATE dash_users SET terms_accepted_at=$1 WHERE id=$2', [now, req.user.id]);
    res.json({ ok: true, terms_accepted_at: now });
  } catch (err) {
    serverError(res, 'terms', err);
  }
});

export default router;
