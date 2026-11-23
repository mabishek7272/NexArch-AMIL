/**
 * Maps body-parser failures to client errors. A malformed or oversized request body is the caller's mistake (400/413),
 * not a server fault (500). The response never echoes the body, which may hold identifiers.
 */
import type { Request, Response, NextFunction } from 'express';

export function jsonBodyErrorStatus(err: unknown): { status: number; code: string; message: string } | null {
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') return { status: 400, code: 'invalid_json', message: 'The request body is not valid JSON.' };
  if (type === 'entity.too.large') return { status: 413, code: 'payload_too_large', message: 'The request body is too large.' };
  return null;
}

/** Express error middleware: handles body errors, passes everything else on. */
export function jsonBodyErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const m = jsonBodyErrorStatus(err);
  if (!m) { next(err); return; }
  res.status(m.status).json({ error: { code: m.code, message: m.message } });
}
