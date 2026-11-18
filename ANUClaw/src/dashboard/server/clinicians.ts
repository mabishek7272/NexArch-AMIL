/**
 * Licensed-clinician role (plan §17 ownership; F03).
 *
 * `clinician` can only be granted through explicit provisioning that records the
 * licence details an administrator verified out-of-band. ANUClaw does NOT verify
 * licences itself — provisioning records who attested and when. Separation of
 * duties: an admin cannot provision themselves, and an account has one role, so
 * admin/operator accounts cannot sign off clinical content.
 */
import { Response, NextFunction } from 'express';
import { db } from '../../db';
import { AuthRequest } from './auth';

export async function hasActiveClinicianCredential(userId: string): Promise<boolean> {
  const r = await db.queryOne<{ ok: boolean }>(
    `SELECT TRUE AS ok FROM clinician_credentials c JOIN dash_users u ON u.id = c.user_id
      WHERE c.user_id = $1 AND c.status = 'active' AND u.role = 'clinician'`, [userId]);
  return Boolean(r?.ok);
}

/** Route guard: role 'clinician' AND an active provisioning record. */
export async function requireActiveClinician(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (req.user?.role !== 'clinician' || !(await hasActiveClinicianCredential(req.user.id))) {
    res.status(403).json({ error: 'A provisioned licensed clinician is required for this action.', code: 'clinician_required' });
    return;
  }
  next();
}
