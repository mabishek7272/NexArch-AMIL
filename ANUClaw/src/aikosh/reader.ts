/**
 * The ONLY sanctioned way for application code to read AIKosh records. Every read re-hashes the file and compares it with the inventory (tamper/replace detection),
 * applies the use policy (local uses need no approval; anything else needs a registry approval via the injected checker) and registers restricted values with the
 * egress taint registry so they cannot be sent to a provider by accident. Parquet is not read here (use the CSV/JSON twin or the Python inventory).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from './csv';
import { aikoshRoot, identityOf, InventoryFile, loadInventory, restrictedColumns } from './inventory';
import { evaluateUse, LOCAL_FREE_USES, Use, UseCheck } from './policy';
import { registerRestricted } from './taint';

export class AikoshError extends Error { constructor(public readonly code: 'unknown_file' | 'integrity_failure' | 'blocked' | 'unsupported_format' | 'path_escape', message: string, public readonly check?: UseCheck) { super(message); this.name = 'AikoshError'; } }
export type UseChecker = (file: ReturnType<typeof identityOf>, currentSha256: string, use: Use, fields: string[]) => Promise<UseCheck>;
const MAX_HASH_BYTES = 120 * 1024 * 1024;

export async function readRecords(relPath: string, use: Use, opts: { root?: string; checker?: UseChecker; fields?: string[]; inventoryFile?: InventoryFile } = {}): Promise<Array<Record<string, unknown>>> {
  const root = opts.root ?? aikoshRoot(); const abs = path.resolve(root, relPath);
  if (path.relative(root, abs).startsWith('..') || path.isAbsolute(path.relative(root, abs))) throw new AikoshError('path_escape', 'path escapes the AIKosh root');
  const inv = opts.inventoryFile ?? loadInventory().files.find((f) => f.path === relPath);
  if (!inv) throw new AikoshError('unknown_file', `"${relPath}" is not in the inventory (inventory first; unknown files are blocked)`);
  if (!fs.existsSync(abs)) throw new AikoshError('unknown_file', `"${relPath}" is missing on disk`);
  if (fs.statSync(abs).size > MAX_HASH_BYTES) throw new AikoshError('unsupported_format', 'file too large for the TypeScript reader');
  const bytes = fs.readFileSync(abs); const sha = crypto.createHash('sha256').update(bytes).digest('hex'); const id = identityOf(inv);
  const check = LOCAL_FREE_USES.includes(use) ? evaluateUse(id, sha, use, null, null) : opts.checker ? await opts.checker(id, sha, use, opts.fields ?? inv.columns) : evaluateUse(id, sha, use, null, null);
  if (!check.allowed) throw new AikoshError(check.status === 'integrity_failure' ? 'integrity_failure' : 'blocked', `read of ${relPath} for "${use}" refused: ${check.reasons.join('; ')}`, check);
  const text = bytes.toString('utf8'); let rows: Array<Record<string, unknown>>;
  if (inv.format === 'csv') rows = parseCsv(text).rows;
  else if (inv.format === 'jsonl') rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  else if (inv.format === 'json') { const o = JSON.parse(text); rows = Array.isArray(o) ? o : [o]; }
  else throw new AikoshError('unsupported_format', `${inv.format} is not read by the TypeScript reader`);
  // egress safety net: anything restricted that is not approved for external use stays in-process
  if (!(check.status === 'approved_for_use')) { const r = restrictedColumns(inv); for (const c of [...r.narrative, ...r.identifiers]) registerRestricted(rows.map((x) => (typeof x[c] === 'number' ? String(x[c]) : x[c])), relPath); }
  return rows;
}
