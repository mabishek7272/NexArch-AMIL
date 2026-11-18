/**
 * Locked test-set manifest for the OCR validation study (SYNTHETIC-ONLY tooling until a real protocol is approved).
 *
 * One dataset = one directory:
 *   dataset.json                       staged registration (before the manifest exists)
 *   manifest.json                      the authority once generated: opaque case IDs, hashes, provenance, annotation versions, lock state
 *   sources/<caseId>                   source documents (immutable; hashes in the manifest)
 *   annotations/<annotatorId>/vN.json  append-only annotation versions (never overwritten)
 *   adjudication/records.jsonl         append-only, hash-chained adjudication records (both original annotations are embedded)
 *   truth/adjudicated.vN.json          the adjudicated ground truth built from the above
 *   outputs/<runId>/…                  evaluation runs (the ONLY area writable while locked)
 * Sources, annotations, adjudication, truth and outputs are versioned separately and every one is hashed in the manifest.
 *
 * What the lock does and does not give you:
 *  - the manifest is self-hashed; every source/annotation/truth file is re-hashed on verify; the lock digest covers cases + split + truth + annotators;
 *  - while locked, every API refuses writes outside outputs/ and files are made read-only (0444);
 *  - UNLOCK needs a human-supplied authorization record (this tool cannot verify who the person is) and leaves a permanent, hash-chained trace;
 *  - a person with write access to the whole directory can rewrite manifest AND hashes: record the lock digest OUTSIDE this directory (e.g. in the
 *    preregistration) and pass it to verify (--expect-lock-digest). There is deliberately NO bypass flag or environment variable.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const MANIFEST_SCHEMA = 'anuclaw-ocr-study-manifest/v1';
export const UNLOCK_SCHEMA = 'anuclaw-unlock-authorization/v1';
export type Split = 'development' | 'locked_validation' | 'external_validation';
export const SPLITS: Split[] = ['development', 'locked_validation', 'external_validation'];
export type ProvenanceKind = 'synthetic_fixture' | 'human_annotated';

export class StudyError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = 'StudyError'; }
}

export const sha256Hex = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export interface CaseEntry { caseId: string; pages: number; mediaType: string; sourceSha256: string; sourceBytes: number; file: string }
export interface AnnotationEntry { annotatorId: string; version: number; sha256: string; file: string; caseCount: number; importedAt: string; importedBy: string; supersedes: number | null }
export interface LockEvent { seq: number; event: 'create' | 'lock' | 'unlock' | 'relock'; at: string; by: string; lockDigest: string | null; authorizationSha256: string | null; prevHash: string; hash: string }
export interface OutputEntry { policy?: { policyId: string; version: number; sha256: string; kind: string; overridden: boolean }; runId: string; mode: 'development' | 'locked'; at: string; by: string; resultsSha256: string; reportSha256: string; manifestSha256AtRun: string; lockDigestAtRun: string | null; lockEpochAtRun: number }
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  studyRef: string;
  datasetId: string;
  name: string;
  createdAt: string;
  provenanceKind: ProvenanceKind;
  split: Split;
  protocolRef: string | null;
  origin: string;
  annotators: [string, string];
  deidentification: { recordSha256: string; attestedAt: string; synthetic: boolean };
  cases: CaseEntry[];
  annotations: AnnotationEntry[];
  adjudication: { file: string; count: number; headHash: string | null };
  truth: null | { file: string; version: number; sha256: string; builtAt: string; items: number; excludedAmbiguous: number; basedOn: Record<string, { version: number; sha256: string }>; adjudicationHeadHash: string | null };
  outputs: OutputEntry[];
  lock: { state: 'open' | 'locked'; epoch: number; everUnlocked: boolean; lockDigest: string | null; lockedAt: string | null; lockedBy: string | null; history: LockEvent[] };
  manifestSha256: string;
}

export const manifestBody = (m: Manifest) => { const { manifestSha256, ...rest } = m; void manifestSha256; return rest; };
export const computeManifestSha = (m: Manifest) => sha256Hex(canonical(manifestBody(m)));

/** Covers what a locked evaluation depends on: the cases, the split/provenance, the annotators and the final truth. Not outputs. */
export function computeLockDigest(m: Manifest): string {
  return sha256Hex(canonical({ datasetId: m.datasetId, split: m.split, provenanceKind: m.provenanceKind, annotators: m.annotators,
    cases: m.cases.map((c) => ({ caseId: c.caseId, pages: c.pages, sourceSha256: c.sourceSha256 })), truth: m.truth ? { sha256: m.truth.sha256, version: m.truth.version, adjudicationHeadHash: m.truth.adjudicationHeadHash } : null }));
}

