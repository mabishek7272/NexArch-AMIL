/**
 * Posture / monitoring validation tooling tests. SYNTHETIC fixtures only (drawn SVG, parametric stand-in, simulated observations). Passing proves the TOOLING behaves as written;
 * it says nothing about any pose model, device, human, or clinical use. "Authorizers" are made-up strings, not people or approvals.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonical, sha256Hex, StudyError, UNLOCK_SCHEMA } from '../study/manifest';
import { PvActor, PvWorkspaces, assertSyntheticMedia, PV_NOTICE } from './workspace';
import { DEFAULT_STUB, METRIC_KEYS, PostureCase, SCENARIOS, StubConfig, hashOf, postureCases, runStub } from './posture-fixtures';
import { MON_NOTICE, monitoringScenarios, observeScenario } from './monitoring';
import { MALFORMED_REPORTS, observeUpstream, upstreamCases, syntheticPosture } from './upstream-fixtures';
import { classifyReason, ERROR_CLASSES } from './taxonomy';
import { validateContract, schemasDir } from '../../integrations/posturepulse/contract';
import { DEFAULT_STATUS_RULES } from '../../monitoring/model';

const roots: string[] = []; afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const act = (userId: string, scope = 'T1'): PvActor => ({ userId, scope: { kind: 'tenant', id: scope } });
const code = (p: () => unknown) => { try { p(); return 'no-error'; } catch (e) { return (e as StudyError).code ?? String(e); } };
const MODEL = sha256Hex('synthetic-stub-model'); const ENV = { node: process.version, platform: 'test' };
const SHA = (s: string) => sha256Hex(s);

interface Ctx { svc: PvWorkspaces; root: string; ws: string; ds: string; ids: string[]; cases: PostureCase[]; dsDir: string; owner: PvActor; ann: PvActor; run: PvActor; stat: PvActor; aud: PvActor }
function setup(split: 'development' | 'locked_validation' = 'development', stage: 'registered' | 'referenced' | 'locked' = 'referenced', per = 3): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); roots.push(root); const svc = new PvWorkspaces(root); const owner = act('owner-1'), ann = act('annotator-1'), run = act('runner-1'), stat = act('stat-1'), aud = act('aud-1');
  const ws = svc.createWorkspace(owner, 'Synthetic posture validation', 'tool tests').id; svc.addMember(owner, ws, 'annotator-1', ['annotator']); svc.addMember(owner, ws, 'runner-1', ['runner']); svc.addMember(owner, ws, 'stat-1', ['statistician']); svc.addMember(owner, ws, 'aud-1', ['auditor']);
  const cases = postureCases(per); const { datasetId: ds, caseIds } = svc.registerDataset(owner, ws, { kind: 'posture', name: 'drawn fixtures', split, provenance: { kind: 'synthetic', generator: 'posture-fixtures.ts (seeded)', statement: 'drawn stick figures; no real person' }, cases: cases.map((c) => ({ bytes: Buffer.from(c.svg), mediaType: 'image/svg+xml' })) });
  const idMap = new Map(cases.map((c, i) => [c.caseId, caseIds[i]])); const mapped = cases.map((c) => ({ ...c, caseId: idMap.get(c.caseId)! }));
  const dsDir = (fs.readdirSync(root, { recursive: true } as never) as string[]).map(String).find((x) => x.endsWith(`${path.sep}datasets${path.sep}${ds}`))!; const c: Ctx = { svc, root, ws, ds, ids: caseIds, cases: mapped, dsDir: path.join(root, dsDir), owner, ann, run, stat, aud };
  if (stage === 'registered') return c;
  svc.importReference(ann, ws, ds, { schema: 'anuclaw-pv-reference/v1', method: 'parametric truth of the drawn figure (synthetic)', items: mapped.filter((x) => x.reference).flatMap((x) => [{ caseId: x.caseId, metricKey: METRIC_KEYS.tilt, unit: 'deg', referenceValue: x.reference!.tilt, referenceUncertainty: 0.1 }, { caseId: x.caseId, metricKey: METRIC_KEYS.lean, unit: 'deg', referenceValue: x.reference!.lean, referenceUncertainty: 0.1 }]), unmeasurable: mapped.filter((x) => x.unmeasurableReason).map((x) => ({ caseId: x.caseId, reason: x.unmeasurableReason! })) });
  if (stage === 'referenced') return c; c.svc.lock(owner, ws, ds); return c;
}
function runs(c: Ctx, n: number, cfg: StubConfig = DEFAULT_STUB, mode: 'development' | 'locked' = 'development', digest?: string, prefix = 'r') {
  for (let i = 1; i <= n; i++) c.svc.captureRun(c.run, c.ws, c.ds, { runId: `${prefix}${i}`, mode, expectLockDigest: digest, system: { pipeline: 'parametric-stub', modelVersion: 'stub@0', modelSha256: MODEL, config: cfg, environment: ENV }, results: { items: runStub(c.cases, i, cfg) } });
}
const authFor = (c: Ctx, over: Record<string, unknown> = {}) => { const m = c.svc.manifest(c.owner, c.ws, c.ds); return { schema: UNLOCK_SCHEMA, manifestSha256: m.manifestSha256, lockDigest: m.lock.lockDigest, reason: 'TEST: synthetic', protocolDeviationRef: 'TEST-DEV', authorizedBy: { name: 'TEST-AUTHORIZER', role: 'test', credentialRef: 'TEST' }, authorizedAt: new Date().toISOString(), ...over }; };

describe('synthetic fixtures', () => {
  it('cover every scenario, are deterministic, and are drawn figures (no real person or media)', () => {
    const a = postureCases(2), b = postureCases(2); expect(a.map((x) => x.svg)).toEqual(b.map((x) => x.svg)); expect(new Set(a.map((x) => x.scenario))).toEqual(new Set(SCENARIOS));
    for (const c of a) { expect(c.svg).toMatch(/SYNTHETIC-DRAWN-FIXTURE/); expect(c.svg).toMatch(/data-synthetic="true"/); expect(c.svg).not.toMatch(/<image|data:image/); }
    expect(a.filter((c) => c.reference).map((c) => c.scenario).sort()).toEqual(expect.arrayContaining(['neutral', 'shoulder_tilt', 'trunk_asymmetry', 'altered_posture'])); expect(a.filter((c) => c.unmeasurableReason).length).toBe(a.length - a.filter((c) => c.reference).length);
    expect(hashOf(DEFAULT_STUB)).toMatch(/^[0-9a-f]{64}$/); expect(runStub(a, 1)).toEqual(runStub(a, 1)); expect(runStub(a, 1)).not.toEqual(runStub(a, 2));
  });
  it('the stand-in never fabricates a value where the gate rejects, and reports a reason code', () => {
    const items = runStub(postureCases(2), 1); for (const c of postureCases(2).filter((x) => x.unmeasurableReason)) { const it = items.filter((i) => i.clipId === c.caseId); expect(it.every((i) => i.status === 'unsupported' && i.reason === c.unmeasurableReason)).toBe(true); }
  });
  it('the error taxonomy maps reason codes and leaves unknown codes unclassified', () => { expect(classifyReason('occluded')).toBe('occlusion'); expect(classifyReason('scale_unknown')).toBe('calibration'); expect(classifyReason('no_pose_detected')).toBe('no_pose'); expect(classifyReason('weird')).toBe('unclassified'); expect(classifyReason(undefined)).toBe('unclassified'); expect(ERROR_CLASSES).toEqual(expect.arrayContaining(['capture_failure', 'no_pose', 'low_confidence', 'occlusion', 'calibration', 'disagreement', 'unsupported_condition'])); });
});

describe('synthetic-only enforcement', () => {
  const root = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); roots.push(r); return r; };
  it('real-data declarations and anything that looks like real media are refused whatever the declared type', () => {
    const svc = new PvWorkspaces(root()); const o = act('o'); const ws = svc.createWorkspace(o, 'n', 'p').id; const reg = (provenance: any, cases: any) => () => svc.registerDataset(o, ws, { kind: 'posture', name: 'x', split: 'development', provenance, cases });
    const good = { kind: 'synthetic', generator: 'g', statement: 's' }; const svg = Buffer.from(postureCases(1)[0].svg);
    expect(code(reg({ ...good, kind: 'human_annotated' }, [{ bytes: svg, mediaType: 'image/svg+xml' }]))).toBe('real_data_refused'); expect(code(reg(good, [{ bytes: svg, mediaType: 'video/mp4' }]))).toBe('real_media_refused');
    for (const [name, bytes] of [['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])], ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])], ['mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])], ['webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1])], ['zip', Buffer.from([0x50, 0x4b, 3, 4, 0])], ['gzip', Buffer.from([0x1f, 0x8b, 8])]] as const) for (const mt of ['image/svg+xml', 'application/json']) expect([name, mt, code(reg(good, [{ bytes, mediaType: mt }]))]).toEqual([name, mt, 'real_media_refused']);
    expect(code(reg(good, [{ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), mediaType: 'image/svg+xml' }]))).toBe('not_synthetic');
    expect(code(reg(good, [{ bytes: Buffer.from(postureCases(1)[0].svg.replace('</svg>', '<image href="data:image/png;base64,AAAA"/></svg>')), mediaType: 'image/svg+xml' }]))).toBe('real_media_refused');
    expect(code(reg(good, [{ bytes: Buffer.from('{"scenario":"x"}'), mediaType: 'application/json' }]))).toBe('not_synthetic'); expect(code(reg(good, [{ bytes: Buffer.from('not json'), mediaType: 'application/json' }]))).toBe('not_synthetic');
    expect(code(reg(good, [{ bytes: Buffer.alloc(300_000, 65), mediaType: 'application/json' }]))).toBe('too_large'); expect(code(reg({ ...good, generator: '' }, [{ bytes: svg, mediaType: 'image/svg+xml' }]))).toBe('bad_input');
    expect(() => assertSyntheticMedia(svg, 'image/svg+xml')).not.toThrow(); expect(code(() => assertSyntheticMedia(Buffer.from('{"synthetic":true}'), 'text/plain'))).toBe('real_media_refused');
  });
});

describe('workspace isolation, roles and blinding', () => {
  it('other tenants and non-members get "not found"; roles are least-privilege; the reference annotator cannot run the system', () => {
    const c = setup(); const other = act('owner-1', 'T2'), stranger = act('stranger');
    for (const who of [other, stranger]) for (const op of [() => c.svc.manifest(who, c.ws, c.ds), () => c.svc.listCases(who, c.ws, c.ds), () => c.svc.verify(who, c.ws, c.ds), () => c.svc.addMember(who, c.ws, 'x', ['owner']), () => c.svc.evaluate(who, c.ws, c.ds), () => c.svc.auditEntries(who, c.ws)]) expect(code(op)).toBe('not_found');
    expect(fs.existsSync(path.join(c.root, 'tenant-T2', '_denied.jsonl'))).toBe(true);
    expect(code(() => c.svc.manifest(c.run, c.ws, c.ds))).toBe('forbidden'); expect(code(() => c.svc.evaluate(c.run, c.ws, c.ds))).toBe('forbidden'); expect(code(() => c.svc.importReference(c.run, c.ws, c.ds, {} as never))).toBe('forbidden');
    expect(code(() => c.svc.captureRun(c.ann, c.ws, c.ds, {} as never))).toBe('forbidden'); expect(code(() => c.svc.lock(c.stat, c.ws, c.ds))).toBe('forbidden'); expect(code(() => c.svc.captureRun(c.stat, c.ws, c.ds, {} as never))).toBe('forbidden');
    expect(c.svc.listCases(c.run, c.ws, c.ds).every((x) => !('reference' in x) && !JSON.stringify(x).includes('shoulder'))).toBe(true);             // the runner sees opaque ids only
    expect(code(() => c.svc.addMember(c.owner, c.ws, 'annotator-1', ['runner']))).toBe('bad_input'); expect(code(() => c.svc.addMember(c.owner, c.ws, 'x1', ['annotator', 'runner']))).toBe('bad_input');
    const log = JSON.stringify(c.svc.auditEntries(c.owner, c.ws)); expect(log).not.toMatch(/<svg|SYNTHETIC-DRAWN|shoulder/); expect(code(() => c.svc.auditEntries(c.run, c.ws))).toBe('forbidden');
  });
});

describe('manifest tampering and locked-set misuse', () => {
  it('source, reference, run results and the manifest itself cannot be changed unnoticed; a locked set needs an external digest', () => {
    const c = setup('development', 'locked'); const m0 = c.svc.manifest(c.owner, c.ws, c.ds); const digest = m0.lock.lockDigest!;
    expect(code(() => c.svc.verify(c.stat, c.ws, c.ds))).toBe('expected_lock_digest_required'); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).ok).toBe(true); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: '1'.repeat(64) }).problems.join()).toMatch(/externally recorded anchor/);
    const mp = path.join(c.dsDir, 'manifest.json'); const orig = fs.readFileSync(mp, 'utf8');
    fs.writeFileSync(mp, orig.replace('"posture"', '"monitoring"')); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).problems.join()).toMatch(/self-hash mismatch/);
    const m = JSON.parse(orig); m.lock.state = 'open'; m.manifestSha256 = sha256Hex(canonical((({ manifestSha256, ...r }) => r)(m))); fs.writeFileSync(mp, JSON.stringify(m)); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).problems.join()).toMatch(/lock state disagrees/);
    const m2 = JSON.parse(orig); m2.cases[0].sha256 = '0'.repeat(64); m2.manifestSha256 = sha256Hex(canonical((({ manifestSha256, ...r }) => r)(m2))); fs.writeFileSync(mp, JSON.stringify(m2)); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).problems.join()).toMatch(/lock digest mismatch|source hash mismatch/);
    fs.writeFileSync(mp, orig); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).ok).toBe(true);
    const src = path.join(c.dsDir, 'sources', c.ids[0]); fs.chmodSync(src, 0o644); fs.writeFileSync(src, 'tampered'); expect(c.svc.verify(c.stat, c.ws, c.ds, { expectLockDigest: digest }).problems.join()).toMatch(/source hash mismatch/);
    expect(code(() => c.svc.evaluate(c.stat, c.ws, c.ds, { expectLockDigest: digest }))).toBe('no_runs'.replace('no_runs', 'integrity'));
  });
  it('locked: no reference edits, development runs refused on the locked split, locked runs need the lock AND the digest; run results tampering is caught', () => {
    const c = setup('locked_validation', 'locked'); const digest = c.svc.manifest(c.owner, c.ws, c.ds).lock.lockDigest!;
    expect(code(() => c.svc.importReference(c.ann, c.ws, c.ds, { schema: 'anuclaw-pv-reference/v1', method: 'm', items: [{ caseId: c.ids[0], metricKey: 'k', unit: 'u', referenceValue: 1 }] }))).toBe('locked'); expect(code(() => c.svc.lock(c.owner, c.ws, c.ds))).toBe('already_locked');
    const cap = (o: Record<string, unknown>) => () => c.svc.captureRun(c.run, c.ws, c.ds, { runId: 'x', mode: 'locked', system: { pipeline: 'p', modelVersion: 'v', modelSha256: MODEL, config: {}, environment: ENV }, results: { items: [] }, ...o } as never);
    expect(code(cap({ mode: 'development' }))).toBe('split_forbidden'); expect(code(cap({}))).toBe('expected_lock_digest_required'); expect(code(cap({ expectLockDigest: '2'.repeat(64) }))).toBe('integrity');
    expect(code(cap({ expectLockDigest: digest, system: { pipeline: 'p', modelVersion: 'v', modelSha256: 'short', config: {}, environment: ENV } }))).toBe('bad_input'); expect(code(cap({ expectLockDigest: digest, results: { items: [{ clipId: 'unknown', metricKey: 'k' }] } }))).toBe('bad_input');
    runs(c, 2, DEFAULT_STUB, 'locked', digest); expect(code(() => runs(c, 1, DEFAULT_STUB, 'locked', digest))).toBe('run_exists');
    const rf = path.join(c.dsDir, 'runs', 'r1.json'); fs.chmodSync(rf, 0o644); fs.writeFileSync(rf, fs.readFileSync(rf, 'utf8').replace('estimate', 'unsupported')); expect(c.svc.verify(c.aud, c.ws, c.ds, { expectLockDigest: digest }).problems.join()).toMatch(/run r1 results hash mismatch/);
    const unlocked = setup('development', 'referenced'); expect(code(() => unlocked.svc.captureRun(unlocked.run, unlocked.ws, unlocked.ds, { runId: 'q', mode: 'locked', expectLockDigest: '3'.repeat(64), system: { pipeline: 'p', modelVersion: 'v', modelSha256: MODEL, config: {}, environment: ENV }, results: { items: [] } }))).toBe('not_locked');
  });
  it('unlock needs a bound, single-use, different-person human authorization (replay, mismatch, same person all refused); the reopened lock is labelled in reports', () => {
    const c = setup('development', 'locked'); runs(c, 3); const u = (a: unknown) => c.svc.unlock(c.owner, c.ws, c.ds, a);
    expect(code(() => u(undefined))).toBe('authorization_required'); expect(code(() => u({}))).toBe('authorization_invalid'); expect(() => u(authFor(c, { manifestSha256: '0'.repeat(64) }))).toThrow(/does not match the current manifest/); expect(() => u(authFor(c, { lockDigest: '0'.repeat(64) }))).toThrow(/lockDigest/);
    expect(() => u(authFor(c, { authorizedBy: { name: 'owner-1', role: 'r', credentialRef: 'c' } }))).toThrow(/must differ/); expect(() => u(authFor(c, { reason: '' }))).toThrow(/reason is required/); expect(() => u(authFor(c, { authorizedAt: new Date(Date.now() + 9e7).toISOString() }))).toThrow(/future/);
    expect(c.svc.manifest(c.owner, c.ws, c.ds).lock.state).toBe('locked'); const good = authFor(c); const after = u(good); expect(after.lock).toMatchObject({ state: 'open', everUnlocked: true, epoch: 1 });
    c.svc.lock(c.owner, c.ws, c.ds); expect(() => u(good)).toThrow(/does not match|already used/);
    const rep = c.svc.evaluate(c.stat, c.ws, c.ds, { expectLockDigest: c.svc.manifest(c.owner, c.ws, c.ds).lock.lockDigest! }).report; expect(rep.provenance.everUnlocked).toBe(true);
  });
});

describe('posture evaluation (synthetic stand-in; descriptive only)', () => {
  it('captures repeated runs with model/config/environment hashes and reports agreement, repeatability, quality gate, missing outputs and taxonomy — with no acceptance', () => {
    const c = setup(); runs(c, 3); const { report, reportSha256 } = c.svc.evaluate(c.stat, c.ws, c.ds) as { report: any; reportSha256: string };
    expect(reportSha256).toMatch(/^[0-9a-f]{64}$/); expect(report.notice).toBe(PV_NOTICE); expect(report.acceptance.status).toBe('not_assessed_by_this_tool'); expect(report.acceptance.statement).toMatch(/does not prove human accuracy/);
    expect(report.provenance.runs).toHaveLength(3); for (const r of report.provenance.runs) { expect(r.modelSha256).toBe(MODEL); expect(r.configSha256).toBe(hashOf(DEFAULT_STUB)); expect(r.environmentSha256).toBe(hashOf(ENV)); } expect(report.provenance.mixedSystemIdentities).toBe(false);
    expect(report.agreement).toHaveLength(3); const tilt = report.agreement[0].agreement.find((a: any) => a.metricKey === METRIC_KEYS.tilt); expect(tilt.paired).toBeGreaterThan(5); expect(Math.abs(tilt.bias)).toBeLessThan(1); expect(tilt.underpowered).toBe(true);        // underpowered flagged: tool placeholders, not a claim
    const rep = report.repeatability.find((r: any) => r.metricKey === METRIC_KEYS.tilt); expect(rep.withinSubjectSD).toBeGreaterThan(0); expect(rep.subjects).toBeGreaterThan(5);
    expect(report.qualityGate).toMatchObject({ falseRejections: 0, measurementsWhereUnmeasurable: 0, unmeasurableWithoutReasonCode: 0 }); expect(report.qualityGate.correctlyUnsupported).toBe(3 * c.cases.filter((x) => x.unmeasurableReason).length);
    expect(report.criticalFindings).toEqual([]); const t = report.errorTaxonomy; expect(t.occlusion).toBeGreaterThan(0); expect(t.calibration).toBeGreaterThan(0); expect(t.no_pose).toBeGreaterThan(0); expect(t.low_confidence).toBeGreaterThan(0); expect(t.unsupported_condition).toBeGreaterThan(0); expect(t.capture_failure).toBeGreaterThan(0); expect(t.disagreement).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/"(pass|passed|accepted|validated|clinically)"/i); expect(report.reference.note).toMatch(/no tolerance or sample size is chosen/);
  });
  it('disagreement is classified only when the caller supplies a tolerance; mixed system identities are flagged', () => {
    const c = setup(); runs(c, 2, DEFAULT_STUB); runs(c, 1, { ...DEFAULT_STUB, noiseSd: 3 }, 'development', undefined, 'z');
    const rep: any = c.svc.evaluate(c.stat, c.ws, c.ds, { disagreementTolerance: { [METRIC_KEYS.tilt]: 0.5 } }).report; expect(rep.errorTaxonomy.disagreement).toBeGreaterThan(0); expect(rep.provenance.mixedSystemIdentities).toBe(true); expect(rep.provenance.mixedWarning).toMatch(/DIFFERENT model/);
    expect(new Set(rep.provenance.runs.map((r: any) => r.configSha256)).size).toBe(2);
  });
  it('a stand-in that emits a value for an unmeasurable recording, drops outputs, omits reason codes or is biased is CAUGHT by the report', () => {
    const emit = setup(); runs(emit, 1, { ...DEFAULT_STUB, defect: 'emit_value_when_unmeasurable' }); const r1: any = emit.svc.evaluate(emit.stat, emit.ws, emit.ds).report; expect(r1.qualityGate.measurementsWhereUnmeasurable).toBeGreaterThan(0); expect(r1.criticalFindings.some((f: any) => /CRITICAL: a measurement was emitted/.test(f.finding))).toBe(true); expect(r1.errorTaxonomy.gate_violation_measurement_where_unmeasurable).toBeGreaterThan(0);
    const drop = setup(); runs(drop, 1, { ...DEFAULT_STUB, defect: 'drop_outputs' }); const r2: any = drop.svc.evaluate(drop.stat, drop.ws, drop.ds).report; expect(r2.errorTaxonomy.missing_output).toBeGreaterThan(0); expect(r2.missingOutputs.perRun[0].absent).toBeGreaterThan(0);
    const nor = setup(); runs(nor, 1, { ...DEFAULT_STUB, defect: 'no_reason_code' }); const r3: any = nor.svc.evaluate(nor.stat, nor.ws, nor.ds).report; expect(r3.qualityGate.unmeasurableWithoutReasonCode).toBeGreaterThan(0); expect(r3.errorTaxonomy.unclassified).toBeGreaterThan(0);
    const bias = setup(); runs(bias, 1, { ...DEFAULT_STUB, defect: 'bias', biasDeg: 2 }); const r4: any = bias.svc.evaluate(bias.stat, bias.ws, bias.ds).report; expect(r4.agreement[0].agreement.find((a: any) => a.metricKey === METRIC_KEYS.tilt).bias).toBeGreaterThan(1.5);
    const strict = setup(); runs(strict, 1, { ...DEFAULT_STUB, gate: { ...DEFAULT_STUB.gate, maxBlur: -1 } }); const r5: any = strict.svc.evaluate(strict.stat, strict.ws, strict.ds).report; expect(r5.qualityGate.falseRejections).toBeGreaterThan(0); expect(r5.errorTaxonomy.false_rejection).toBeGreaterThan(0);
  });
  it('capture failures are recorded in the taxonomy', () => {
    const c = setup(); c.svc.captureRun(c.run, c.ws, c.ds, { runId: 'cf', mode: 'development', system: { pipeline: 'p', modelVersion: 'v', modelSha256: MODEL, config: {}, environment: ENV }, results: { items: runStub(c.cases, 1), captureFailures: [{ caseId: c.ids[0], reason: 'capture_failed' }] } });
    const r: any = c.svc.evaluate(c.stat, c.ws, c.ds).report; expect(r.errorTaxonomy.capture_failure).toBeGreaterThanOrEqual(1); expect(r.missingOutputs.perRun[0].captureFailures).toBe(1);
  });
});

describe('monitoring / device validation (synthetic; simulation-only)', () => {
  it('every synthetic scenario is classified as the human-written expectation says, with no safety-invariant violation', () => {
    for (const s of monitoringScenarios()) { const o = observeScenario(s.scenario); expect(o.invariantViolations, s.key).toEqual([]);
      for (const e of s.expect) { const c = o.checkpoints.find((x) => x.checkpoint === e.checkpoint)!; expect([s.key, c.state, c.valueExposed, c.sourceAge, c.receiptAge]).toEqual([s.key, e.expectedState, e.expectedValueExposed, e.expectedSourceAge ?? c.sourceAge, e.expectedReceiptAge ?? c.receiptAge]); } }
  });
  it('source measurement freshness and receipt freshness stay separate: delayed/backlog data has a recent receipt but an old measurement and is NOT current; a future source clock is untrusted', () => {
    const by = Object.fromEntries(monitoringScenarios().map((s) => [s.key, s])); const d = observeScenario(by.delayed.scenario).checkpoints[0]; expect([d.state, d.sourceAge, d.receiptAge, d.valueExposed]).toEqual(['stale', 'old', 'recent', false]); expect(d.label).toMatch(/NOT CURRENT/);
    const b = observeScenario(by.backlog_old_only.scenario).checkpoints[0]; expect([b.state, b.sourceAge, b.receiptAge]).toEqual(['stale', 'old', 'recent']); const k = observeScenario(by.clock_skew.scenario).checkpoints[0]; expect([k.state, k.sourceAge, k.valueExposed]).toEqual(['untrusted_time', 'future', false]);
    const st = observeScenario(by.stale.scenario).checkpoints[1]; expect([st.state, st.sourceAge, st.receiptAge]).toEqual(['stale', 'old', 'silent']);
  });
  it('rejection, duplication, ordering and device-reliability reports reflect the scenarios; the alert workflow is simulation-only', () => {
    const by = Object.fromEntries(monitoringScenarios().map((s) => [s.key, s])); expect(observeScenario(by.impossible.scenario).rejected).toEqual({ value_physically_impossible: 1 }); expect(observeScenario(by.duplicated.scenario).duplicatesSeen).toBe(6);
    expect(observeScenario(by.out_of_order.scenario).flagCounts.out_of_order).toBeGreaterThan(0); expect((observeScenario(by.missing.scenario).device as any).gaps.count).toBeGreaterThan(0); expect((observeScenario(by.clock_skew.scenario).device as any).clock.untrustedClockSuspected).toBe(true);
    const a = observeScenario(by.alert_ack.scenario).alert!; expect(a).toMatchObject({ finalState: 'closed', escalated: false, simulation: true, ackLatencySec: 120 }); const e = observeScenario(by.alert_escalation.scenario).alert!; expect(e).toMatchObject({ finalState: 'escalated', escalated: true, simulation: true }); expect(MON_NOTICE).toMatch(/No clinical alert/);
  });
  it('a defective freshness rule or a defect that exposes stale values is detected as a safety finding in the evaluation report (full workspace flow)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-')); roots.push(root); const svc = new PvWorkspaces(root); const o = act('o'), an = act('an'), ru = act('ru'), st = act('st'); const ws = svc.createWorkspace(o, 'mon', 'p').id; svc.addMember(o, ws, 'an', ['annotator']); svc.addMember(o, ws, 'ru', ['runner']); svc.addMember(o, ws, 'st', ['statistician']);
    const scen = monitoringScenarios(); const { datasetId: ds, caseIds } = svc.registerDataset(o, ws, { kind: 'monitoring', name: 'sim', split: 'development', provenance: { kind: 'synthetic', generator: 'monitoring.ts', statement: 'simulated observations' }, cases: scen.map((s) => ({ bytes: Buffer.from(JSON.stringify(s.scenario)), mediaType: 'application/json' })) });
    const idOf = new Map(scen.map((s, i) => [s.key, caseIds[i]])); const byId: Record<string, any> = Object.fromEntries(scen.map((s) => [idOf.get(s.key)!, s.scenario]));
    svc.importReference(an, ws, ds, { schema: 'anuclaw-pv-reference/v1', method: 'human-written expectations (synthetic)', monitoring: { expectations: scen.flatMap((s) => s.expect.map((e) => ({ ...e, caseKey: idOf.get(s.key)! }))), alertExpectations: scen.filter((s) => s.alertExpect).map((s) => ({ ...s.alertExpect!, caseKey: idOf.get(s.key)! })) } });
    const cap = (id: string, observed: any) => svc.captureRun(ru, ws, ds, { runId: id, mode: 'development', system: { pipeline: 'monitoring-model', modelVersion: 'product', modelSha256: MODEL, config: { rules: DEFAULT_STATUS_RULES }, environment: ENV }, results: { observed } });
    cap('good', svc.runMonitoringScenarios(ru, ws, ds, byId).observed); const good: any = svc.evaluate(st, ws, ds, { runIds: ['good'] }).report; expect(good.monitoring).toMatchObject({ mismatches: [], safetyInvariantViolations: [], sourceAndReceiptFreshnessReportedSeparately: true, simulationOnly: true }); expect(good.monitoring.alertWorkflow.mismatches).toBe(0); expect(good.monitoring.expectationsCompared).toBeGreaterThan(10);
    cap('exposes_stale', svc.runMonitoringScenarios(ru, ws, ds, byId, { defectExposeStale: true }).observed); const bad: any = svc.evaluate(st, ws, ds, { runIds: ['exposes_stale'] }).report; expect(bad.monitoring.safetyInvariantViolations.length).toBeGreaterThan(0); expect(bad.criticalFindings.some((f: any) => /SAFETY INVARIANT/.test(f.finding))).toBe(true);
    cap('lax_rules', svc.runMonitoringScenarios(ru, ws, ds, byId, { statusRules: { staleFactor: 1000, disconnectFactor: 10_000 } }).observed); const lax: any = svc.evaluate(st, ws, ds, { runIds: ['lax_rules'] }).report; expect(lax.monitoring.mismatches.length).toBeGreaterThan(0); expect(lax.acceptance.status).toBe('not_assessed_by_this_tool'); expect(lax.notice).toMatch(/No clinical alert/);
    expect(code(() => svc.runMonitoringScenarios(an, ws, ds, byId))).toBe('forbidden');
  });
});

describe('PosturePulse upstream-report protections (existing import checks exercised with synthetic cases)', () => {
  const now = new Date();
  it('malformed, unsigned, withdrawn, revoked, unreleased, tampered and out-of-order cases are refused with the expected violation codes; the well-formed case passes', () => {
    for (const c of upstreamCases(now)) { const o = observeUpstream(c, now); expect([c.id, o.timestamp, o.binding, o.bundle]).toEqual([c.id, c.expectedTimestamp, c.expectedBinding, c.expectedBundle]); }
    expect(upstreamCases(now).map((c) => c.id)).toEqual(expect.arrayContaining(['consent_withdrawal_requested', 'consent_revoked', 'unreleased_draft', 'unsigned_bundle', 'signoff_before_session_start', 'tampered_after_signoff']));
  });
  it.skipIf(!(() => { try { return fs.existsSync(schemasDir()); } catch { return false; } })())('malformed reports fail the upstream JSON-schema contract; the well-formed synthetic report passes', () => {
    expect(validateContract('assessment-report', syntheticPosture({ now }).report)).toEqual([]);
    for (const m of MALFORMED_REPORTS) { const r = JSON.parse(JSON.stringify(syntheticPosture({ now }).report)); m.mutate(r); expect([m.id, validateContract('assessment-report', r).length > 0]).toEqual([m.id, true]); }
  });
  it('withdrawal and revocation are refused whichever other fields are valid (no combination of valid fields overrides them)', () => {
    const c = upstreamCases(now).find((x) => x.id === 'consent_withdrawal_requested')!; const b = c.build(); b.consentRecord.scopes = ['derived_events', 'research']; b.consentRecord.grantedAt = new Date(now.getTime() - 100_000).toISOString();
    const o = observeUpstream({ ...c, build: () => b }, now); expect(o.timestamp).toContain('consent_withdrawal_requested');
  });
});
void SHA;
