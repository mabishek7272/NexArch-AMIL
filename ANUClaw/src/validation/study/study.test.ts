/**
 * OCR-study tooling tests. SYNTHETIC fixtures only (validation/fixtures/ocr-study). The "authorizing person" in the unlock tests is a made-up test string,
 * not a person or an approval; the tool cannot verify identity and these tests do not pretend it can.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { cohenKappa, compareAnnotators, EXACT } from './agreement';
import { canonical, computeManifestSha, loadManifest, saveManifest, sha256Hex, StudyError, UNLOCK_SCHEMA, verifyDataset } from './manifest';
import { Actor, StudyWorkspaces } from './workspace';
import { stampOf, SYNTHETIC_VIEW, withOverrides } from '../../ocr-policy/policy';

const FX = path.resolve(__dirname, '../../../validation/fixtures/ocr-study');
const rd = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const roots: string[] = []; afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const act = (userId: string, scope = 'T1'): Actor => ({ userId, scope: { kind: 'tenant', id: scope } });
const code = (p: () => unknown) => { try { p(); return 'no-error'; } catch (e) { return (e as StudyError).code ?? String(e); } };
const mapIds = (f: any, ids: string[]) => { const m = (k: string) => ids[Number(k.slice(1)) - 1]; return { ...f, completedCaseIds: f.completedCaseIds.map(m), items: f.items.map((i: any) => ({ ...i, caseId: m(i.caseId) })) }; };

interface Ctx { svc: StudyWorkspaces; root: string; ws: string; ds: string; ids: string[]; dsDir: string; owner: Actor; A: Actor; B: Actor; adj: Actor; analyst: Actor }
function setup(split: 'development' | 'locked_validation' = 'locked_validation', steps: 'register' | 'manifest' | 'annotated' | 'adjudicated' | 'truth' | 'locked' = 'manifest'): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrstudy-')); roots.push(root); const svc = new StudyWorkspaces(root);
  const owner = act('owner-1'), A = act('annotator-a'), B = act('annotator-b'), adj = act('adjudicator-1'), analyst = act('analyst-1');
  const ws = svc.createWorkspace(owner, 'Synthetic OCR study', 'tool tests (synthetic)').id;
  svc.addMember(owner, ws, 'annotator-a', ['annotator']); svc.addMember(owner, ws, 'annotator-b', ['annotator']); svc.addMember(owner, ws, 'adjudicator-1', ['adjudicator']); svc.addMember(owner, ws, 'analyst-1', ['analyst']);
  const sources = JSON.parse(fs.readFileSync(path.join(FX, 'sources.json'), 'utf8')).map((s: any) => ({ bytes: fs.readFileSync(path.join(FX, s.file)), pages: s.pages, mediaType: s.mediaType }));
  const { datasetId: ds, caseIds: ids } = svc.registerDataset(owner, ws, { name: 'synthetic', studyRef: 'SYNTHETIC-STUDY', provenanceKind: 'synthetic_fixture', split, origin: 'synthetic fixture', annotators: ['annotator-a', 'annotator-b'], sources });
  const c: Ctx = { svc, root, ws, ds, ids, dsDir: '', owner, A, B, adj, analyst };
  const find = (d: string): string => { const hit = fs.readdirSync(d, { recursive: true } as any).map(String).find((x) => x.endsWith(`${path.sep}${ds}`) || x === ds); return path.join(d, hit!); };
  c.dsDir = find(root);
  if (steps === 'register') return c;
  svc.attestDeidentification(owner, ws, ds, rd('attestation.synthetic.json')); svc.generateManifest(owner, ws, ds);
  if (steps === 'manifest') return c;
  svc.importAnnotations(A, ws, ds, mapIds(rd('annotator-a.json'), ids)); svc.importAnnotations(B, ws, ds, mapIds(rd('annotator-b.json'), ids));
  if (steps === 'annotated') return c;
  for (const d of svc.agreementReport(adj, ws, ds).queue) {
    if (d.field === 'valueRaw' || d.field === 'valueNum') svc.adjudicate(adj, ws, ds, { queueId: d.id, source: 'a', reason: 'synthetic: matches the source line' });
    else if (d.field === 'comparator') svc.adjudicate(adj, ws, ds, { queueId: d.id, source: 'a', reason: 'synthetic: "<" is printed' });
    else svc.adjudicate(adj, ws, ds, { queueId: d.id, source: 'b', reason: 'synthetic: the item is present on the page' });
  }
  if (steps === 'adjudicated') return c;
  svc.buildTruth(owner, ws, ds); if (steps === 'truth') return c;
  svc.lock(owner, ws, ds); return c;
}
const results = (ids: string[]) => ({ ...mapIds2(rd('results.json'), ids), policy: stampOf(SYNTHETIC_VIEW) });
function mapIds2(r: any, ids: string[]) { return { ...r, documents: r.documents.map((d: any) => ({ ...d, documentId: ids[Number(d.documentId.slice(1)) - 1] })) }; }
const authFor = (c: Ctx, over: Record<string, unknown> = {}) => { const m = loadManifest(c.dsDir); return { schema: UNLOCK_SCHEMA, manifestSha256: m.manifestSha256, lockDigest: m.lock.lockDigest, reason: 'TEST: synthetic unlock', protocolDeviationRef: 'TEST-DEVIATION-1', authorizedBy: { name: 'TEST-AUTHORIZER', role: 'test role', credentialRef: 'TEST-REF' }, authorizedAt: new Date().toISOString(), ...over }; };

describe('agreement statistics', () => {
  it("Cohen's kappa on a hand-computed example, and undefined when there is one category", () => {
    expect(cohenKappa(['x', 'x', 'y', 'y'], ['x', 'y', 'y', 'y']).kappa).toBeCloseTo(0.5, 10);
    expect(cohenKappa(['x', 'x'], ['x', 'x']).kappa).toBeNull();
  });
  it('numeric tolerance is configuration (default EXACT) and the disagreement queue lists value, comparator and presence differences', () => {
    const A = rd('annotator-a.json'), B = rd('annotator-b.json'); const ids = ['c1', 'c2', 'c3']; const a = mapIds(A, ids), b = mapIds(B, ids);
    const exact = compareAnnotators(a, b, EXACT); const kinds = exact.disagreements.map((d) => d.field).sort();
    expect(kinds).toEqual(['comparator', 'presence', 'valueNum', 'valueRaw']);
    const b2 = JSON.parse(JSON.stringify(b)); b2.items[1].valueNum = 4.75;
    const tol = compareAnnotators(a, b2, { numericTolerance: { default: { abs: 0, rel: 0 }, perField: { valueNum: { abs: 0.1, rel: 0 } } } });
    expect(tol.disagreements.some((d) => d.field === 'valueNum')).toBe(false);
    expect(exact.note).toMatch(/NOT clinical acceptance/); expect(JSON.stringify(exact)).not.toMatch(/"(pass|passed|accepted|adequate)"/i);
  });
});

describe('workflow: register → attest → manifest → annotate → review → truth → lock → evaluate → export', () => {
  it('runs end to end on synthetic data with provenance, silent-error detection and no acceptance decision', () => {
    const c = setup('locked_validation', 'adjudicated');
    const t = c.svc.buildTruth(c.owner, c.ws, c.ds); expect(t.items).toBe(6); expect(t.excludedAmbiguous).toBe(0);
    const lk = c.svc.lock(c.owner, c.ws, c.ds); expect(lk.lockDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.svc.verify(c.analyst, c.ws, c.ds, lk.lockDigest).ok).toBe(true);
    const r = c.svc.evaluate(c.analyst, c.ws, c.ds, { runId: 'run-1', mode: 'locked', results: results(c.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) });
    const rep: any = r.report;
    expect(rep.provenance).toMatchObject({ lockState: 'locked', lockDigest: lk.lockDigest, pristineLock: true, evaluationsOnThisLockedSet: 1, split: 'locked_validation' });
    expect(rep.provenance.manifestSha256).toMatch(/^[0-9a-f]{64}$/); expect(rep.provenance.resultsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.silentErrors).toHaveLength(1); expect(rep.silentErrors[0].wrongFields).toEqual(['unit']);        // wrong unit, unflagged
    expect(rep.errorTypes.counts.unit).toMatchObject({ all: 1, silent: 1, severity: 'unassigned' });
    expect(rep.calibration.bins.length).toBeGreaterThan(0); expect(rep.clinicalAcceptance.status).toBe('not_assessed_by_this_tool');
    const ex = c.svc.exportReport(c.owner, c.ws, c.ds, 'run-1'); expect(ex.sha256).toBe(r.reportSha256); expect(sha256Hex(ex.text)).toBe(ex.sha256);
    expect(c.svc.verifyAuditLog(c.owner, c.ws)).toMatchObject({ ok: true }); const log = JSON.stringify(c.svc.auditEntries(c.owner, c.ws));
    expect(log).not.toMatch(/Sodium|Potassium|SYNTHETIC FIXTURE/);                                           // audit holds ids and hashes, never content
    expect(c.svc.auditEntries(c.owner, c.ws).map((e: any) => e.action)).toEqual(expect.arrayContaining(['dataset_registered', 'deidentification_attested', 'manifest_generated', 'annotations_imported', 'adjudicated', 'truth_built', 'locked', 'locked_evaluation_run', 'report_exported']));
  });
  it('the manifest cannot be generated before a de-identification attestation; human_annotated needs a protocol reference; the attestation must match the provenance', () => {
    const c = setup('development', 'register');
    expect(() => c.svc.generateManifest(c.owner, c.ws, c.ds)).toThrow(/attestation/);
    const bad = { ...rd('attestation.synthetic.json'), declaration: 'deidentified' };
    expect(() => c.svc.attestDeidentification(c.owner, c.ws, c.ds, bad)).toThrow(/synthetic_fixture dataset must be attested as synthetic/);
    expect(() => c.svc.attestDeidentification(c.owner, c.ws, c.ds, { ...rd('attestation.synthetic.json'), attestorName: '' })).toThrow(/attestorName is required/);
    expect(() => c.svc.registerDataset(c.owner, c.ws, { name: 'x', studyRef: 's', provenanceKind: 'human_annotated', split: 'development', origin: 'o', annotators: ['a1', 'a2'], sources: [{ bytes: Buffer.from('x'), pages: 1, mediaType: 'text/plain' }] })).toThrow(/protocolRef/);
  });
  it('development runs work on the development split only and write ONLY under outputs/', () => {
    const dev = setup('development', 'truth'); const snap = () => ['sources', 'annotations', 'truth'].map((d) => JSON.stringify(fs.readdirSync(path.join(dev.dsDir, d), { recursive: true } as any).map(String).sort().map((f) => { const p = path.join(dev.dsDir, d, f); return fs.statSync(p).isFile() ? sha256Hex(fs.readFileSync(p)) : f; })));
    const before = snap(); const r: any = dev.svc.evaluate(dev.owner, dev.ws, dev.ds, { runId: 'dev-1', mode: 'development', results: results(dev.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) });
    expect(snap()).toEqual(before); expect(fs.existsSync(path.join(dev.dsDir, 'outputs', 'dev-1', 'report.json'))).toBe(true); expect(r.report.provenance.lockState).toBe('open'); expect(r.report.provenance.pristineLock).toBeNull();
    const locked = setup('locked_validation', 'truth');
    expect(code(() => locked.svc.evaluate(locked.owner, locked.ws, locked.ds, { runId: 'x1', mode: 'development', results: results(locked.ids) }))).toBe('split_forbidden');
    expect(code(() => locked.svc.evaluate(locked.owner, locked.ws, locked.ds, { runId: 'x2', mode: 'locked', results: results(locked.ids) }))).toBe('not_locked');
    expect(code(() => dev.svc.evaluate(dev.owner, dev.ws, dev.ds, { runId: 'dev-1', mode: 'development', results: results(dev.ids) }))).toBe('run_exists');
    expect(code(() => dev.svc.evaluate(dev.owner, dev.ws, dev.ds, { runId: '../escape', mode: 'development', results: results(dev.ids) }))).toBe('bad_run_id');
  });
  it('repeated looks at a locked set are counted and warned about', () => {
    const c = setup('locked_validation', 'locked');
    c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 'l1', mode: 'locked', results: results(c.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) });
    const r2: any = c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 'l2', mode: 'locked', results: results(c.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) });
    expect(r2.report.provenance.evaluationsOnThisLockedSet).toBe(2); expect(r2.report.provenance.repeatedLooksWarning).toMatch(/more than once/);
    expect(c.svc.verify(c.owner, c.ws, c.ds).ok).toBe(true);                                   // outputs do not disturb the lock
  });
});

describe('tampered manifests and files', () => {
  it('any edit to the manifest, a source, the truth or the adjudication log is detected', () => {
    const c = setup('locked_validation', 'locked'); const mp = path.join(c.dsDir, 'manifest.json'); const orig = fs.readFileSync(mp, 'utf8');
    expect(verifyDataset(c.dsDir).ok).toBe(true);
    fs.writeFileSync(mp, orig.replace('"SYNTHETIC-STUDY"', '"OTHER"')); expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/self-hash mismatch/);
    fs.writeFileSync(mp, orig.replace('"state": "locked"', '"state": "open"')); expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/self-hash mismatch/);
    // an attacker who ALSO recomputes the self-hash: the lock history/state check and the lock digest still catch it
    const m = JSON.parse(orig); m.lock.state = 'open'; m.manifestSha256 = computeManifestSha(m); fs.writeFileSync(mp, JSON.stringify(m));
    expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/lock state disagrees with the lock history/);
    const m2 = JSON.parse(orig); m2.cases[0].sourceSha256 = '0'.repeat(64); m2.manifestSha256 = computeManifestSha(m2); fs.writeFileSync(mp, JSON.stringify(m2));
    expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/lock digest mismatch/);
    fs.writeFileSync(mp, orig); expect(verifyDataset(c.dsDir).ok).toBe(true);
    const anchor = verifyDataset(c.dsDir).lockDigest!; expect(verifyDataset(c.dsDir, { expectLockDigest: anchor }).ok).toBe(true); expect(verifyDataset(c.dsDir, { expectLockDigest: '1'.repeat(64) }).problems.join(' ')).toMatch(/externally recorded anchor/);
    const src = path.join(c.dsDir, 'sources', c.ids[0]); fs.chmodSync(src, 0o644); fs.writeFileSync(src, 'tampered'); expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/source .* content hash mismatch/);
    expect(code(() => c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 't1', mode: 'locked', results: results(c.ids) }))).toBe('integrity');   // no evaluation on a tampered set
  });
  it('the adjudication log is hash-chained: removing or altering a record breaks verification', () => {
    const c = setup('development', 'adjudicated'); const f = path.join(c.dsDir, 'adjudication', 'records.jsonl'); const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    expect(verifyDataset(c.dsDir).ok).toBe(true);
    fs.writeFileSync(f, lines.slice(1).join('\n') + '\n'); expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/adjudication log/);
    fs.writeFileSync(f, lines.join('\n').replace('synthetic: matches the source line', 'edited') + '\n'); expect(verifyDataset(c.dsDir).problems.join(' ')).toMatch(/chain broken/);
  });
});

describe('lock bypass attempts', () => {
  it('while locked every write outside outputs/ is refused (files are read-only too)', () => {
    const c = setup('locked_validation', 'locked');
    expect(code(() => c.svc.importAnnotations(c.A, c.ws, c.ds, mapIds(rd('annotator-a.json'), c.ids)))).toBe('locked');
    expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds))).toBe('locked');
    expect(code(() => c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: 'x', source: 'a', reason: 'r' }))).toBe('locked');
    expect(code(() => c.svc.lock(c.owner, c.ws, c.ds))).toBe('already_locked');
    for (const f of [path.join(c.dsDir, 'sources', c.ids[0]), path.join(c.dsDir, 'truth', 'adjudicated.v1.json')]) expect(fs.statSync(f).mode & 0o222).toBe(0);
  });
  it('unlock needs an explicit, well-formed, bound, single-use human authorization — and there is no bypass', () => {
    const c = setup('locked_validation', 'locked'); const u = (a: unknown, who = c.owner) => c.svc.unlock(who, c.ws, c.ds, a);
    expect(code(() => u(undefined))).toBe('authorization_required');
    expect(code(() => u({}))).toBe('authorization_invalid');
    expect(() => u(authFor(c, { reason: '' }))).toThrow(/reason is required/);
    expect(() => u(authFor(c, { manifestSha256: '0'.repeat(64) }))).toThrow(/different state/);
    expect(() => u(authFor(c, { lockDigest: '0'.repeat(64) }))).toThrow(/lockDigest/);
    expect(() => u(authFor(c, { authorizedBy: { name: 'owner-1', role: 'r', credentialRef: 'c' } }))).toThrow(/must differ from the requesting user/);
    expect(() => u(authFor(c, { authorizedAt: new Date(Date.now() + 86_400_000).toISOString() }))).toThrow(/future/);
    expect(() => u(authFor(c), c.analyst)).toThrow(/roles/);                                    // only an owner may even try
    expect(loadManifest(c.dsDir).lock.state).toBe('locked');                                     // nothing above unlocked it
    process.env.ANUCLAW_FORCE_UNLOCK = '1'; process.env.ANUCLAW_STUDY_DEBUG = '1'; expect(code(() => u(undefined))).toBe('authorization_required'); delete process.env.ANUCLAW_FORCE_UNLOCK; delete process.env.ANUCLAW_STUDY_DEBUG;
    const good = authFor(c); const m = u(good); expect(m.lock).toMatchObject({ state: 'open', everUnlocked: true, epoch: 1 });
    expect(m.lock.history.map((e) => e.event)).toEqual(['create', 'lock', 'unlock']); expect(verifyDataset(c.dsDir).ok).toBe(true);
    c.svc.lock(c.owner, c.ws, c.ds);                                                              // relock, then the SAME record cannot be reused
    expect(() => u(good)).toThrow(/different state|already used/);
    const rep: any = c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 'after', mode: 'locked', results: results(c.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) }).report;
    expect(rep.provenance).toMatchObject({ pristineLock: false, lockEpoch: 1 });                 // a reopened lock is labelled as such
    expect(c.svc.auditEntries(c.owner, c.ws).map((e: any) => e.action)).toEqual(expect.arrayContaining(['UNLOCKED', 'unlock_refused']));
  });
});

describe('workspace isolation and roles', () => {
  it('another tenant, a non-member and a wrong role cannot reach workspace data; refusals are audited', () => {
    const c = setup('development', 'annotated'); const other = act('owner-1', 'T2'); const stranger = act('stranger-9');
    for (const who of [other, stranger]) {
      for (const op of [() => c.svc.getManifest(who, c.ws, c.ds), () => c.svc.agreementReport(who, c.ws, c.ds), () => c.svc.verify(who, c.ws, c.ds), () => c.svc.buildTruth(who, c.ws, c.ds), () => c.svc.addMember(who, c.ws, 'x', ['owner']),
        () => c.svc.importAnnotations(who, c.ws, c.ds, {}), () => c.svc.auditEntries(who, c.ws), () => c.svc.evaluate(who, c.ws, c.ds, { runId: 'r', mode: 'development', results: {} })]) expect(code(op)).toBe('not_found');
    }
    expect(fs.existsSync(path.join(c.root, 'tenant-T2', '_denied.jsonl'))).toBe(true); expect(fs.existsSync(path.join(c.root, 'tenant-T1', '_denied.jsonl'))).toBe(true);
    expect(code(() => c.svc.agreementReport(c.A, c.ws, c.ds))).toBe('forbidden');      // annotators are blind to the other annotator
    expect(code(() => c.svc.getManifest(c.A, c.ws, c.ds))).toBe('forbidden');
    expect(code(() => c.svc.lock(c.analyst, c.ws, c.ds))).toBe('forbidden');
    expect(code(() => c.svc.importAnnotations(c.B, c.ws, c.ds, mapIds(rd('annotator-a.json'), c.ids)))).toBe('bad_input');   // cannot import as someone else
    c.svc.addMember(c.owner, c.ws, 'annotator-z', ['annotator']);
    expect(code(() => c.svc.importAnnotations(act('annotator-z'), c.ws, c.ds, { ...mapIds(rd('annotator-a.json'), c.ids), annotatorId: 'annotator-z' }))).toBe('forbidden');   // not an assigned annotator
    c.svc.addMember(c.owner, c.ws, 'annotator-a', ['adjudicator']);
    expect(code(() => c.svc.adjudicate(c.A, c.ws, c.ds, { queueId: 'x', source: 'a', reason: 'r' }))).toBe('forbidden');    // an annotator cannot adjudicate their own dataset
    expect(c.svc.verifyAuditLog(c.owner, c.ws).ok).toBe(true);
    expect(code(() => c.svc.getManifest(c.owner, 'w-000000000000', c.ds))).toBe('not_found');
  });
});

describe('annotation revision history and disagreement preservation', () => {
  it('annotation versions are append-only; revising invalidates earlier adjudications (kept as stale) and reopens the queue', () => {
    const c = setup('development', 'adjudicated'); const m1 = loadManifest(c.dsDir);
    expect(m1.annotations.filter((a) => a.annotatorId === 'annotator-b')).toHaveLength(1); const v1 = path.join(c.dsDir, 'annotations', 'annotator-b', 'v1.json'); const v1Hash = sha256Hex(fs.readFileSync(v1));
    const revised = mapIds(rd('annotator-b.json'), c.ids); revised.items[1].valueRaw = '4.7'; revised.items[1].valueNum = 4.7;       // B corrects a value
    const r = c.svc.importAnnotations(c.B, c.ws, c.ds, revised); expect(r.version).toBe(2);
    const m2 = loadManifest(c.dsDir); expect(m2.annotations.filter((a) => a.annotatorId === 'annotator-b').map((a) => [a.version, a.supersedes])).toEqual([[1, null], [2, 1]]);
    expect(sha256Hex(fs.readFileSync(v1))).toBe(v1Hash);                                                           // v1 is preserved byte for byte
    const q = c.svc.agreementReport(c.adj, c.ws, c.ds).queue; expect(q.every((d) => d.status === 'open')).toBe(true);   // earlier decisions no longer apply …
    expect(c.svc.adjudicationRecords(c.adj, c.ws, c.ds).length).toBeGreaterThan(q.length - 1);                       // … but are still on record
    expect(q.some((d) => d.field === 'valueRaw')).toBe(false);                                                     // the corrected value no longer disagrees
    expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds))).toBe('unresolved_disagreements');
    expect(verifyDataset(c.dsDir).ok).toBe(true);
  });
  it('an adjudication record preserves BOTH original annotations whichever side wins; ambiguous and excluded items are listed, never silently dropped', () => {
    const c = setup('development', 'annotated');
    for (const d of c.svc.agreementReport(c.adj, c.ws, c.ds).queue) {
      if (d.field === 'presence') c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: d.id, source: 'other', finalValue: 'exclude', reason: 'synthetic: not on the page' });
      else if (d.field === 'comparator') c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: d.id, source: 'ambiguous', reason: 'synthetic: illegible' });
      else c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: d.id, source: 'b', reason: 'synthetic: B read it correctly' });
    }
    const recs = c.svc.adjudicationRecords(c.adj, c.ws, c.ds); const val = recs.find((r) => r.field === 'valueRaw')!;
    expect(val.original.a.value).toBe('4.7'); expect(val.original.b.value).toBe('4.1'); expect(val.decision).toMatchObject({ source: 'b', finalValue: '4.1' });
    expect(val.original.a.annotationSha256).toMatch(/^[0-9a-f]{64}$/); expect(val.original.b.annotationVersion).toBe(1);
    expect(code(() => c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: val.queueId, source: 'a', reason: 'again' }))).toBe('already_decided');
    const t = c.svc.buildTruth(c.owner, c.ws, c.ds); expect(t.excludedAmbiguous).toBe(2);                           // the ambiguous comparator item and the excluded presence item
    const truth = JSON.parse(fs.readFileSync(path.join(c.dsDir, t.file), 'utf8')); expect(truth.excludedAmbiguous.map((e: any) => e.field).sort()).toEqual(['comparator', 'presence']);
  });
  it('siding with the annotator who did NOT record an item excludes it and lists it (no crash, no silent drop)', () => {
    const c = setup('development', 'annotated');
    for (const d of c.svc.agreementReport(c.adj, c.ws, c.ds).queue) c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: d.id, source: 'a', reason: 'synthetic: choose A everywhere' });
    const t = c.svc.buildTruth(c.owner, c.ws, c.ds); const truth = JSON.parse(fs.readFileSync(path.join(c.dsDir, t.file), 'utf8'));
    expect(truth.excludedAmbiguous).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'presence' })])); expect(t.items).toBe(5);              // B's extra Urea item is not in the truth
  });
  it('an adjudicator reason is required and the queue reports missingness per annotator', () => {
    const c = setup('development', 'annotated'); const rep = c.svc.agreementReport(c.adj, c.ws, c.ds);
    expect(code(() => c.svc.adjudicate(c.adj, c.ws, c.ds, { queueId: rep.queue[0].id, source: 'a', reason: ' ' }))).toBe('bad_input');
    expect(Object.keys(rep.missingness.perAnnotator).sort()).toEqual(['annotator-a', 'annotator-b']); expect(rep.missingness.note).toMatch(/Empty does not mean wrong/);
    expect(JSON.stringify(rep)).not.toMatch(/"(pass|passed|accepted|adequate)"/i);
  });
});

describe('report provenance and integrity', () => {
  it('a stored report that no longer matches its recorded hash is refused at export', () => {
    const c = setup('development', 'truth'); c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 'p1', mode: 'development', results: results(c.ids), policy: withOverrides(SYNTHETIC_VIEW, { minTruthItems: 1, minDocuments: 1 }) });
    const f = path.join(c.dsDir, 'outputs', 'p1', 'report.json'); fs.chmodSync(f, 0o644); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"development"', '"locked"'));
    expect(code(() => c.svc.exportReport(c.owner, c.ws, c.ds, 'p1'))).toBe('integrity'); expect(code(() => c.svc.exportReport(c.owner, c.ws, c.ds, 'nope'))).toBe('not_found');
  });
  it('outputs, annotations and sources are versioned separately and all hashed in the manifest', () => {
    const c = setup('development', 'truth'); c.svc.evaluate(c.owner, c.ws, c.ds, { runId: 'v1', mode: 'development', results: results(c.ids) });
    const m = loadManifest(c.dsDir); expect(m.cases.length).toBe(3); expect(m.annotations.length).toBe(2); expect(m.truth!.version).toBe(1); expect(m.outputs.map((o) => o.runId)).toEqual(['v1']);
    expect(m.outputs[0]).toMatchObject({ mode: 'development', manifestSha256AtRun: expect.stringMatching(/^[0-9a-f]{64}$/) }); expect(canonical(m)).not.toMatch(/synthetic-1\.txt/);   // opaque ids: no original file names
    expect(m.cases.every((x) => /^c-[0-9a-f]{10}$/.test(x.caseId))).toBe(true);
  });
});

describe('CLI smoke', () => {
  it('refuses to run without an explicit --root and walks register → attest → manifest → verify', () => {
    const run = (...a: string[]) => spawnSync('npx', ['tsx', path.resolve(__dirname, '../../../scripts/ocr-study.ts'), ...a], { encoding: 'utf8', cwd: path.resolve(__dirname, '../../..') });
    expect(run('workspace', '--scope', 'tenant:T1', '--user', 'u').status).toBe(2);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrcli-')); roots.push(root); const base = ['--root', root, '--scope', 'tenant:T1', '--user', 'owner-1'];
    const w = JSON.parse(run('workspace', ...base, '--name', 'n', '--purpose', 'p').stdout).id;
    const d = JSON.parse(run('register', ...base, '--ws', w, '--sources-file', path.join(FX, 'sources.json'), '--name', 'x', '--study-ref', 'S', '--kind', 'synthetic_fixture', '--split', 'development', '--origin', 'synthetic', '--annotators', 'annotator-a,annotator-b').stdout).datasetId;
    expect(run('manifest', ...base, '--ws', w, '--dataset', d).status).toBe(2);                    // refused: no attestation
    expect(run('attest', ...base, '--ws', w, '--dataset', d, '--record', path.join(FX, 'attestation.synthetic.json')).status).toBe(0);
    expect(run('manifest', ...base, '--ws', w, '--dataset', d).status).toBe(0);
    expect(run('verify', ...base, '--ws', w, '--dataset', d).status).toBe(0);
    expect(run('verify', '--root', root, '--scope', 'tenant:T2', '--user', 'owner-1', '--ws', w, '--dataset', d).status).toBe(2);   // other tenant
  }, 120_000);
});

describe('secondReaderRule (mechanical enforcement only)', () => {
  it('all_values needs both distinct assigned annotators to complete every case; flagged_values and unknown rules are refused; none changes nothing; nothing is auto-accepted', () => {
    const c = setup('development', 'manifest'); c.svc.importAnnotations(c.A, c.ws, c.ds, mapIds(rd('annotator-a.json'), c.ids));
    const b = mapIds(rd('annotator-b.json'), c.ids); b.completedCaseIds = b.completedCaseIds.slice(0, 2); b.items = b.items.filter((i: any) => i.caseId !== c.ids[2]); c.svc.importAnnotations(c.B, c.ws, c.ds, b);
    const rule = (r: string) => withOverrides(SYNTHETIC_VIEW, { secondReaderRule: r });
    expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds, rule('all_values')))).toBe('second_reader_incomplete');
    expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds, rule('flagged_values')))).toBe('second_reader_rule_unsupported'); expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds, rule('whatever')))).toBe('second_reader_rule_unsupported');
    expect(code(() => c.svc.buildTruth(c.owner, c.ws, c.ds, rule('none')))).toBe('unresolved_disagreements');                    // no second-reader requirement: the normal checks apply
    expect(code(() => c.svc.checkSecondReader(c.owner, c.ws, c.ds, rule('all_values')))).toBe('second_reader_incomplete'); expect(code(() => c.svc.checkSecondReader(c.analyst, c.ws, c.ds, rule('none')))).toBe('forbidden');
    const full = mapIds(rd('annotator-b.json'), c.ids); c.svc.importAnnotations(c.B, c.ws, c.ds, full); expect(code(() => c.svc.checkSecondReader(c.owner, c.ws, c.ds, rule('all_values')))).toBe('no-error');   // coverage complete → mechanical rule satisfied; quality is not judged
  });
});