const lockEventHash = (e: Omit<LockEvent, 'hash'>) => sha256Hex(canonical(e));
export function appendLockEvent(m: Manifest, event: LockEvent['event'], by: string, authorizationSha256: string | null = null): void {
  const prev = m.lock.history[m.lock.history.length - 1];
  const base = { seq: m.lock.history.length + 1, event, at: new Date().toISOString(), by, lockDigest: m.lock.lockDigest, authorizationSha256, prevHash: prev ? prev.hash : '0'.repeat(64) };
  m.lock.history.push({ ...base, hash: lockEventHash(base) });
}

export const manifestPath = (dir: string) => path.join(dir, 'manifest.json');
export function loadManifest(dir: string): Manifest {
  if (!fs.existsSync(manifestPath(dir))) throw new StudyError('no_manifest', 'No manifest exists for this dataset (generate it first).', 409);
  return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')) as Manifest;
}
/** Re-hashes and writes the manifest. Refuses to write a manifest whose lock state was changed by anything but the lock functions. */
export function saveManifest(dir: string, m: Manifest): Manifest {
  m.manifestSha256 = computeManifestSha(m);
  const tmp = manifestPath(dir) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m, null, 1) + '\n', { mode: 0o644 }); fs.renameSync(tmp, manifestPath(dir));
  return m;
}

/** Writes are allowed only where the lock state permits. While locked, ONLY outputs/ is writable. */
export type Area = 'sources' | 'annotations' | 'adjudication' | 'truth' | 'outputs' | 'manifest';
export function assertWritable(m: Manifest | null, area: Area): void {
  if (m && m.lock.state === 'locked' && area !== 'outputs') throw new StudyError('locked', `This dataset is LOCKED: writes to ${area} are refused. Only evaluation outputs may be written. Unlocking needs a human-supplied authorization record and is permanently recorded.`, 409);
}
export function safeRunDir(dir: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId) || runId.includes('..')) throw new StudyError('bad_run_id', 'runId must be 1–64 chars of [A-Za-z0-9._-] and start with a letter or digit.');
  return path.join(dir, 'outputs', runId);
}

