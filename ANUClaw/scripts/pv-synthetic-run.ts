/**
 * End-to-end SYNTHETIC rehearsal of the posture and monitoring validation tooling (temp directory; drawn fixtures and simulated data only). Writes
 * docs/evidence/pv-synthetic-run-latest.json (hashes, counts and descriptive findings; no fixture content). It demonstrates that the tooling runs — it validates nothing:
 * drawn-figure and simulated-data response does not prove accuracy on humans or devices.
 *   npx tsx scripts/pv-synthetic-run.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PvWorkspaces, PV_NOTICE, PvActor } from '../src/validation/pv/workspace';
import { DEFAULT_STUB, METRIC_KEYS, postureCases, runStub, hashOf } from '../src/validation/pv/posture-fixtures';
import { monitoringScenarios, MON_NOTICE } from '../src/validation/pv/monitoring';
import { sha256Hex } from '../src/validation/study/manifest';

const act = (u: string): PvActor => ({ userId: u, scope: { kind: 'tenant', id: 'rehearsal' } });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-rehearsal-')); const svc = new PvWorkspaces(root); const o = act('owner'), an = act('annotator'), ru = act('runner'), st = act('statistician');
const MODEL = sha256Hex('synthetic-parametric-stub'); const ENV = { node: process.version, platform: process.platform };
const ws = svc.createWorkspace(o, 'Synthetic rehearsal', 'tool rehearsal').id; svc.addMember(o, ws, 'annotator', ['annotator']); svc.addMember(o, ws, 'runner', ['runner']); svc.addMember(o, ws, 'statistician', ['statistician']);
// posture
const cases = postureCases(4); const reg = svc.registerDataset(o, ws, { kind: 'posture', name: 'drawn fixtures', split: 'locked_validation', provenance: { kind: 'synthetic', generator: 'posture-fixtures.ts', statement: 'drawn stick figures' }, cases: cases.map((c) => ({ bytes: Buffer.from(c.svg), mediaType: 'image/svg+xml' })) });
const mapped = cases.map((c, i) => ({ ...c, caseId: reg.caseIds[i] }));
svc.importReference(an, ws, reg.datasetId, { schema: 'anuclaw-pv-reference/v1', method: 'parametric truth of the drawn figure', items: mapped.filter((c) => c.reference).flatMap((c) => [{ caseId: c.caseId, metricKey: METRIC_KEYS.tilt, unit: 'deg', referenceValue: c.reference!.tilt }, { caseId: c.caseId, metricKey: METRIC_KEYS.lean, unit: 'deg', referenceValue: c.reference!.lean }]), unmeasurable: mapped.filter((c) => c.unmeasurableReason).map((c) => ({ caseId: c.caseId, reason: c.unmeasurableReason! })) });
const lock = svc.lock(o, ws, reg.datasetId);
for (let i = 1; i <= 3; i++) svc.captureRun(ru, ws, reg.datasetId, { runId: `locked-${i}`, mode: 'locked', expectLockDigest: lock.lockDigest, system: { pipeline: 'parametric-stub', modelVersion: 'stub@0', modelSha256: MODEL, config: DEFAULT_STUB, environment: ENV }, results: { items: runStub(mapped, i) } });
const posture = svc.evaluate(st, ws, reg.datasetId, { expectLockDigest: lock.lockDigest }); const pr = posture.report as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// monitoring
const scen = monitoringScenarios(); const mreg = svc.registerDataset(o, ws, { kind: 'monitoring', name: 'simulated', split: 'development', provenance: { kind: 'synthetic', generator: 'monitoring.ts', statement: 'simulated observations' }, cases: scen.map((s) => ({ bytes: Buffer.from(JSON.stringify(s.scenario)), mediaType: 'application/json' })) });
const idOf = new Map(scen.map((s, i) => [s.key, mreg.caseIds[i]])); const byId = Object.fromEntries(scen.map((s) => [idOf.get(s.key)!, s.scenario]));
svc.importReference(an, ws, mreg.datasetId, { schema: 'anuclaw-pv-reference/v1', method: 'human-written expectations', monitoring: { expectations: scen.flatMap((s) => s.expect.map((e) => ({ ...e, caseKey: idOf.get(s.key)! }))), alertExpectations: scen.filter((s) => s.alertExpect).map((s) => ({ ...s.alertExpect!, caseKey: idOf.get(s.key)! })) } });
svc.captureRun(ru, ws, mreg.datasetId, { runId: 'mon-1', mode: 'development', system: { pipeline: 'monitoring-model', modelVersion: 'product', modelSha256: MODEL, config: {}, environment: ENV }, results: svc.runMonitoringScenarios(ru, ws, mreg.datasetId, byId) });
const mon = svc.evaluate(st, ws, mreg.datasetId).report as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const out = { ranAt: new Date().toISOString(), notice: `${PV_NOTICE} ${MON_NOTICE}`, syntheticOnly: true, posture: { cases: cases.length, lockDigest: lock.lockDigest, reportSha256: posture.reportSha256, configSha256: hashOf(DEFAULT_STUB), runs: pr.provenance.runs.length, qualityGate: pr.qualityGate, errorTaxonomy: pr.errorTaxonomy, criticalFindings: pr.criticalFindings.length, acceptance: pr.acceptance.status },
  monitoring: { scenarios: scen.length, expectationsCompared: mon.monitoring.expectationsCompared, mismatches: mon.monitoring.mismatches.length, safetyInvariantViolations: mon.monitoring.safetyInvariantViolations.length, sourceAndReceiptFreshnessReportedSeparately: mon.monitoring.sourceAndReceiptFreshnessReportedSeparately, alertWorkflowMismatches: mon.monitoring.alertWorkflow.mismatches, acceptance: mon.acceptance.status } };
fs.writeFileSync(path.resolve(__dirname, '../docs/evidence/pv-synthetic-run-latest.json'), JSON.stringify(out, null, 1) + '\n'); fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1).slice(0, 900));
