/**
 * Patient access control (Phase 1, F01).
 *
 * Access = role permission AND an explicit per-patient grant in patient_access.
 *   - read  : view the record and its analyses   (roles: admin, operator, viewer)
 *   - write : edit, run analyses                 (roles: admin, operator)
 *   - owner : write + delete + manage grants     (roles: admin, operator)
 * auditor/compliance roles have no patient-data access.
 *
 * Patients with no grant (e.g. rows created before this control existed) are
 * inaccessible to everyone — including admins — until an admin explicitly
 * assigns access with a stated purpose. Missing access answers 404 so record
 * existence is not disclosed.
 */
import { Response, NextFunction } from 'express';
import { db } from '../../db';
import { AuthRequest } from './auth';

export type AccessLevel = 'read' | 'write' | 'owner';
const RANK: Record<AccessLevel, number> = { read: 1, write: 2, owner: 3 };

export const ROLE_MAX_LEVEL: Record<string, AccessLevel | null> = {
  admin: 'owner',
  operator: 'owner',
  viewer: 'read',
  auditor: null,
  compliance: null,
  clinician: 'write',
};

export function roleAllows(role: string, level: AccessLevel): boolean {
  const max = ROLE_MAX_LEVEL[role] ?? null;
  return max !== null && RANK[max] >= RANK[level];
}

export function levelSatisfies(granted: AccessLevel | null, needed: AccessLevel): boolean {
  return granted !== null && RANK[granted] >= RANK[needed];
}

export async function getGrantedLevel(userId: string, patientId: string): Promise<AccessLevel | null> {
  const row = await db.queryOne<{ access_level: AccessLevel }>(
    'SELECT access_level FROM patient_access WHERE patient_id = $1 AND user_id = $2',
    [patientId, userId],
  );
  return row?.access_level ?? null;
}

export interface PatientAccessRequest extends AuthRequest {
  patientAccess?: AccessLevel;
}

/** Route guard: role permits `level` AND the user holds a grant ≥ `level` for :id. */
export function requirePatientAccess(level: AccessLevel) {
  return async (req: PatientAccessRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user || !roleAllows(user.role, level)) {
      res.status(403).json({ error: 'Your role does not permit this patient operation.' });
      return;
    }
    try {
      const granted = await getGrantedLevel(user.id, String(req.params.id));
      if (!levelSatisfies(granted, level)) {
        res.status(404).json({ error: 'Patient not found' });
        return;
      }
      req.patientAccess = granted!;
      next();
    } catch {
      res.status(500).json({ error: 'Internal error.' });
    }
  };
}