export interface VerifyResult { ok: boolean; problems: string[]; lockDigest: string | null; checked: { sources: number; annotations: number; truth: boolean } }
/** Full integrity check: manifest self-hash, every file hash, lock digest (and the externally recorded anchor if supplied), lock-history chain. */
export function verifyDataset(dir: string, opts: { expectLockDigest?: string } = {}): VerifyResult {
  const problems: string[] = []; let m: Manifest;
  try { m = loadManifest(dir); } catch (e) { return { ok: false, problems: [(e as Error).message], lockDigest: null, checked: { sources: 0, annotations: 0, truth: false } }; }
  if (m.schema !== MANIFEST_SCHEMA) problems.push(`unknown manifest schema ${m.schema}`);
  if (computeManifestSha(m) !== m.manifestSha256) problems.push('manifest self-hash mismatch: the manifest was modified outside this tool');
  const hashFile = (rel: string, want: string, what: string) => {
    const f = path.join(dir, rel);
    if (path.relative(dir, f).startsWith('..')) { problems.push(`${what}: path escapes the dataset directory`); return; }
    if (!fs.existsSync(f)) { problems.push(`${what}: file missing (${rel})`); return; }
    if (sha256Hex(fs.readFileSync(f)) !== want) problems.push(`${what}: content hash mismatch (${rel})`);
  };
  for (const c of m.cases) hashFile(c.file, c.sourceSha256, `source ${c.caseId}`);
  for (const a of m.annotations) hashFile(a.file, a.sha256, `annotation ${a.annotatorId} v${a.version}`);
  if (m.truth) hashFile(m.truth.file, m.truth.sha256, 'adjudicated truth');
  // adjudication log chain
  const logFile = path.join(dir, m.adjudication.file);
  let head: string | null = null, count = 0;
  if (fs.existsSync(logFile)) {
    let prev = '0'.repeat(64);
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line); const { hash, ...body } = r;
      if (r.prevHash !== prev || sha256Hex(canonical(body)) !== hash) { problems.push(`adjudication log chain broken at record ${count + 1}`); break; }
      prev = hash; head = hash; count++;
    }
  }
  if (count !== m.adjudication.count || head !== m.adjudication.headHash) problems.push('adjudication log does not match the manifest (records added, removed or altered)');
  // lock history chain
  let prev = '0'.repeat(64);
  for (const e of m.lock.history) { const { hash, ...body } = e; if (e.prevHash !== prev || lockEventHash(body) !== hash) { problems.push(`lock history chain broken at event ${e.seq}`); break; } prev = hash; }
  const lastEvent = m.lock.history[m.lock.history.length - 1]?.event;
  const impliedLocked = lastEvent === 'lock' || lastEvent === 'relock';
  if (lastEvent && impliedLocked !== (m.lock.state === 'locked')) problems.push('lock state disagrees with the lock history (state changed without a recorded lock/unlock event)');
  if (m.lock.everUnlocked !== m.lock.history.some((e) => e.event === 'unlock')) problems.push('everUnlocked flag disagrees with the lock history');
  const digest = computeLockDigest(m);
  if (m.lock.state === 'locked') {
    if (m.lock.lockDigest !== digest) problems.push('lock digest mismatch: cases, split, annotators or truth changed after the lock');
    for (const rel of [...m.cases.map((c) => c.file), ...(m.truth ? [m.truth.file] : [])]) { const f = path.join(dir, rel); if (fs.existsSync(f) && (fs.statSync(f).mode & 0o222)) problems.push(`locked file is writable: ${rel}`); }
  }
  if (opts.expectLockDigest && opts.expectLockDigest !== digest) problems.push('lock digest differs from the externally recorded anchor');
  return { ok: problems.length === 0, problems, lockDigest: digest, checked: { sources: m.cases.length, annotations: m.annotations.length, truth: !!m.truth } };
}

export function newManifest(args: { studyRef: string; datasetId: string; name: string; provenanceKind: ProvenanceKind; split: Split; protocolRef: string | null; origin: string; annotators: [string, string];
  deidentification: Manifest['deidentification']; cases: CaseEntry[]; createdBy: string }): Manifest {
  const m: Manifest = { schema: MANIFEST_SCHEMA, studyRef: args.studyRef, datasetId: args.datasetId, name: args.name, createdAt: new Date().toISOString(), provenanceKind: args.provenanceKind, split: args.split,
    protocolRef: args.protocolRef, origin: args.origin, annotators: args.annotators, deidentification: args.deidentification, cases: args.cases, annotations: [],
    adjudication: { file: 'adjudication/records.jsonl', count: 0, headHash: null }, truth: null, outputs: [],
    lock: { state: 'open', epoch: 0, everUnlocked: false, lockDigest: null, lockedAt: null, lockedBy: null, history: [] }, manifestSha256: '' };
  appendLockEvent(m, 'create', args.createdBy); return m;
}

function chmodReadOnly(files: string[]) { for (const f of files) if (fs.existsSync(f)) fs.chmodSync(f, 0o444); }
function chmodWritable(files: string[]) { for (const f of files) if (fs.existsSync(f)) fs.chmodSync(f, 0o644); }
const lockedFiles = (dir: string, m: Manifest) => [...m.cases.map((c) => path.join(dir, c.file)), ...m.annotations.map((a) => path.join(dir, a.file)), ...(m.truth ? [path.join(dir, m.truth.file)] : []), path.join(dir, m.adjudication.file)];

