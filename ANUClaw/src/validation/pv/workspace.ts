/**
 * Posture / monitoring VALIDATION workspaces (SYNTHETIC-ONLY tooling; file store; data-layer service with an ASSERTED user id — no HTTP route, no authentication).
 *
 *   register synthetic dataset → immutable source/hash/provenance manifest → reference annotations (append-only) → lock (digest recorded OUTSIDE) →
 *   repeated-run capture (model/config/environment hashes) → evaluation report (agreement, repeatability, missing outputs, quality gate, taxonomy) → export
 *
 * Synthetic-only enforcement: provenance must be declared `synthetic`; media must be a drawn SVG fixture (marker comment + data-synthetic) or a JSON scenario with `"synthetic": true`;
 * anything that looks like a photograph, recording or archive is refused by magic bytes whatever the declared type. Roles: owner, annotator (reference), runner (system under test;
 * blind to references), statistician (evaluate/export), auditor. No acceptance, approval or release function exists.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { repeatability, evaluatePose, PoseReferenceSet, PoseResultSet } from '../pose-eval';
import { canonical, sha256Hex, StudyError, UNLOCK_SCHEMA, UnlockAuthorization } from '../study/manifest';
import { classifyReason, ERROR_CLASSES, TAXONOMY_NOTE } from './taxonomy';
import { MON_NOTICE, MonExpectation, AlertExpectation, MonitoringScenario, observeScenario } from './monitoring';

export const PV_NOTICE = 'Synthetic validation tooling only — drawn/parametric fixtures and simulated data do not establish accuracy on humans or devices, clinical validation or release approval.';
export type PvRole = 'owner' | 'annotator' | 'runner' | 'statistician' | 'auditor';
export type PvKind = 'posture' | 'monitoring';
export interface PvActor { userId: string; scope: { kind: 'tenant' | 'user'; id: string } }
interface WsDoc { id: string; name: string; purpose: string; createdAt: string; members: Array<{ userId: string; roles: PvRole[] }> }
interface RunEntry { runId: string; mode: 'development' | 'locked'; repeat: number; at: string; by: string; resultsSha256: string; file: string; system: { pipeline: string; modelVersion: string; modelSha256: string; configSha256: string; environmentSha256: string }; lockDigestAtRun: string | null; lockEpochAtRun: number }
interface LockEvent { seq: number; event: 'create' | 'lock' | 'unlock' | 'relock'; at: string; by: string; lockDigest: string | null; authorizationSha256: string | null; prevHash: string; hash: string }
export interface PvManifest {
  schema: 'anuclaw-pv-manifest/v1'; datasetId: string; kind: PvKind; name: string; split: 'development' | 'locked_validation'; createdAt: string; createdBy: string; provenance: { kind: 'synthetic'; generator: string; statement: string };
  cases: Array<{ caseId: string; mediaType: string; sha256: string; bytes: number; file: string }>; annotations: Array<{ annotatorId: string; version: number; sha256: string; file: string; at: string }>; runs: RunEntry[];
  lock: { state: 'open' | 'locked'; epoch: number; everUnlocked: boolean; lockDigest: string | null; history: LockEvent[] }; manifestSha256: string;
}
const ID = /^[A-Za-z0-9._-]{1,64}$/; const zero = '0'.repeat(64);
const safeSeg = (s: string) => (ID.test(s) ? s : `x-${sha256Hex(s).slice(0, 16)}`);
const manifestBody = (m: PvManifest) => { const { manifestSha256, ...r } = m; void manifestSha256; return r; };
const msha = (m: PvManifest) => sha256Hex(canonical(manifestBody(m)));
export const lockDigestOf = (m: PvManifest) => sha256Hex(canonical({ datasetId: m.datasetId, kind: m.kind, split: m.split, provenance: m.provenance, cases: m.cases.map((c) => ({ caseId: c.caseId, sha256: c.sha256 })), annotation: m.annotations.length ? m.annotations[m.annotations.length - 1].sha256 : null }));
const evHash = (e: Omit<LockEvent, 'hash'>) => sha256Hex(canonical(e));
const MEDIA = ['image/svg+xml', 'application/json'];
/** Refuses anything that is not a drawn SVG fixture or a synthetic JSON scenario. */
export function assertSyntheticMedia(bytes: Buffer, mediaType: string): void {
  if (!MEDIA.includes(mediaType)) throw new StudyError('real_media_refused', `media type "${mediaType}" is refused: only drawn SVG fixtures and synthetic JSON scenarios are accepted (no photographs, recordings or video).`, 400);
  const m = (...b: number[]) => b.every((x, i) => bytes[i] === x);
  const bin = m(0xff, 0xd8, 0xff) ? 'JPEG' : m(0x89, 0x50, 0x4e, 0x47) ? 'PNG' : m(0x47, 0x49, 0x46, 0x38) ? 'GIF' : bytes.subarray(4, 8).toString('latin1') === 'ftyp' ? 'MP4/MOV' : m(0x1a, 0x45, 0xdf, 0xa3) ? 'WebM/Matroska' : m(0x52, 0x49, 0x46, 0x46) ? 'RIFF (AVI/WAV/WebP)' : m(0x50, 0x4b, 0x03, 0x04) ? 'zip archive' : m(0x1f, 0x8b) ? 'gzip' : m(0x49, 0x44, 0x33) ? 'MP3' : null;
  if (bin) throw new StudyError('real_media_refused', `content looks like ${bin}: photographs, recordings, video and archives are refused whatever the declared type.`, 400);
  const text = bytes.toString('utf8');
  if (mediaType === 'image/svg+xml') { if (!/<!-- SYNTHETIC-DRAWN-FIXTURE /.test(text) || !/data-synthetic="true"/.test(text)) throw new StudyError('not_synthetic', 'an SVG must carry the SYNTHETIC-DRAWN-FIXTURE marker and data-synthetic="true".', 400); if (/<image\b|href="data:|xlink:href/i.test(text)) throw new StudyError('real_media_refused', 'embedded raster images are refused.', 400); }
  else { let o: { synthetic?: unknown }; try { o = JSON.parse(text); } catch { throw new StudyError('not_synthetic', 'JSON scenario is not valid JSON.', 400); } if (o.synthetic !== true) throw new StudyError('not_synthetic', 'a JSON scenario must declare "synthetic": true.', 400); }
}

export class PvWorkspaces {
  constructor(private readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  private scopeDir(s: PvActor['scope']) { return path.join(this.root, `${s.kind}-${safeSeg(s.id)}`); }
  private audit(a: PvActor, ws: string, action: string, detail: Record<string, unknown> = {}) {
    const f = path.join(this.scopeDir(a.scope), ws, 'audit.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); let prev = zero, seq = 0;
    if (fs.existsSync(f)) { const l = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); if (l.length) { const e = JSON.parse(l[l.length - 1]); prev = e.hash; seq = e.seq; } }
    const base = { seq: seq + 1, at: new Date().toISOString(), userId: a.userId, action, detail, prevHash: prev }; fs.appendFileSync(f, JSON.stringify({ ...base, hash: sha256Hex(canonical(base)) }) + '\n', { mode: 0o600 });
  }
  private open(a: PvActor, wsId: string, need: PvRole[], action: string): { doc: WsDoc; dir: string; roles: PvRole[] } {
    const deny = (): never => { const f = path.join(this.scopeDir(a.scope), '_denied.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), userId: a.userId, action }) + '\n'); throw new StudyError('not_found', 'Workspace or dataset not found.', 404); };
    if (!/^pw-[0-9a-f]{12}$/.test(wsId)) return deny(); const dir = path.join(this.scopeDir(a.scope), wsId); const f = path.join(dir, 'workspace.json'); if (!fs.existsSync(f)) return deny();
    const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as WsDoc; const me = doc.members.find((m) => m.userId === a.userId); if (!me) return deny();
    if (!need.some((r) => me.roles.includes(r))) { this.audit(a, wsId, `denied:${action}`, { needs: need }); throw new StudyError('forbidden', `Requires one of: ${need.join(', ')}.`, 403); } return { doc, dir, roles: me.roles };
  }
  private dsDir(dir: string, ds: string) { if (!/^pd-[0-9a-f]{12}$/.test(ds)) throw new StudyError('not_found', 'Dataset not found.', 404); const d = path.join(dir, 'datasets', ds); if (!fs.existsSync(d)) throw new StudyError('not_found', 'Dataset not found.', 404); return d; }
  private load(d: string): PvManifest { return JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')); }
  private save(d: string, m: PvManifest) { m.manifestSha256 = msha(m); const t = path.join(d, 'manifest.json.tmp'); fs.writeFileSync(t, JSON.stringify(m, null, 1) + '\n', { mode: 0o644 }); fs.renameSync(t, path.join(d, 'manifest.json')); return m; }
  private lockEvent(m: PvManifest, event: LockEvent['event'], by: string, auth: string | null = null) { const prev = m.lock.history[m.lock.history.length - 1]; const base = { seq: m.lock.history.length + 1, event, at: new Date().toISOString(), by, lockDigest: m.lock.lockDigest, authorizationSha256: auth, prevHash: prev?.hash ?? zero }; m.lock.history.push({ ...base, hash: evHash(base) }); }
  private writable(m: PvManifest, what: string) { if (m.lock.state === 'locked') throw new StudyError('locked', `The dataset is LOCKED: ${what} is refused. Unlocking needs a human-written, single-use authorization record.`, 409); }

  createWorkspace(a: PvActor, name: string, purpose: string): WsDoc {
    if (!name?.trim() || !purpose?.trim()) throw new StudyError('bad_input', 'name and purpose are required.');
    const id = `pw-${crypto.randomBytes(6).toString('hex')}`; const dir = path.join(this.scopeDir(a.scope), id); fs.mkdirSync(path.join(dir, 'datasets'), { recursive: true, mode: 0o700 });
    const doc: WsDoc = { id, name, purpose, createdAt: new Date().toISOString(), members: [{ userId: a.userId, roles: ['owner'] }] }; fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(doc, null, 1), { mode: 0o600 }); this.audit(a, id, 'workspace_created', { name }); return doc;
  }
  addMember(a: PvActor, wsId: string, userId: string, roles: PvRole[]) {
    const { doc, dir } = this.open(a, wsId, ['owner'], 'add_member'); if (!ID.test(userId) || !roles.length || roles.some((r) => !['owner', 'annotator', 'runner', 'statistician', 'auditor'].includes(r))) throw new StudyError('bad_input', 'valid userId and roles are required.');
    if (roles.includes('annotator') && roles.includes('runner')) throw new StudyError('bad_input', 'a reference annotator cannot also run the system under test (blinding).');
    const m = doc.members.find((x) => x.userId === userId); if (m) { const merged = [...new Set([...m.roles, ...roles])]; if (merged.includes('annotator') && merged.includes('runner')) throw new StudyError('bad_input', 'a reference annotator cannot also run the system under test (blinding).'); m.roles = merged; } else doc.members.push({ userId, roles });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(doc, null, 1), { mode: 0o600 }); this.audit(a, wsId, 'member_added', { userId, roles });
  }
  registerDataset(a: PvActor, wsId: string, x: { kind: PvKind; name: string; split: 'development' | 'locked_validation'; provenance: { kind: string; generator: string; statement: string }; cases: Array<{ bytes: Buffer; mediaType: string }> }): { datasetId: string; caseIds: string[] } {
    const { dir } = this.open(a, wsId, ['owner'], 'register_dataset');
    if (x.provenance?.kind !== 'synthetic') throw new StudyError('real_data_refused', 'Only datasets declared synthetic are accepted. Real people, recordings and devices are out of scope until an approved protocol, consent and storage exist.', 400);
    if (!['posture', 'monitoring'].includes(x.kind) || !['development', 'locked_validation'].includes(x.split) || !x.name?.trim() || !x.provenance.generator?.trim() || !x.provenance.statement?.trim()) throw new StudyError('bad_input', 'kind, split, name and provenance.generator/statement are required.');
    if (!x.cases?.length || x.cases.length > 200) throw new StudyError('bad_input', '1–200 cases are required.'); let total = 0;
    for (const c of x.cases) { if (!Buffer.isBuffer(c.bytes) || !c.bytes.length || c.bytes.length > 262_144) throw new StudyError('too_large', 'each case must be 1–256 KiB.', 413); total += c.bytes.length; assertSyntheticMedia(c.bytes, c.mediaType); }
    if (total > 8_000_000) throw new StudyError('too_large', 'dataset exceeds 8 MB.', 413);
    const datasetId = `pd-${crypto.randomBytes(6).toString('hex')}`; const d = path.join(dir, 'datasets', datasetId); fs.mkdirSync(path.join(d, 'sources'), { recursive: true, mode: 0o700 });
    const cases = x.cases.map((c) => { const caseId = `c-${crypto.randomBytes(5).toString('hex')}`; const file = `sources/${caseId}`; fs.writeFileSync(path.join(d, file), c.bytes, { mode: 0o444 }); return { caseId, mediaType: c.mediaType, sha256: sha256Hex(c.bytes), bytes: c.bytes.length, file }; });
    const m: PvManifest = { schema: 'anuclaw-pv-manifest/v1', datasetId, kind: x.kind, name: x.name, split: x.split, createdAt: new Date().toISOString(), createdBy: a.userId, provenance: { kind: 'synthetic', generator: x.provenance.generator, statement: x.provenance.statement }, cases, annotations: [], runs: [], lock: { state: 'open', epoch: 0, everUnlocked: false, lockDigest: null, history: [] }, manifestSha256: '' };
    this.lockEvent(m, 'create', a.userId); this.save(d, m); this.audit(a, wsId, 'dataset_registered', { datasetId, kind: x.kind, cases: cases.length }); return { datasetId, caseIds: cases.map((c) => c.caseId) };
  }
  manifest(a: PvActor, wsId: string, ds: string): PvManifest { const { dir } = this.open(a, wsId, ['owner', 'statistician', 'auditor'], 'manifest'); return this.load(this.dsDir(dir, ds)); }
  /** Annotators/runners see only the opaque case ids and media (never references, runs or results). */
  listCases(a: PvActor, wsId: string, ds: string) { const { dir } = this.open(a, wsId, ['owner', 'annotator', 'runner'], 'list_cases'); return this.load(this.dsDir(dir, ds)).cases.map((c) => ({ caseId: c.caseId, mediaType: c.mediaType, sha256: c.sha256 })); }
  readCase(a: PvActor, wsId: string, ds: string, caseId: string): Buffer {
    const { dir } = this.open(a, wsId, ['owner', 'annotator', 'runner'], 'read_case'); const d = this.dsDir(dir, ds); const c = this.load(d).cases.find((x) => x.caseId === caseId); if (!c) throw new StudyError('not_found', 'No such case.', 404);
    const b = fs.readFileSync(path.join(d, c.file)); if (sha256Hex(b) !== c.sha256) throw new StudyError('integrity', 'case bytes no longer match their recorded hash.', 409); return b;
  }
  /** Reference annotations: append-only versions by the assigned annotator. Posture: measurable items or unmeasurable reasons. Monitoring: expected outcomes. */
  importReference(a: PvActor, wsId: string, ds: string, file: { schema: 'anuclaw-pv-reference/v1'; method: string; items?: Array<{ caseId: string; metricKey: string; unit: string; referenceValue: number; referenceUncertainty?: number }>; unmeasurable?: Array<{ caseId: string; reason: string }>; monitoring?: { expectations: MonExpectation[]; alertExpectations: AlertExpectation[] } }) {
    const { dir } = this.open(a, wsId, ['annotator'], 'import_reference'); const d = this.dsDir(dir, ds); const m = this.load(d); this.writable(m, 'a reference annotation');
    const ids = new Set(m.cases.map((c) => c.caseId)); const p: string[] = []; if (file?.schema !== 'anuclaw-pv-reference/v1' || !file.method?.trim()) p.push('schema anuclaw-pv-reference/v1 and a reference method are required');
    for (const i of file?.items ?? []) { if (!ids.has(i.caseId)) p.push(`unknown case ${i.caseId}`); if (!Number.isFinite(i.referenceValue)) p.push(`non-finite reference for ${i.caseId}`); } for (const u of file?.unmeasurable ?? []) if (!ids.has(u.caseId)) p.push(`unknown case ${u.caseId}`);
    if (m.kind === 'monitoring' && !file?.monitoring) p.push('a monitoring dataset needs monitoring expectations'); if (m.kind === 'posture' && !file?.items?.length) p.push('a posture dataset needs reference items');
    if (p.length) throw new StudyError('bad_input', p.slice(0, 15).join('; '));
    const version = m.annotations.filter((x) => x.annotatorId === a.userId).length + 1; const rel = `annotations/${a.userId}/v${version}.json`; fs.mkdirSync(path.join(d, 'annotations', a.userId), { recursive: true, mode: 0o700 });
    const text = JSON.stringify(file, null, 1) + '\n'; fs.writeFileSync(path.join(d, rel), text, { mode: 0o444, flag: 'wx' }); m.annotations.push({ annotatorId: a.userId, version, sha256: sha256Hex(text), file: rel, at: new Date().toISOString() }); this.save(d, m);
    this.audit(a, wsId, 'reference_imported', { datasetId: ds, version, sha256: sha256Hex(text) }); return { version, sha256: sha256Hex(text) };
  }
  verify(a: PvActor, wsId: string, ds: string, opts: { expectLockDigest?: string } = {}): { ok: boolean; problems: string[]; lockDigest: string } {
    const { dir } = this.open(a, wsId, ['owner', 'statistician', 'auditor'], 'verify'); const d = this.dsDir(dir, ds); const m = this.load(d); const p: string[] = [];
    if (m.lock.state === 'locked' && !opts.expectLockDigest) throw new StudyError('expected_lock_digest_required', 'Verifying a locked dataset requires the lock digest recorded OUTSIDE this system. Anyone with write access to the study directory can rewrite the manifest and its hashes, so the repository-local manifest cannot prove its own authenticity.', 400);
    if (msha(m) !== m.manifestSha256) p.push('manifest self-hash mismatch');
    for (const c of m.cases) { const f = path.join(d, c.file); if (!fs.existsSync(f)) p.push(`source missing: ${c.caseId}`); else if (sha256Hex(fs.readFileSync(f)) !== c.sha256) p.push(`source hash mismatch: ${c.caseId}`); }
    for (const x of m.annotations) { const f = path.join(d, x.file); if (!fs.existsSync(f) || sha256Hex(fs.readFileSync(f)) !== x.sha256) p.push(`annotation v${x.version} hash mismatch`); }
    for (const r of m.runs) { const f = path.join(d, r.file); if (!fs.existsSync(f) || sha256Hex(fs.readFileSync(f)) !== r.resultsSha256) p.push(`run ${r.runId} results hash mismatch`); }
    let prev = zero; for (const e of m.lock.history) { const { hash, ...b } = e; if (e.prevHash !== prev || evHash(b) !== hash) { p.push(`lock history broken at ${e.seq}`); break; } prev = hash; }
    const last = m.lock.history[m.lock.history.length - 1]?.event; if (last && (last === 'lock' || last === 'relock') !== (m.lock.state === 'locked')) p.push('lock state disagrees with the lock history');
    const digest = lockDigestOf(m); if (m.lock.state === 'locked' && m.lock.lockDigest !== digest) p.push('lock digest mismatch: cases, provenance or reference changed after the lock'); if (opts.expectLockDigest && opts.expectLockDigest !== digest) p.push('lock digest differs from the externally recorded anchor');
    this.audit(a, wsId, 'verified', { datasetId: ds, ok: p.length === 0 }); return { ok: p.length === 0, problems: p, lockDigest: digest };
  }
  lock(a: PvActor, wsId: string, ds: string): { lockDigest: string; note: string } {
    const { dir } = this.open(a, wsId, ['owner'], 'lock'); const d = this.dsDir(dir, ds); const m = this.load(d); if (m.lock.state === 'locked') throw new StudyError('already_locked', 'Already locked.', 409); if (!m.annotations.length) throw new StudyError('no_reference', 'Import the reference annotation before locking.', 409);
    const v = this.verify(a, wsId, ds); if (!v.ok) throw new StudyError('integrity', `Refusing to lock: ${v.problems.join('; ')}`, 409);
    m.lock.state = 'locked'; m.lock.lockDigest = lockDigestOf(m); this.lockEvent(m, m.lock.everUnlocked ? 'relock' : 'lock', a.userId); this.save(d, m);
    for (const f of [...m.cases.map((c) => c.file), ...m.annotations.map((x) => x.file)]) fs.chmodSync(path.join(d, f), 0o444); this.audit(a, wsId, 'locked', { datasetId: ds, lockDigest: m.lock.lockDigest });
    return { lockDigest: m.lock.lockDigest!, note: 'Record this digest OUTSIDE this system (e.g. in the signed preregistration) and verify against it.' };
  }
  unlock(a: PvActor, wsId: string, ds: string, auth: unknown): PvManifest {
    const { dir } = this.open(a, wsId, ['owner'], 'unlock'); const d = this.dsDir(dir, ds); const m = this.load(d); if (m.lock.state !== 'locked') throw new StudyError('not_locked', 'The dataset is not locked.', 409);
    const x = auth as UnlockAuthorization; if (!x || typeof x !== 'object') throw new StudyError('authorization_required', 'Unlock requires a human-written authorization record.', 403); const p: string[] = [];
    if (x.schema !== UNLOCK_SCHEMA) p.push('wrong schema'); for (const [k, v] of [['reason', x.reason], ['protocolDeviationRef', x.protocolDeviationRef], ['authorizedBy.name', x.authorizedBy?.name], ['authorizedBy.role', x.authorizedBy?.role], ['authorizedBy.credentialRef', x.authorizedBy?.credentialRef]] as const) if (typeof v !== 'string' || !v.trim()) p.push(`${k} is required`);
    if (x.manifestSha256 !== m.manifestSha256) p.push('manifestSha256 does not match the current manifest'); if (x.lockDigest !== m.lock.lockDigest) p.push('lockDigest does not match the current lock');
    const at = Date.parse(x.authorizedAt); if (!Number.isFinite(at)) p.push('authorizedAt invalid'); else if (at > Date.now() + 60_000) p.push('authorizedAt is in the future');
    if (typeof x.authorizedBy?.name === 'string' && x.authorizedBy.name.trim().toLowerCase() === a.userId.toLowerCase()) p.push('the authorizing person must differ from the requesting user');
    const sha = sha256Hex(canonical(x)); if (m.lock.history.some((e) => e.authorizationSha256 === sha)) p.push('this authorization record was already used');
    if (p.length) { this.audit(a, wsId, 'unlock_refused', { datasetId: ds }); throw new StudyError('authorization_invalid', `Unlock refused: ${p.join('; ')}.`, 403); }
    for (const f of [...m.cases.map((c) => c.file), ...m.annotations.map((y) => y.file)]) fs.chmodSync(path.join(d, f), 0o644); m.lock.state = 'open'; m.lock.everUnlocked = true; m.lock.epoch++; m.lock.lockDigest = null; this.lockEvent(m, 'unlock', a.userId, sha); this.audit(a, wsId, 'UNLOCKED', { datasetId: ds, authorizationSha256: sha }); return this.save(d, m);
  }
  /** One run = one repeat of the system under test. model/config/environment are hashed HERE from the supplied objects (the caller cannot assert a hash). */
  captureRun(a: PvActor, wsId: string, ds: string, x: { runId: string; mode: 'development' | 'locked'; expectLockDigest?: string; system: { pipeline: string; modelVersion: string; modelSha256: string; config: unknown; environment: unknown }; results: unknown }) {
    const { dir } = this.open(a, wsId, ['runner'], 'capture_run'); const d = this.dsDir(dir, ds); const m = this.load(d);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x.runId)) throw new StudyError('bad_run_id', 'runId must be 1–64 chars of [A-Za-z0-9._-].'); if (m.runs.some((r) => r.runId === x.runId)) throw new StudyError('run_exists', 'runs are never overwritten.', 409);
    if (x.mode === 'development' && m.split !== 'development') throw new StudyError('split_forbidden', 'Development runs are allowed only on the development split.', 403);
    if (x.mode === 'locked') { if (m.lock.state !== 'locked') throw new StudyError('not_locked', 'A locked run requires the dataset to be locked.', 409); if (!x.expectLockDigest) throw new StudyError('expected_lock_digest_required', 'A locked run requires the externally recorded lock digest.', 400); const v = this.verifyForRun(d, m, x.expectLockDigest); if (v.length) throw new StudyError('integrity', `verification failed: ${v.join('; ')}`, 409); }
    else if (x.mode !== 'development') throw new StudyError('bad_input', 'mode must be development or locked.');
    if (!x.system?.pipeline || !x.system.modelVersion || !/^[0-9a-f]{64}$/.test(x.system.modelSha256 ?? '')) throw new StudyError('bad_input', 'system.pipeline, modelVersion and a 64-hex modelSha256 are required.'); if (x.system.config === undefined || x.system.environment === undefined) throw new StudyError('bad_input', 'system.config and system.environment are required (they are hashed into the run record).');
    const ids = new Set(m.cases.map((c) => c.caseId)); const bad = JSON.stringify(x.results ?? null); if (bad.length > 5_000_000) throw new StudyError('too_large', 'results too large.', 413);
    const r = x.results as { items?: Array<{ clipId?: string; caseId?: string }>; observed?: Record<string, unknown> }; for (const i of r?.items ?? []) { const id = i.clipId ?? i.caseId; if (!id || !ids.has(id)) throw new StudyError('bad_input', 'results reference an unknown case.'); }
    const rel = `runs/${x.runId}.json`; fs.mkdirSync(path.join(d, 'runs'), { recursive: true, mode: 0o700 }); const text = JSON.stringify(x.results, null, 1) + '\n'; fs.writeFileSync(path.join(d, rel), text, { mode: 0o444, flag: 'wx' });
    const repeat = m.runs.filter((q) => q.mode === x.mode).length + 1;
    m.runs.push({ runId: x.runId, mode: x.mode, repeat, at: new Date().toISOString(), by: a.userId, resultsSha256: sha256Hex(text), file: rel, system: { pipeline: x.system.pipeline, modelVersion: x.system.modelVersion, modelSha256: x.system.modelSha256, configSha256: sha256Hex(canonical(x.system.config)), environmentSha256: sha256Hex(canonical(x.system.environment)) }, lockDigestAtRun: m.lock.lockDigest, lockEpochAtRun: m.lock.epoch });
    this.save(d, m); this.audit(a, wsId, 'run_captured', { datasetId: ds, runId: x.runId, mode: x.mode }); return { repeat, resultsSha256: sha256Hex(text) };
  }
  private verifyForRun(d: string, m: PvManifest, expect: string): string[] { const p: string[] = []; if (msha(m) !== m.manifestSha256) p.push('manifest self-hash mismatch'); for (const c of m.cases) if (sha256Hex(fs.readFileSync(path.join(d, c.file))) !== c.sha256) p.push('source hash mismatch'); if (lockDigestOf(m) !== expect) p.push('lock digest differs from the externally recorded anchor'); if (m.lock.lockDigest !== lockDigestOf(m)) p.push('lock digest mismatch'); return p; }

  evaluate(a: PvActor, wsId: string, ds: string, opts: { runIds?: string[]; expectLockDigest?: string; disagreementTolerance?: Record<string, number>; minPairsPerMetric?: number; minSubjects?: number } = {}) {
    const { dir } = this.open(a, wsId, ['statistician'], 'evaluate'); const d = this.dsDir(dir, ds); const m = this.load(d); const v = this.verify(a, wsId, ds, { expectLockDigest: m.lock.state === 'locked' ? opts.expectLockDigest : undefined }); if (!v.ok) throw new StudyError('integrity', `Verification failed; nothing was evaluated: ${v.problems.join('; ')}`, 409);
    if (!m.annotations.length) throw new StudyError('no_reference', 'No reference annotation.', 409); const ref = JSON.parse(fs.readFileSync(path.join(d, m.annotations[m.annotations.length - 1].file), 'utf8'));
    const runs = m.runs.filter((r) => !opts.runIds || opts.runIds.includes(r.runId)); if (!runs.length) throw new StudyError('no_runs', 'No runs to evaluate.', 409);
    const loaded = runs.map((r) => ({ r, res: JSON.parse(fs.readFileSync(path.join(d, r.file), 'utf8')) })); const sysIds = new Set(runs.map((r) => canonical(r.system))); const mixed = sysIds.size > 1;
    const body = m.kind === 'posture' ? this.evalPosture(m, ref, loaded, opts) : this.evalMonitoring(m, ref, loaded);
    const report = { schema: 'anuclaw-pv-report/v1', notice: m.kind === 'posture' ? PV_NOTICE : `${PV_NOTICE} ${MON_NOTICE}`, kind: m.kind, provenance: { datasetId: m.datasetId, split: m.split, manifestSha256: m.manifestSha256, lockState: m.lock.state, lockDigest: m.lock.lockDigest, everUnlocked: m.lock.everUnlocked, referenceVersion: m.annotations.length, referenceSha256: m.annotations[m.annotations.length - 1].sha256, syntheticOnly: true,
      runs: runs.map((r) => ({ runId: r.runId, mode: r.mode, repeat: r.repeat, resultsSha256: r.resultsSha256, ...r.system })), mixedSystemIdentities: mixed, mixedWarning: mixed ? 'runs come from DIFFERENT model/config/environment hashes; repeatability across them is not meaningful' : null, generatedAt: new Date().toISOString(), generatedBy: a.userId },
      ...body, errorTaxonomyNote: TAXONOMY_NOTE, acceptance: { status: 'not_assessed_by_this_tool', statement: 'No acceptance, approval or release is made or implied. Synthetic or mannequin response does not prove human accuracy.' } };
    const text = JSON.stringify(report, null, 1) + '\n'; this.audit(a, wsId, 'evaluated', { datasetId: ds, reportSha256: sha256Hex(text) }); return { report, reportSha256: sha256Hex(text), text };
  }
  private evalPosture(m: PvManifest, ref: { method: string; items: Array<{ caseId: string; metricKey: string; unit: string; referenceValue: number; referenceUncertainty?: number }>; unmeasurable?: Array<{ caseId: string; reason: string }> }, loaded: Array<{ r: RunEntry; res: { items: Array<{ clipId: string; subjectId: string; repeat: number; metricKey: string; unit: string; status: 'estimate' | 'unsupported' | 'not_measurable'; value?: number; uncertainty?: number; reason?: string }>; captureFailures?: Array<{ caseId: string }> } }>, opts: { disagreementTolerance?: Record<string, number>; minPairsPerMetric?: number; minSubjects?: number }) {
    const subj = (id: string) => `s-${id}`; const refSet: PoseReferenceSet = { schema: 'anuclaw-pose-reference/v1', provenance: { kind: 'synthetic_fixture', referenceMethod: ref.method, referenceIndependentOfSystem: true }, items: ref.items.map((i) => ({ clipId: i.caseId, subjectId: subj(i.caseId), metricKey: i.metricKey, unit: i.unit, referenceValue: i.referenceValue, referenceUncertainty: i.referenceUncertainty })) };
    const unm = new Map((ref.unmeasurable ?? []).map((u) => [u.caseId, u.reason])); const measurable = new Set(ref.items.map((i) => i.caseId));
    const perRun = loaded.map(({ r, res }) => { const rs: PoseResultSet = { schema: 'anuclaw-pose-results/v1', system: { pipeline: r.system.pipeline, modelVersion: r.system.modelVersion }, items: res.items.filter((i) => measurable.has(i.clipId)).map((i) => ({ clipId: i.clipId, subjectId: subj(i.clipId), repeat: r.repeat, metricKey: i.metricKey, unit: i.unit, status: i.status, value: i.value, uncertainty: i.uncertainty })) }; return { run: r.runId, agreement: evaluatePose(refSet, rs, { minPairsPerMetric: opts.minPairsPerMetric, minSubjects: opts.minSubjects }).agreement }; });
    const groups = new Map<string, Map<string, number[]>>(); for (const { res } of loaded) for (const i of res.items) { if (i.status !== 'estimate' || typeof i.value !== 'number' || !measurable.has(i.clipId)) continue; const g = groups.get(i.metricKey) ?? groups.set(i.metricKey, new Map()).get(i.metricKey)!; (g.get(i.clipId) ?? g.set(i.clipId, []).get(i.clipId)!).push(i.value); }
    const rep = [...groups].sort((x, y) => x[0].localeCompare(y[0])).map(([k, g]) => ({ metricKey: k, ...repeatability([...g.values()]) }));
    const tax: Record<string, number> = Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0])); const gate = { measurableCases: measurable.size, unmeasurableCases: unm.size, correctlyUnsupported: 0, falseRejections: 0, measurementsWhereUnmeasurable: 0, unmeasurableWithoutReasonCode: 0, reasonCodeMismatches: 0 }; const critical: Array<{ runId: string; caseId: string; finding: string }> = [];
    const missing = { referenceItems: 0, perRun: [] as Array<{ runId: string; absent: number; unsupported: number; captureFailures: number }> };
    for (const { r, res } of loaded) { let absent = 0, uns = 0; const byCase = new Map<string, typeof res.items>(); for (const i of res.items) (byCase.get(i.clipId) ?? byCase.set(i.clipId, []).get(i.clipId)!).push(i);
      for (const c of m.cases) { const items = byCase.get(c.caseId) ?? []; const isMeasurable = measurable.has(c.caseId);
        if (isMeasurable) { for (const ri of ref.items.filter((x) => x.caseId === c.caseId)) { const it = items.find((x) => x.metricKey === ri.metricKey); if (!it) { absent++; tax.missing_output++; } else if (it.status !== 'estimate') { uns++; gate.falseRejections++; tax.false_rejection++; tax[classifyReason(it.reason)]++; critical.push({ runId: r.runId, caseId: c.caseId, finding: 'false rejection of a measurable case' }); } else { const tol = opts.disagreementTolerance?.[ri.metricKey]; if (tol !== undefined && Math.abs((it.value as number) - ri.referenceValue) > tol) tax.disagreement++; } }
          if (!items.length) critical.push({ runId: r.runId, caseId: c.caseId, finding: 'no output at all for a measurable case' }); }
        else if (unm.has(c.caseId)) { const est = items.filter((x) => x.status === 'estimate'); if (est.length) { gate.measurementsWhereUnmeasurable++; tax.gate_violation_measurement_where_unmeasurable++; critical.push({ runId: r.runId, caseId: c.caseId, finding: 'CRITICAL: a measurement was emitted for a recording that should have been rejected' }); }
          else if (items.length) { gate.correctlyUnsupported++; for (const it of items) { if (!it.reason) { gate.unmeasurableWithoutReasonCode++; tax.unclassified++; } else { tax[classifyReason(it.reason)]++; } } } else { absent++; tax.missing_output++; } } }
      missing.referenceItems = ref.items.length; missing.perRun.push({ runId: r.runId, absent, unsupported: uns, captureFailures: res.captureFailures?.length ?? 0 }); for (const f of res.captureFailures ?? []) tax.capture_failure++; }
    return { reference: { method: ref.method, items: ref.items.length, unmeasurableCases: unm.size, tolerancesSupplied: Object.keys(opts.disagreementTolerance ?? {}), note: 'no tolerance or sample size is chosen by this tool; agreement is descriptive' }, agreement: perRun, repeatability: rep, qualityGate: gate, missingOutputs: missing, errorTaxonomy: tax, criticalFindings: critical, unmeasurableReasons: Object.fromEntries([...unm].map(([k, v]) => [k, v])) };
  }
  private evalMonitoring(m: PvManifest, ref: { monitoring?: { expectations: MonExpectation[]; alertExpectations: AlertExpectation[] } }, loaded: Array<{ r: RunEntry; res: { observed: Record<string, { checkpoints: Array<{ checkpoint: string; state: string; valueExposed: boolean; sourceAge: string | null; receiptAge: string | null }>; invariantViolations: string[]; alert?: { finalState: string; escalated: boolean } }> } }>) {
    const exp = ref.monitoring?.expectations ?? []; const aexp = ref.monitoring?.alertExpectations ?? []; const mismatches: Array<{ runId: string; caseKey: string; checkpoint: string; expected: unknown; observed: unknown }> = []; const violations: Array<{ runId: string; caseKey: string; violation: string }> = []; let compared = 0; let alertMismatch = 0;
    for (const { r, res } of loaded) { for (const e of exp) { const o = res.observed?.[e.caseKey]?.checkpoints?.find((c) => c.checkpoint === e.checkpoint); compared++;
        if (!o) { mismatches.push({ runId: r.runId, caseKey: e.caseKey, checkpoint: e.checkpoint, expected: e, observed: 'missing' }); continue; }
        if (o.state !== e.expectedState || o.valueExposed !== e.expectedValueExposed || (e.expectedSourceAge && o.sourceAge !== e.expectedSourceAge) || (e.expectedReceiptAge && o.receiptAge !== e.expectedReceiptAge)) mismatches.push({ runId: r.runId, caseKey: e.caseKey, checkpoint: e.checkpoint, expected: { state: e.expectedState, valueExposed: e.expectedValueExposed, sourceAge: e.expectedSourceAge, receiptAge: e.expectedReceiptAge }, observed: o }); }
      for (const [k, o] of Object.entries(res.observed ?? {})) for (const v of o.invariantViolations ?? []) violations.push({ runId: r.runId, caseKey: k, violation: v });
      for (const ae of aexp) { const o = res.observed?.[ae.caseKey]?.alert; if (!o || o.finalState !== ae.expectedFinalState || o.escalated !== ae.expectedEscalated) alertMismatch++; } }
    const separation = loaded.every(({ res }) => Object.values(res.observed ?? {}).every((o) => o.checkpoints.every((c) => c.state === 'no_data' || (c.sourceAge !== null && c.receiptAge !== null))));
    return { monitoring: { simulationOnly: true, notice: MON_NOTICE, expectationsCompared: compared, mismatches, safetyInvariantViolations: violations, alertWorkflow: { expectations: aexp.length * loaded.length, mismatches: alertMismatch, simulationOnly: true }, sourceAndReceiptFreshnessReportedSeparately: separation, scenarios: Object.keys(loaded[0]?.res.observed ?? {}).length }, criticalFindings: [...violations.map((v) => ({ runId: v.runId, caseId: v.caseKey, finding: `SAFETY INVARIANT: ${v.violation}` })), ...mismatches.map((x) => ({ runId: x.runId, caseId: x.caseKey, finding: 'observed freshness classification differs from the human-written expectation' }))] };
  }
  /** Executes the PRODUCT's monitoring code over the dataset's scenarios and returns the `results` object for captureRun (no human data; deterministic). */
  runMonitoringScenarios(a: PvActor, wsId: string, ds: string, scenarios: Record<string, MonitoringScenario>, opts: Parameters<typeof observeScenario>[1] = {}): { observed: Record<string, ReturnType<typeof observeScenario>> } {
    this.open(a, wsId, ['runner'], 'run_scenarios'); const observed: Record<string, ReturnType<typeof observeScenario>> = {}; for (const [k, s] of Object.entries(scenarios)) observed[k] = observeScenario(s, opts); return { observed };
  }
  auditEntries(a: PvActor, wsId: string) { const { dir } = this.open(a, wsId, ['owner', 'auditor'], 'audit'); const f = path.join(dir, 'audit.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
}
