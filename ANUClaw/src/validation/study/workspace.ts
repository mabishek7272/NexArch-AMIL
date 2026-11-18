/**
 * OCR-study workspaces: the workflow for authorised research users (SYNTHETIC-ONLY until a real protocol is approved).
 *   register dataset → de-identification attestation → manifest generation → annotation import → disagreement review (adjudication)
 *   → build truth → lock → evaluation → locked evaluation report export
 *
 * Isolation: every workspace lives under its scope's directory; a caller outside the scope, or a non-member, gets the same "not found" (no existence
 * oracle). Roles: owner (register/attest/manifest/lock/unlock/evaluate/export, members), annotator (imports ONLY their own annotation file, blind to
 * the other annotator), adjudicator (reviews disagreements; may not be one of the dataset's two annotators), analyst (evaluate/export).
 * Audit: a hash-chained JSON-lines log per workspace plus one per scope for refusals; entries hold ids and hashes, never document content.
 * Limitation: this is a data-layer service used by a local CLI. `userId` is ASSERTED by the caller; there is no authentication here and no HTTP route.
 * A multi-user deployment needs an authenticated layer in front (see the production-readiness plan).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { evaluateOcr, OcrEvaluation, OcrResultSet } from '../ocr-eval';
import { rate } from '../common';
import { AdjudicationRecord, AgreementConfig, AnnotatorFile, annotationMissingness, buildTruth, compareAnnotators, configOf, currentDecisions, makeRecord, validateAnnotatorFile } from './agreement';
import { assertPolicyAllows, blankRealPolicy, OcrPolicyView, PolicyError, stampOf, SYNTHETIC_VIEW } from '../../ocr-policy/policy';
import { assertWritable, canonical, CaseEntry, computeLockDigest, lockDataset, loadManifest, Manifest, newManifest, ProvenanceKind, safeRunDir, saveManifest, sha256Hex, Split, SPLITS, StudyError, unlockDataset, verifyDataset } from './manifest';

export type Role = 'owner' | 'annotator' | 'adjudicator' | 'analyst';
export interface Actor { userId: string; scope: { kind: 'tenant' | 'user'; id: string } }
interface Member { userId: string; roles: Role[] }
interface WorkspaceDoc { id: string; name: string; purpose: string; createdAt: string; members: Member[] }
export const TOOL_VERSION = 'anuclaw-ocr-study/1';
export const STUDY_NOTICE = 'Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval.';
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const safeSeg = (s: string) => (ID.test(s) ? s : `x-${sha256Hex(s).slice(0, 16)}`);

export interface SourceInput { bytes: Buffer; mediaType: string; pages: number }
export interface AttestationRecord { declaration: 'synthetic' | 'deidentified'; attestorName: string; attestorRole: string; method: string; reviewedSampleSize: number; attestedAt: string; attestationRef: string; residualRiskNote: string }

export class StudyWorkspaces {
  constructor(private readonly root: string) { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }

  // ── paths, audit ───────────────────────────────────────────────────────
  private scopeDir(s: Actor['scope']) { return path.join(this.root, `${s.kind}-${safeSeg(s.id)}`); }
  private appendAudit(file: string, actor: Actor, action: string, detail: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let prev = '0'.repeat(64), seq = 0;
    if (fs.existsSync(file)) { const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); if (lines.length) { const l = JSON.parse(lines[lines.length - 1]); prev = l.hash; seq = l.seq; } }
    const base = { seq: seq + 1, at: new Date().toISOString(), userId: actor.userId, scope: actor.scope, action, detail, prevHash: prev };
    fs.appendFileSync(file, JSON.stringify({ ...base, hash: sha256Hex(canonical(base)) }) + '\n', { mode: 0o600 });
  }
  private audit(actor: Actor, wsId: string, action: string, detail: Record<string, unknown> = {}) { this.appendAudit(path.join(this.scopeDir(actor.scope), wsId, 'audit.jsonl'), actor, action, detail); }
  private deny(actor: Actor, action: string, detail: Record<string, unknown>): never {
    this.appendAudit(path.join(this.scopeDir(actor.scope), '_denied.jsonl'), actor, `denied:${action}`, detail);
    throw new StudyError('not_found', 'Workspace or dataset not found.', 404);
  }
  verifyAuditLog(actor: Actor, wsId: string): { ok: boolean; entries: number; problem?: string } {
    this.open(actor, wsId, ['owner', 'analyst'], 'audit_verify');
    const f = path.join(this.scopeDir(actor.scope), wsId, 'audit.jsonl'); let prev = '0'.repeat(64), n = 0;
    for (const line of fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []) { const e = JSON.parse(line); const { hash, ...b } = e; if (e.prevHash !== prev || sha256Hex(canonical(b)) !== hash) return { ok: false, entries: n, problem: `chain broken at entry ${n + 1}` }; prev = hash; n++; }
    return { ok: true, entries: n };
  }
  auditEntries(actor: Actor, wsId: string) { this.open(actor, wsId, ['owner', 'analyst'], 'audit_read'); const f = path.join(this.scopeDir(actor.scope), wsId, 'audit.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

  private open(actor: Actor, wsId: string, need: Role[], action: string): { doc: WorkspaceDoc; dir: string } { return this.openFull(actor, wsId, need, action); }
  private openFull(actor: Actor, wsId: string, need: Role[], action: string): { doc: WorkspaceDoc; dir: string } {
    if (!/^w-[0-9a-f]{12}$/.test(wsId)) return this.deny(actor, action, { workspace: 'invalid-id' });
    const dir = path.join(this.scopeDir(actor.scope), wsId); const f = path.join(dir, 'workspace.json');
    if (!fs.existsSync(f)) return this.deny(actor, action, { workspace: wsId });
    const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as WorkspaceDoc; const me = doc.members.find((m) => m.userId === actor.userId);
    if (!me) return this.deny(actor, action, { workspace: wsId });
    if (!need.some((r) => me.roles.includes(r))) { this.audit(actor, wsId, `denied:${action}`, { needs: need }); throw new StudyError('forbidden', `Requires one of the roles: ${need.join(', ')}.`, 403); }
    return { doc, dir };
  }
  private dsDir(dir: string, dsId: string) { if (!/^d-[0-9a-f]{12}$/.test(dsId)) throw new StudyError('not_found', 'Dataset not found.', 404); const d = path.join(dir, 'datasets', dsId); if (!fs.existsSync(d)) throw new StudyError('not_found', 'Dataset not found.', 404); return d; }

  // ── workspaces ─────────────────────────────────────────────────────────
  createWorkspace(actor: Actor, name: string, purpose: string, roles: Role[] = ['owner', 'analyst']): WorkspaceDoc {
    if (!name?.trim() || !purpose?.trim()) throw new StudyError('bad_input', 'name and purpose are required.');
    const id = `w-${crypto.randomBytes(6).toString('hex')}`; const dir = path.join(this.scopeDir(actor.scope), id); fs.mkdirSync(path.join(dir, 'datasets'), { recursive: true, mode: 0o700 });
    const doc: WorkspaceDoc = { id, name, purpose, createdAt: new Date().toISOString(), members: [{ userId: actor.userId, roles }] };
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(doc, null, 1), { mode: 0o600 }); this.audit(actor, id, 'workspace_created', { name }); return doc;
  }
  /**
   * SERVER-SIDE ONLY. Replaces a member's internal roles without a role check. It exists so the authenticated API layer (which has already authorised the
   * caller against its own membership table) can mirror membership into the file store. It must never be reachable from request data.
   */
  trustedSetMembership(scope: Actor['scope'], wsId: string, userId: string, roles: Role[]): void {
    if (!/^w-[0-9a-f]{12}$/.test(wsId) || !ID.test(userId)) throw new StudyError('bad_input', 'invalid workspace or user id.');
    const f = path.join(this.scopeDir(scope), wsId, 'workspace.json'); if (!fs.existsSync(f)) throw new StudyError('not_found', 'Workspace not found.', 404);
    const doc = JSON.parse(fs.readFileSync(f, 'utf8')) as WorkspaceDoc; const m = doc.members.find((x) => x.userId === userId);
    if (m) m.roles = roles; else doc.members.push({ userId, roles }); fs.writeFileSync(f, JSON.stringify(doc, null, 1), { mode: 0o600 });
  }
  /** The stored manifest path of a dataset (for the API layer's tamper tests and storage checks); requires membership. */
  datasetDir(actor: Actor, wsId: string, dsId: string): string { const { dir } = this.open(actor, wsId, ['owner', 'analyst', 'adjudicator', 'annotator'], 'dataset_dir'); return this.dsDir(dir, dsId); }

  // ── case access (annotators see only what they are assigned) ──────────
  listCases(actor: Actor, wsId: string, dsId: string) {
    const { dir, doc } = this.openFull(actor, wsId, ['owner', 'analyst', 'annotator'], 'list_cases'); const m = loadManifest(this.dsDir(dir, dsId));
    const roles = doc.members.find((x) => x.userId === actor.userId)!.roles;
    if (!roles.includes('owner') && !roles.includes('analyst') && !m.annotators.includes(actor.userId)) { this.audit(actor, wsId, 'denied:list_cases', { datasetId: dsId }); throw new StudyError('forbidden', 'You are not assigned to this dataset.', 403); }
    return m.cases.map((c) => ({ caseId: c.caseId, pages: c.pages, mediaType: c.mediaType, sourceBytes: c.sourceBytes }));
  }
  readCaseSource(actor: Actor, wsId: string, dsId: string, caseId: string): { bytes: Buffer; mediaType: string; sha256: string } {
    const { dir, doc } = this.openFull(actor, wsId, ['owner', 'annotator'], 'read_source'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir);
    const roles = doc.members.find((x) => x.userId === actor.userId)!.roles;
    if (!roles.includes('owner') && !m.annotators.includes(actor.userId)) { this.audit(actor, wsId, 'denied:read_source', { datasetId: dsId }); throw new StudyError('forbidden', 'You are not assigned to this dataset.', 403); }
    const c = m.cases.find((x) => x.caseId === caseId); if (!c) throw new StudyError('not_found', 'No such case.', 404);
    const bytes = fs.readFileSync(path.join(ddir, c.file)); if (sha256Hex(bytes) !== c.sourceSha256) throw new StudyError('integrity', 'The stored source no longer matches its recorded hash.', 409);
    this.audit(actor, wsId, 'source_read', { datasetId: dsId, caseId }); return { bytes, mediaType: c.mediaType, sha256: c.sourceSha256 };
  }
  /** An annotator's OWN annotation versions only; never the other annotator's. */
  ownAnnotations(actor: Actor, wsId: string, dsId: string) {
    const { dir } = this.open(actor, wsId, ['annotator'], 'own_annotations'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir);
    if (!m.annotators.includes(actor.userId)) throw new StudyError('forbidden', 'You are not an assigned annotator of this dataset.', 403);
    const mine = m.annotations.filter((a) => a.annotatorId === actor.userId).sort((a, b) => a.version - b.version);
    return { versions: mine.map((a) => ({ version: a.version, sha256: a.sha256, importedAt: a.importedAt, caseCount: a.caseCount, supersedes: a.supersedes })), latest: mine.length ? JSON.parse(fs.readFileSync(path.join(ddir, mine[mine.length - 1].file), 'utf8')) : null };
  }
  addMember(actor: Actor, wsId: string, userId: string, roles: Role[]) {
    const { doc, dir } = this.open(actor, wsId, ['owner'], 'add_member');
    if (!ID.test(userId) || !roles.length || roles.some((r) => !['owner', 'annotator', 'adjudicator', 'analyst'].includes(r))) throw new StudyError('bad_input', 'valid userId and roles are required.');
    const m = doc.members.find((x) => x.userId === userId); if (m) m.roles = [...new Set([...m.roles, ...roles])]; else doc.members.push({ userId, roles });
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(doc, null, 1), { mode: 0o600 }); this.audit(actor, wsId, 'member_added', { userId, roles });
  }

  // ── 1. dataset registration ────────────────────────────────────────────
  registerDataset(actor: Actor, wsId: string, a: { name: string; studyRef: string; provenanceKind: ProvenanceKind; split: Split; protocolRef?: string; origin: string; annotators: [string, string]; sources: SourceInput[] }): { datasetId: string; caseIds: string[] } {
    const { dir } = this.open(actor, wsId, ['owner'], 'register_dataset');
    const problems: string[] = [];
    if (!a.name?.trim() || !a.studyRef?.trim() || !a.origin?.trim()) problems.push('name, studyRef and origin (the agreement/consent under which the data were obtained) are required');
    if (!SPLITS.includes(a.split)) problems.push(`split must be one of ${SPLITS.join(', ')}`);
    if (!['synthetic_fixture', 'human_annotated'].includes(a.provenanceKind)) problems.push('provenanceKind must be synthetic_fixture or human_annotated');
    if (a.provenanceKind === 'human_annotated' && !a.protocolRef?.trim()) problems.push('human_annotated datasets require protocolRef (a reference to an APPROVED protocol; none exists yet)');
    if (!a.annotators || a.annotators.length !== 2 || a.annotators[0] === a.annotators[1] || a.annotators.some((x) => !ID.test(x))) problems.push('exactly two distinct annotator ids are required');
    if (!a.sources?.length) problems.push('at least one source is required');
    for (const [i, s] of (a.sources ?? []).entries()) if (!Buffer.isBuffer(s.bytes) || !s.bytes.length || !Number.isInteger(s.pages) || s.pages < 1 || !s.mediaType) problems.push(`source ${i}: bytes, pages>=1 and mediaType are required`);
    if (problems.length) throw new StudyError('bad_input', problems.join('; '));
    if (a.provenanceKind === 'human_annotated') { try { assertPolicyAllows(blankRealPolicy(`${wsId}:real`, actor.userId), { purpose: 'real_registration', data: 'real' }); } catch (e) { throw new StudyError((e as PolicyError).code, (e as Error).message, 409); } }
    const datasetId = `d-${crypto.randomBytes(6).toString('hex')}`; const ddir = path.join(dir, 'datasets', datasetId); fs.mkdirSync(path.join(ddir, 'sources'), { recursive: true, mode: 0o700 });
    const cases: CaseEntry[] = a.sources.map((s) => {
      const caseId = `c-${crypto.randomBytes(5).toString('hex')}`; const file = `sources/${caseId}`;
      fs.writeFileSync(path.join(ddir, file), s.bytes, { mode: 0o444 });
      return { caseId, pages: s.pages, mediaType: s.mediaType, sourceSha256: sha256Hex(s.bytes), sourceBytes: s.bytes.length, file };
    });
    fs.writeFileSync(path.join(ddir, 'dataset.json'), JSON.stringify({ datasetId, state: 'registered', name: a.name, studyRef: a.studyRef, provenanceKind: a.provenanceKind, split: a.split, protocolRef: a.protocolRef ?? null, origin: a.origin, annotators: a.annotators, cases, registeredBy: actor.userId, registeredAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
    this.audit(actor, wsId, 'dataset_registered', { datasetId, cases: cases.length, split: a.split, provenanceKind: a.provenanceKind });
    return { datasetId, caseIds: cases.map((c) => c.caseId) };
  }

  // ── 2. de-identification attestation (human-supplied; recorded, not verified) ──
  attestDeidentification(actor: Actor, wsId: string, dsId: string, rec: AttestationRecord): { recordSha256: string } {
    const { dir } = this.open(actor, wsId, ['owner'], 'attest'); const ddir = this.dsDir(dir, dsId); const st = JSON.parse(fs.readFileSync(path.join(ddir, 'dataset.json'), 'utf8'));
    if (st.state !== 'registered') throw new StudyError('bad_state', `Attestation is recorded once, before the manifest (state: ${st.state}).`, 409);
    const p: string[] = []; const need = (k: keyof AttestationRecord) => { if (typeof rec?.[k] !== 'string' || !(rec[k] as string).trim()) p.push(`${k} is required`); };
    need('attestorName'); need('attestorRole'); need('method'); need('attestationRef'); need('residualRiskNote');
    if (!['synthetic', 'deidentified'].includes(rec?.declaration)) p.push('declaration must be synthetic or deidentified');
    if (st.provenanceKind === 'synthetic_fixture' && rec?.declaration !== 'synthetic') p.push('a synthetic_fixture dataset must be attested as synthetic');
    if (st.provenanceKind === 'human_annotated' && rec?.declaration !== 'deidentified') p.push('a human_annotated dataset must be attested as deidentified');
    if (!Number.isFinite(Date.parse(rec?.attestedAt)) || Date.parse(rec.attestedAt) > Date.now() + 60_000) p.push('attestedAt must be a valid, non-future ISO date-time');
    if (!Number.isInteger(rec?.reviewedSampleSize) || rec.reviewedSampleSize < 0) p.push('reviewedSampleSize must be a non-negative integer');
    if (p.length) throw new StudyError('attestation_invalid', p.join('; '));
    const sha = sha256Hex(canonical(rec)); fs.writeFileSync(path.join(ddir, 'attestation.json'), JSON.stringify(rec, null, 1), { mode: 0o444 });
    st.state = 'attested'; st.attestation = { recordSha256: sha, attestedAt: rec.attestedAt, synthetic: rec.declaration === 'synthetic' }; fs.writeFileSync(path.join(ddir, 'dataset.json'), JSON.stringify(st, null, 1));
    this.audit(actor, wsId, 'deidentification_attested', { datasetId: dsId, recordSha256: sha, declaration: rec.declaration }); return { recordSha256: sha };
  }

  // ── 3. manifest generation ─────────────────────────────────────────────
  generateManifest(actor: Actor, wsId: string, dsId: string): Manifest {
    const { dir } = this.open(actor, wsId, ['owner'], 'generate_manifest'); const ddir = this.dsDir(dir, dsId); const st = JSON.parse(fs.readFileSync(path.join(ddir, 'dataset.json'), 'utf8'));
    if (st.state !== 'attested') throw new StudyError('attestation_required', 'A de-identification attestation must be recorded before the manifest is generated.', 409);
    const m = newManifest({ studyRef: st.studyRef, datasetId: dsId, name: st.name, provenanceKind: st.provenanceKind, split: st.split, protocolRef: st.protocolRef, origin: st.origin, annotators: st.annotators, deidentification: st.attestation, cases: st.cases, createdBy: actor.userId });
    saveManifest(ddir, m); st.state = 'manifested'; fs.writeFileSync(path.join(ddir, 'dataset.json'), JSON.stringify(st, null, 1));
    this.audit(actor, wsId, 'manifest_generated', { datasetId: dsId, manifestSha256: m.manifestSha256 }); return m;
  }

  getManifest(actor: Actor, wsId: string, dsId: string): Manifest { const { dir } = this.open(actor, wsId, ['owner', 'analyst', 'adjudicator'], 'read_manifest'); return loadManifest(this.dsDir(dir, dsId)); }
  verify(actor: Actor, wsId: string, dsId: string, expectLockDigest?: string) { const { dir } = this.open(actor, wsId, ['owner', 'analyst', 'adjudicator'], 'verify'); const r = verifyDataset(this.dsDir(dir, dsId), { expectLockDigest }); this.audit(actor, wsId, 'verified', { datasetId: dsId, ok: r.ok }); return r; }

  // ── 4. annotation import (append-only versions; blind to the other annotator) ──
  importAnnotations(actor: Actor, wsId: string, dsId: string, file: unknown): { version: number; sha256: string } {
    const { dir } = this.open(actor, wsId, ['annotator'], 'import_annotations'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir);
    assertWritable(m, 'annotations');
    if (!m.annotators.includes(actor.userId)) { this.audit(actor, wsId, 'denied:import_annotations', { datasetId: dsId, reason: 'not an assigned annotator' }); throw new StudyError('forbidden', 'You are not an assigned annotator of this dataset.', 403); }
    const problems = validateAnnotatorFile(file, new Map(m.cases.map((c) => [c.caseId, c.pages])), actor.userId); if (problems.length) throw new StudyError('bad_input', problems.slice(0, 20).join('; '));
    const prev = m.annotations.filter((a) => a.annotatorId === actor.userId).sort((x, y) => y.version - x.version)[0];
    const version = (prev?.version ?? 0) + 1; const rel = `annotations/${actor.userId}/v${version}.json`; fs.mkdirSync(path.join(ddir, 'annotations', actor.userId), { recursive: true, mode: 0o700 });
    const text = JSON.stringify(file, null, 1) + '\n'; fs.writeFileSync(path.join(ddir, rel), text, { mode: 0o444, flag: 'wx' });          // wx: an existing version is never overwritten
    m.annotations.push({ annotatorId: actor.userId, version, sha256: sha256Hex(text), file: rel, caseCount: (file as AnnotatorFile).completedCaseIds.length, importedAt: new Date().toISOString(), importedBy: actor.userId, supersedes: prev?.version ?? null });
    saveManifest(ddir, m); this.audit(actor, wsId, 'annotations_imported', { datasetId: dsId, annotatorId: actor.userId, version, sha256: sha256Hex(text) }); return { version, sha256: sha256Hex(text) };
  }
  private latest(ddir: string, m: Manifest) {
    const pick = (id: string) => m.annotations.filter((a) => a.annotatorId === id).sort((x, y) => y.version - x.version)[0];
    const a = pick(m.annotators[0]), b = pick(m.annotators[1]);
    if (!a || !b) throw new StudyError('annotations_missing', 'Both assigned annotators must have imported an annotation file.', 409);
    const read = (e: typeof a) => JSON.parse(fs.readFileSync(path.join(ddir, e.file), 'utf8')) as AnnotatorFile;
    return { A: read(a), B: read(b), vA: { version: a.version, sha256: a.sha256 }, vB: { version: b.version, sha256: b.sha256 } };
  }
  private records(ddir: string): AdjudicationRecord[] { const f = path.join(ddir, 'adjudication', 'records.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

  // ── 5. disagreement review ─────────────────────────────────────────────
  agreementReport(actor: Actor, wsId: string, dsId: string, policy: OcrPolicyView = SYNTHETIC_VIEW) {
    const { dir } = this.open(actor, wsId, ['owner', 'analyst', 'adjudicator'], 'agreement'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir); const L = this.latest(ddir, m);
    const rep = compareAnnotators(L.A, L.B, configOf(policy)); const dec = currentDecisions(this.records(ddir), { a: L.vA, b: L.vB });
    this.audit(actor, wsId, 'agreement_viewed', { datasetId: dsId, openDisagreements: rep.disagreements.filter((d) => !dec.has(d.id)).length });
    return { agreement: rep, missingness: annotationMissingness([L.A, L.B]), queue: rep.disagreements.map((d) => ({ ...d, status: dec.has(d.id) ? 'resolved' as const : 'open' as const })), annotationVersions: { [m.annotators[0]]: L.vA, [m.annotators[1]]: L.vB } };
  }
  adjudicate(actor: Actor, wsId: string, dsId: string, a: { queueId: string; source: 'a' | 'b' | 'other' | 'ambiguous'; finalValue?: unknown; reason: string }, policy: OcrPolicyView = SYNTHETIC_VIEW): AdjudicationRecord {
    const { dir } = this.open(actor, wsId, ['adjudicator'], 'adjudicate'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir); assertWritable(m, 'adjudication');
    if (m.annotators.includes(actor.userId)) { this.audit(actor, wsId, 'denied:adjudicate', { datasetId: dsId, reason: 'adjudicator is an annotator of this dataset' }); throw new StudyError('forbidden', 'An annotator of this dataset cannot adjudicate it.', 403); }
    if (!a.reason?.trim()) throw new StudyError('bad_input', 'A reason is required.');
    const L = this.latest(ddir, m); const rep = compareAnnotators(L.A, L.B, configOf(policy)); const d = rep.disagreements.find((x) => x.id === a.queueId);
    if (!d) throw new StudyError('not_found', 'No such disagreement in the current queue (annotations may have been revised).', 404);
    if (a.source === 'other' && a.finalValue === undefined) throw new StudyError('bad_input', 'source "other" needs finalValue.');
    const recs = this.records(ddir); if (currentDecisions(recs, { a: L.vA, b: L.vB }).has(a.queueId)) throw new StudyError('already_decided', 'Already adjudicated against these annotation versions; revise by revising the annotations.', 409);
    const rec = makeRecord(recs[recs.length - 1] ?? null, { queueId: d.id, caseId: d.caseId, itemKey: d.itemKey, field: d.field,
      original: { a: { annotatorId: d.a.annotatorId, annotationVersion: L.vA.version, annotationSha256: L.vA.sha256, value: d.a.value }, b: { annotatorId: d.b.annotatorId, annotationVersion: L.vB.version, annotationSha256: L.vB.sha256, value: d.b.value } },
      decision: { source: a.source, finalValue: a.source === 'a' ? d.a.value : a.source === 'b' ? d.b.value : a.source === 'ambiguous' ? null : a.finalValue }, adjudicatorId: actor.userId, reason: a.reason });
    fs.mkdirSync(path.join(ddir, 'adjudication'), { recursive: true, mode: 0o700 }); fs.appendFileSync(path.join(ddir, 'adjudication', 'records.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
    m.adjudication = { file: 'adjudication/records.jsonl', count: rec.seq, headHash: rec.hash }; saveManifest(ddir, m);
    this.audit(actor, wsId, 'adjudicated', { datasetId: dsId, queueId: d.id, source: a.source, recordHash: rec.hash }); return rec;
  }
  adjudicationRecords(actor: Actor, wsId: string, dsId: string) { const { dir } = this.open(actor, wsId, ['owner', 'analyst', 'adjudicator'], 'read_adjudication'); return this.records(this.dsDir(dir, dsId)); }

  // ── 6. build truth, lock, unlock ───────────────────────────────────────
  buildTruth(actor: Actor, wsId: string, dsId: string, policy: OcrPolicyView = SYNTHETIC_VIEW) {
    const { dir } = this.open(actor, wsId, ['owner'], 'build_truth'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir); assertWritable(m, 'truth');
    const L = this.latest(ddir, m); this.assertSecondReader(m, L, policy); const dec = currentDecisions(this.records(ddir), { a: L.vA, b: L.vB });
    const t = buildTruth(L.A, L.B, m.cases, dec, configOf(policy));
    if (t.unresolved.length) throw new StudyError('unresolved_disagreements', `${t.unresolved.length} disagreement(s) are still unresolved; adjudicate them (or record them as ambiguous) first.`, 409);
    const version = (m.truth?.version ?? 0) + 1; const rel = `truth/adjudicated.v${version}.json`; fs.mkdirSync(path.join(ddir, 'truth'), { recursive: true, mode: 0o700 });
    const text = JSON.stringify({ schema: 'anuclaw-ocr-adjudicated-truth/v1', documents: t.documents, excludedAmbiguous: t.excludedAmbiguous }, null, 1) + '\n'; fs.writeFileSync(path.join(ddir, rel), text, { mode: 0o444, flag: 'wx' });
    m.truth = { file: rel, version, sha256: sha256Hex(text), builtAt: new Date().toISOString(), items: t.documents.reduce((s, d) => s + d.truth.length, 0), excludedAmbiguous: t.excludedAmbiguous.length,
      basedOn: { [m.annotators[0]]: L.vA, [m.annotators[1]]: L.vB }, adjudicationHeadHash: m.adjudication.headHash };
    saveManifest(ddir, m); this.audit(actor, wsId, 'truth_built', { datasetId: dsId, version, items: m.truth.items, sha256: m.truth.sha256 }); return m.truth;
  }
  /**
   * secondReaderRule, MECHANICAL part only: distinct assigned annotators and complete case coverage by both. It never judges annotation quality, sets no threshold and accepts nothing.
   * Rules that cannot be enforced yet are refused explicitly (never silently ignored).
   */
  private assertSecondReader(m: Manifest, L: { A: AnnotatorFile; B: AnnotatorFile }, policy: OcrPolicyView): void {
    const rule = policy.secondReaderRule; if (rule === 'none') return;
    if (rule !== 'all_values') throw new StudyError('second_reader_rule_unsupported', `secondReaderRule "${rule}" cannot be enforced in this build (flagged-value routing needs per-candidate flags that annotation records do not carry); the workflow is refused rather than silently ignoring it.`, 409);
    if (m.annotators[0] === m.annotators[1] || L.A.annotatorId === L.B.annotatorId) throw new StudyError('second_reader_not_distinct', 'The two assigned annotators must be different people.', 409);
    const missing = m.cases.filter((c) => !L.A.completedCaseIds.includes(c.caseId) || !L.B.completedCaseIds.includes(c.caseId)).length;
    if (missing) throw new StudyError('second_reader_incomplete', `secondReaderRule all_values: ${missing} case(s) were not completed by BOTH assigned annotators.`, 409);
  }
  checkSecondReader(actor: Actor, wsId: string, dsId: string, policy: OcrPolicyView): void { const { dir } = this.open(actor, wsId, ['owner'], 'check_second_reader'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir); this.assertSecondReader(m, this.latest(ddir, m), policy); }
  lock(actor: Actor, wsId: string, dsId: string): { lockDigest: string; manifestSha256: string; note: string } {
    const { dir } = this.open(actor, wsId, ['owner'], 'lock'); const ddir = this.dsDir(dir, dsId); const m0 = loadManifest(ddir);
    if (m0.truth) { const L = this.latest(ddir, m0); if (m0.truth.basedOn[m0.annotators[0]]?.sha256 !== L.vA.sha256 || m0.truth.basedOn[m0.annotators[1]]?.sha256 !== L.vB.sha256) throw new StudyError('truth_stale', 'Annotations changed after the truth was built; rebuild the truth first.', 409); }
    const m = lockDataset(ddir, actor.userId); this.audit(actor, wsId, 'locked', { datasetId: dsId, lockDigest: m.lock.lockDigest, epoch: m.lock.epoch });
    return { lockDigest: m.lock.lockDigest!, manifestSha256: m.manifestSha256, note: 'Record the lock digest OUTSIDE this directory (e.g. in the preregistration) and verify against it with --expect-lock-digest.' };
  }
  unlock(actor: Actor, wsId: string, dsId: string, authorization: unknown): Manifest {
    const { dir } = this.open(actor, wsId, ['owner'], 'unlock'); const ddir = this.dsDir(dir, dsId);
    try { const m = unlockDataset(ddir, actor.userId, authorization); this.audit(actor, wsId, 'UNLOCKED', { datasetId: dsId, epoch: m.lock.epoch, authorizationSha256: m.lock.history[m.lock.history.length - 1].authorizationSha256 }); return m; }
    catch (e) { this.audit(actor, wsId, 'unlock_refused', { datasetId: dsId, code: (e as StudyError).code }); throw e; }
  }

  // ── 7. evaluation + locked report export ───────────────────────────────
  evaluate(actor: Actor, wsId: string, dsId: string, a: { runId: string; mode: 'development' | 'locked'; results: unknown; expectLockDigest?: string; /** the policy version bound to this dataset (resolved by the caller from the registry); synthetic test policy when omitted */ policy?: OcrPolicyView }) {
    const policy = a.policy ?? SYNTHETIC_VIEW;
    const { dir } = this.open(actor, wsId, ['owner', 'analyst'], 'evaluate'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir);
    const v = verifyDataset(ddir, { expectLockDigest: a.expectLockDigest }); if (!v.ok) throw new StudyError('integrity', `Verification failed; no evaluation was run: ${v.problems.join('; ')}`, 409);
    if (!m.truth) throw new StudyError('no_truth', 'Build the adjudicated truth first.', 409);
    if (a.mode === 'development' && m.split !== 'development') { this.audit(actor, wsId, 'denied:evaluate', { datasetId: dsId, reason: 'development run on a non-development split' }); throw new StudyError('split_forbidden', 'Development runs are allowed only on the development split. Tuning on the locked or external sets would invalidate them.', 403); }
    if (a.mode === 'locked' && !(m.split === 'locked_validation' || m.split === 'external_validation')) throw new StudyError('split_forbidden', 'Locked evaluation applies to the locked_validation or external_validation splits.', 403);
    if (a.mode === 'locked' && m.lock.state !== 'locked') throw new StudyError('not_locked', 'A locked evaluation requires the dataset to be locked.', 409);
    assertWritable(m, 'outputs'); const runDir = safeRunDir(ddir, a.runId); if (fs.existsSync(runDir)) throw new StudyError('run_exists', 'An output with this runId already exists; outputs are never overwritten.', 409);
    const res = a.results as OcrResultSet; if (res?.schema !== 'anuclaw-ocr-extraction/v1') throw new StudyError('bad_input', 'results.schema must be anuclaw-ocr-extraction/v1 (documentId = the opaque caseId).');
    // policy version drift: the extraction results must name the SAME policy version the evaluation runs under (parser and evaluation consume one version)
    const rp = (res as unknown as { policy?: { sha256?: string; version?: number } }).policy;
    if (a.mode === 'locked' && !rp) throw new StudyError('policy_stamp_required', 'Locked evaluation requires results stamped with the policy version they were produced under (results.policy).', 400);
    if (rp && rp.sha256 !== policy.sha256) { this.audit(actor, wsId, 'denied:evaluate', { datasetId: dsId, reason: 'policy version drift' }); throw new StudyError('policy_version_drift', `The results were produced under policy version ${rp.version ?? '?'} but the evaluation runs under ${policy.id}@${policy.version}.`, 409); }
    const truthFile = JSON.parse(fs.readFileSync(path.join(ddir, m.truth.file), 'utf8'));
    const truthSet = { schema: 'anuclaw-ocr-annotation/v1' as const, provenance: { kind: m.provenanceKind, annotators: m.annotators.map((id) => ({ id, role: 'annotator' })), adjudication: 'double_annotated_adjudicated' as const, createdAt: m.truth.builtAt, protocolRef: m.protocolRef ?? undefined }, documents: truthFile.documents };
    const evaluation = evaluateOcr(truthSet, res, { policy });
    const truthById = new Map<string, any>(truthFile.documents.flatMap((d: any) => d.truth.map((t: any) => [t.id, t]))); const L = this.latest(ddir, m);
    const resultsText = JSON.stringify(res, null, 1) + '\n'; const sev = (k: string) => policy.severityMap[k] ?? 'unassigned';
    const wrong = evaluation.outcomes.filter((o) => o.status === 'matched' && !o.fields!.allCorrect); const typeCount: Record<string, { all: number; silent: number; severity: string }> = {};
    const bump = (k: string, silent: boolean) => { const e = typeCount[k] ?? (typeCount[k] = { all: 0, silent: 0, severity: sev(k) }); e.all++; if (silent) e.silent++; };
    for (const o of wrong) { const f = o.fields!; for (const [k, ok] of [['value', f.valueCorrect], ['comparator', f.comparatorCorrect], ['unit', f.unitCorrect], ['refLow', f.refLowCorrect], ['refHigh', f.refHighCorrect], ['page', f.pageCorrect]] as const) if (!ok) bump(k, !o.flagged); }
    for (const o of evaluation.outcomes) if (o.status === 'missed') bump('missed_item', false); else if (o.status === 'extraction_failure') bump('extraction_failure', false);
    for (let i = 0; i < evaluation.extraneous.length; i++) bump('extraneous_candidate', false);
    const bins = Math.max(1, Math.min(50, policy.calibrationBins)); const cal = Array.from({ length: bins }, (_, i) => ({ lower: i / bins, upper: (i + 1) / bins, n: 0, correct: 0, sumConf: 0 })); let noConf = 0;
    for (const o of evaluation.outcomes) if (o.status === 'matched') { const c = o.candidate?.ocrConfidence; if (c == null) { noConf++; continue; } const b = cal[Math.min(bins - 1, Math.floor(c * bins))]; b.n++; b.sumConf += c; if (o.fields!.allCorrect) b.correct++; }
    const totalConf = cal.reduce((s, b) => s + b.n, 0);
    const missingField: Record<string, { truthHasValueCandidateEmpty: number; truthEmptyCandidateHasValue: number; compared: number }> = {};
    for (const o of evaluation.outcomes) if (o.status === 'matched' && o.candidate) { const t = truthById.get(o.truthId); for (const f of ['unit', 'comparator', 'refLow', 'refHigh'] as const) { const e = missingField[f] ?? (missingField[f] = { truthHasValueCandidateEmpty: 0, truthEmptyCandidateHasValue: 0, compared: 0 }); const tv = t?.[f] != null && t[f] !== '', cv = o.candidate[f] != null && o.candidate[f] !== ''; e.compared++; if (tv && !cv) e.truthHasValueCandidateEmpty++; if (!tv && cv) e.truthEmptyCandidateHasValue++; } }
    const lockedRuns = m.outputs.filter((o) => o.mode === 'locked').length + (a.mode === 'locked' ? 1 : 0);
    const report = {
      schema: 'anuclaw-ocr-study-report/v1', studyToolingNotice: STUDY_NOTICE, mode: a.mode,
      provenance: { toolVersion: TOOL_VERSION, studyRef: m.studyRef, datasetId: m.datasetId, split: m.split, provenanceKind: m.provenanceKind, protocolRef: m.protocolRef, manifestSha256: m.manifestSha256, lockState: m.lock.state, lockDigest: m.lock.lockDigest, lockEpoch: m.lock.epoch,
        pristineLock: a.mode === 'locked' ? !m.lock.everUnlocked : null, evaluationsOnThisLockedSet: a.mode === 'locked' ? lockedRuns : null, repeatedLooksWarning: a.mode === 'locked' && lockedRuns > 1 ? 'This locked set has been evaluated more than once; report every look and the changes made between them.' : null,
        annotationVersions: { [m.annotators[0]]: L.vA, [m.annotators[1]]: L.vB }, truth: { version: m.truth.version, sha256: m.truth.sha256, items: m.truth.items, excludedAmbiguous: m.truth.excludedAmbiguous }, adjudicationHeadHash: m.adjudication.headHash,
        resultsSha256: sha256Hex(resultsText), system: res.system, runId: a.runId, generatedAt: new Date().toISOString(), generatedBy: actor.userId, policy: { ...stampOf(policy), statement: policy.kind === 'synthetic_test' ? 'SYNTHETIC TEST POLICY — values are test values, not a clinical or statistical choice' : 'real-study policy' }, options: { calibrationBins: bins } },
      evaluation,
      silentErrors: wrong.filter((o) => !o.flagged).map((o) => ({ caseId: o.documentId, truthId: o.truthId, analyte: o.analyte, wrongFields: Object.entries(o.fields!).filter(([k, ok]) => k !== 'allCorrect' && !ok).map(([k]) => k.replace(/Correct$/, '')) })),
      errorTypes: { note: 'Counts by error type. Severity is "unassigned" unless the clinical lead supplied a map; this tool assigns none.', counts: typeCount },
      missingFields: missingField,
      calibration: { note: 'Reliability by confidence bin (bin count is a configuration placeholder). Descriptive; no threshold is applied.', bins: cal.filter((b) => b.n > 0).map((b) => ({ lower: b.lower, upper: b.upper, n: b.n, meanConfidence: b.sumConf / b.n, observedAccuracy: rate(b.correct, b.n) })),
        expectedCalibrationError: totalConf ? cal.reduce((s, b) => s + (b.n ? (b.n / totalConf) * Math.abs(b.correct / b.n - b.sumConf / b.n) : 0), 0) : null, matchedWithoutConfidence: noConf },
      annotationQuality: { agreement: compareAnnotators(L.A, L.B, configOf(policy)).fields.map((f) => ({ field: f.field, n: f.n, percentAgreement: f.percentAgreement.rate, cohenKappa: f.cohenKappa })), note: 'Computed from the latest annotation versions with EXACT matching; see the agreement report for tolerances used during adjudication.' },
      clinicalAcceptance: { status: 'not_assessed_by_this_tool', statement: 'No acceptance decision is made or implied. Whether any measured value is acceptable is decided by the named clinical lead against criteria fixed in the approved protocol.' },
    };
    const reportText = JSON.stringify(report, null, 1) + '\n';
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(runDir, 'results.json'), resultsText, { mode: 0o444, flag: 'wx' }); fs.writeFileSync(path.join(runDir, 'report.json'), reportText, { mode: 0o444, flag: 'wx' });
    m.outputs.push({ runId: a.runId, mode: a.mode, at: report.provenance.generatedAt, by: actor.userId, resultsSha256: report.provenance.resultsSha256, reportSha256: sha256Hex(reportText), policy: stampOf(policy), manifestSha256AtRun: m.manifestSha256, lockDigestAtRun: m.lock.lockDigest, lockEpochAtRun: m.lock.epoch });
    saveManifest(ddir, m); this.audit(actor, wsId, a.mode === 'locked' ? 'locked_evaluation_run' : 'development_evaluation_run', { datasetId: dsId, runId: a.runId, reportSha256: sha256Hex(reportText) });
    return { report, reportSha256: sha256Hex(reportText), file: path.join(runDir, 'report.json') };
  }
  exportReport(actor: Actor, wsId: string, dsId: string, runId: string): { text: string; sha256: string } {
    const { dir } = this.open(actor, wsId, ['owner', 'analyst'], 'export_report'); const ddir = this.dsDir(dir, dsId); const m = loadManifest(ddir); const o = m.outputs.find((x) => x.runId === runId);
    if (!o) throw new StudyError('not_found', 'No such run.', 404);
    const text = fs.readFileSync(path.join(safeRunDir(ddir, runId), 'report.json'), 'utf8');
    if (sha256Hex(text) !== o.reportSha256) throw new StudyError('integrity', 'The stored report no longer matches its recorded hash; refusing to export.', 409);
    this.audit(actor, wsId, 'report_exported', { datasetId: dsId, runId, reportSha256: o.reportSha256 }); return { text, sha256: o.reportSha256 };
  }
}
export { computeLockDigest };
export type { OcrEvaluation };