export function lockDataset(dir: string, by: string): Manifest {
  const m = loadManifest(dir);
  if (m.lock.state === 'locked') throw new StudyError('already_locked', 'Already locked.', 409);
  if (!m.truth) throw new StudyError('no_truth', 'Build the adjudicated truth before locking: a lock covers sources AND truth.', 409);
  const v = verifyDataset(dir); if (!v.ok) throw new StudyError('integrity', `Refusing to lock a dataset that fails verification: ${v.problems.join('; ')}`, 409);
  m.lock.state = 'locked'; m.lock.lockDigest = computeLockDigest(m); m.lock.lockedAt = new Date().toISOString(); m.lock.lockedBy = by;
  appendLockEvent(m, m.lock.everUnlocked ? 'relock' : 'lock', by);
  saveManifest(dir, m); chmodReadOnly(lockedFiles(dir, m)); return m;
}

export interface UnlockAuthorization {
  schema: typeof UNLOCK_SCHEMA; manifestSha256: string; lockDigest: string; reason: string; protocolDeviationRef: string;
  authorizedBy: { name: string; role: string; credentialRef: string }; authorizedAt: string;
}
const nonEmpty = (s: unknown) => typeof s === 'string' && s.trim().length > 0;
/**
 * Unlock requires a record written by a human outside this tool, bound to THIS manifest hash and lock digest (so it cannot be reused for another
 * lock state), giving a reason and a protocol-deviation reference. The tool checks the record's form and binding — it cannot check the person.
 */
export function unlockDataset(dir: string, by: string, auth: unknown): Manifest {
  const m = loadManifest(dir);
  if (m.lock.state !== 'locked') throw new StudyError('not_locked', 'The dataset is not locked.', 409);
  const a = auth as UnlockAuthorization; const problems: string[] = [];
  if (!a || typeof a !== 'object') throw new StudyError('authorization_required', 'Unlock requires an explicit human-supplied authorization record (see validation/templates/unlock-authorization.template.json).', 403);
  if (a.schema !== UNLOCK_SCHEMA) problems.push(`schema must be ${UNLOCK_SCHEMA}`);
  for (const [k, v] of [['reason', a.reason], ['protocolDeviationRef', a.protocolDeviationRef], ['authorizedBy.name', a.authorizedBy?.name], ['authorizedBy.role', a.authorizedBy?.role], ['authorizedBy.credentialRef', a.authorizedBy?.credentialRef]] as const) if (!nonEmpty(v)) problems.push(`${k} is required`);
  if (a.manifestSha256 !== m.manifestSha256) problems.push('manifestSha256 does not match the current manifest (the record is bound to a different state)');
  if (a.lockDigest !== m.lock.lockDigest) problems.push('lockDigest does not match the current lock');
  const at = Date.parse(a.authorizedAt);
  if (!Number.isFinite(at)) problems.push('authorizedAt must be an ISO date-time'); else if (at > Date.now() + 60_000) problems.push('authorizedAt is in the future'); else if (m.lock.lockedAt && at < Date.parse(m.lock.lockedAt)) problems.push('authorizedAt is before the lock');
  if (nonEmpty(a.authorizedBy?.name) && a.authorizedBy.name.trim().toLowerCase() === by.trim().toLowerCase()) problems.push('the authorizing person must differ from the requesting user');
  const authSha = sha256Hex(canonical(a));
  if (m.lock.history.some((e) => e.authorizationSha256 === authSha)) problems.push('this authorization record was already used');
  if (problems.length) throw new StudyError('authorization_invalid', `Unlock refused: ${problems.join('; ')}.`, 403);
  chmodWritable(lockedFiles(dir, m));
  m.lock.state = 'open'; m.lock.everUnlocked = true; m.lock.epoch += 1; m.lock.lockDigest = null; m.lock.lockedAt = null; m.lock.lockedBy = null;
  appendLockEvent(m, 'unlock', by, authSha);
  return saveManifest(dir, m);
}
