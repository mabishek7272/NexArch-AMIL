/**
 * Shared plumbing for the administrator routers (tenants/keys and skills): the audit context taken from a request,
 * the error-to-response mapping, and id validation. One place, so every admin route behaves identically.
 */
import * as crypto from 'crypto';
import { Request, Response, RequestHandler } from 'express';
import { logger } from '../../logger';
import { TenancyError } from './keys';
import type { AuditCtx } from './audit';

export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function clean(value: string | undefined, max: number): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const t = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return t || null;
}

/** The admin key proves "an administrator", not which one; `X-Admin-Actor` is recorded as an unverified label. */
export function auditContext(req: Request): AuditCtx {
  // A guard that knows WHO the administrator is (the dashboard session) sets `auditActor`; that is a verified identity, not a claim.
  const verified = (req as Request & { auditActor?: string }).auditActor;
  if (verified) return { actor: verified, declaredActor: null, requestId: clean(req.header('x-request-id'), 80) ?? crypto.randomUUID() };
  return { actor: 'admin_api', declaredActor: clean(req.header('x-admin-actor'), 80), requestId: clean(req.header('x-request-id'), 80) ?? crypto.randomUUID() };
}

/** Wraps a handler: sets X-Request-Id, maps TenancyError to `{error:{code,message,requestId}}`, hides everything else as a 500. */
export function adminHandler(fn: (req: Request, res: Response, ctx: AuditCtx) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    const ctx = auditContext(req);
    res.setHeader('X-Request-Id', ctx.requestId!);
    try {
      await fn(req, res, ctx);
    } catch (e) {
      if (e instanceof TenancyError) {
        res.status(e.status).json({ error: { code: e.code, message: e.message, requestId: ctx.requestId } });
        return;
      }
      logger.error(`admin route failed [${ctx.requestId}]: ${e instanceof Error ? e.message : 'unknown error'}`);
      res.status(500).json({ error: { code: 'internal_error', message: 'Internal error.', requestId: ctx.requestId } });
    }
  };
}

/** Reads a path parameter and refuses anything that is not a plausible id, before it can reach the database. */
export function idParam(req: Request, name: string, notFoundCode: string, notFoundMessage: string): string {
  const id = String(req.params[name]);
  if (!ID_RE.test(id)) throw new TenancyError(404, notFoundCode, notFoundMessage);
  return id;
}

/** Optional override of the fail-closed X-Admin-Key guard (the dashboard supplies a session-and-role guard that sets `auditActor`). */
export type AdminGuard = RequestHandler | RequestHandler[];
