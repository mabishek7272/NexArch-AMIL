/**
 * SYNTHETIC monitoring/device validation tooling. Scenarios are generated data (arbitrary smooth numbers with NO physiological meaning); the "system under test" is the product's own
 * validation and freshness code. Nothing here validates a device, a clinical alert or any patient-facing behaviour: it checks that the code classifies recorded synthetic sessions the
 * way a human-written expectation says it should, and that source-measurement freshness and receipt freshness stay separate.
 */
import { AlertMachine, AlertPolicy, AlertRecord, DEFAULT_CLOCK_RULES, DEFAULT_STATUS_RULES, evaluateStatus, Latest, METRICS, MetricKey, validateObservation, RawObservation, QualityFlag } from '../../monitoring/model';
import { DeviceLog, evaluateDevice } from '../device-eval';

export const MON_SCENARIOS = ['normal', 'impossible', 'stale', 'duplicated', 'delayed', 'out_of_order', 'missing', 'clock_skew', 'reconnect_backlog', 'backlog_old_only', 'alert_ack', 'alert_escalation'] as const;
export type MonScenario = typeof MON_SCENARIOS[number];
export interface MonObs { sourceTime: string; receivedTime: string; value: number }
export interface MonitoringScenario {
  synthetic: true; scenario: MonScenario; metric: MetricKey; windowStart: string; windowEnd: string; observations: MonObs[];
  /** Checkpoints at which the freshness model is evaluated ("now"). */
  checkpoints: string[]; alert?: { policy: AlertPolicy; events: Array<{ at: string; type: 'open' | 'ack' | 'tick' | 'close'; by?: string }> };
}
export interface MonExpectation { caseKey: string; checkpoint: string; expectedState: 'current' | 'stale' | 'untrusted_time' | 'no_data'; expectedValueExposed: boolean; expectedSourceAge?: 'fresh' | 'old' | 'future'; expectedReceiptAge?: 'recent' | 'silent' }
export interface AlertExpectation { caseKey: string; expectedFinalState: string; expectedEscalated: boolean }
const T0 = Date.parse('2026-11-18T08:00:00.000Z'); const iso = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();
const val = (i: number) => 70 + ((i * 7) % 5);                                     // arbitrary, no physiological meaning
const obs = (i: number, latencySec = 2): MonObs => ({ sourceTime: iso(i), receivedTime: iso(i, latencySec), value: val(i) });
const base = (scenario: MonScenario, observations: MonObs[], checkpoints: string[], extra: Partial<MonitoringScenario> = {}): MonitoringScenario => ({ synthetic: true, scenario, metric: 'heart_rate', windowStart: iso(0), windowEnd: iso(30), observations, checkpoints, ...extra });
const seq = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

export function monitoringScenarios(): Array<{ key: string; scenario: MonitoringScenario; expect: MonExpectation[]; alertExpect?: AlertExpectation }> {
  const E = (key: string, checkpoint: string, expectedState: MonExpectation['expectedState'], expectedValueExposed: boolean, a?: string, r?: string): MonExpectation => ({ caseKey: key, checkpoint, expectedState, expectedValueExposed, ...(a ? { expectedSourceAge: a as never } : {}), ...(r ? { expectedReceiptAge: r as never } : {}) });
  const out: ReturnType<typeof monitoringScenarios> = [];
  out.push({ key: 'normal', scenario: base('normal', seq(30).map((i) => obs(i)), [iso(29, 30)]), expect: [E('normal', iso(29, 30), 'current', true, 'fresh', 'recent')] });
  out.push({ key: 'impossible', scenario: base('impossible', [...seq(10).map((i) => obs(i)), { sourceTime: iso(10), receivedTime: iso(10, 2), value: 9999 }], [iso(10, 30), iso(13)]), expect: [E('impossible', iso(10, 30), 'current', true, 'fresh', 'recent'), E('impossible', iso(13), 'stale', false, 'old', 'silent')] });   // the impossible reading is rejected, never shown; the earlier valid one ages normally
  out.push({ key: 'stale', scenario: base('stale', seq(10).map((i) => obs(i)), [iso(9, 30), iso(29)]), expect: [E('stale', iso(9, 30), 'current', true, 'fresh', 'recent'), E('stale', iso(29), 'stale', false, 'old', 'silent')] });
  out.push({ key: 'duplicated', scenario: base('duplicated', seq(30).flatMap((i) => (i % 5 === 0 ? [obs(i), obs(i, 3)] : [obs(i)])), [iso(29, 30)]), expect: [E('duplicated', iso(29, 30), 'current', true, 'fresh', 'recent')] });
  out.push({ key: 'delayed', scenario: base('delayed', seq(30).map((i) => obs(i, i >= 20 ? 400 : 2)), [iso(26, 50), iso(27, 50)]), expect: [E('delayed', iso(26, 50), 'stale', false, 'old', 'recent'), E('delayed', iso(27, 50), 'stale', false, 'old', 'recent')] });   // receipt is recent but the measurement is old: NOT a current reading
  // out_of_order: measurement 15 arrives AFTER the measurements taken later
  { const o = seq(30).map((i) => obs(i)); const [a] = o.splice(15, 1); a.receivedTime = iso(18, 3); o.splice(18, 0, a); out.push({ key: 'out_of_order', scenario: base('out_of_order', o, [iso(29, 30)]), expect: [E('out_of_order', iso(29, 30), 'current', true, 'fresh', 'recent')] }); }
  out.push({ key: 'missing', scenario: base('missing', seq(30).filter((i) => i < 10 || i >= 18).map((i) => obs(i)), [iso(14), iso(29, 30)]), expect: [E('missing', iso(14), 'stale', false, 'old', 'silent'), E('missing', iso(29, 30), 'current', true, 'fresh', 'recent')] });
  out.push({ key: 'clock_skew', scenario: base('clock_skew', seq(30).map((i) => ({ sourceTime: iso(i + 10), receivedTime: iso(i, 2), value: val(i) })), [iso(29, 30)]), expect: [E('clock_skew', iso(29, 30), 'untrusted_time', false, 'future', 'recent')] });
  out.push({ key: 'reconnect_backlog', scenario: base('reconnect_backlog', [...seq(15).map((i) => obs(i)), ...seq(15, 15).map((i) => ({ sourceTime: iso(i), receivedTime: iso(30, 0), value: val(i) }))], [iso(20), iso(30, 5)]),
    expect: [E('reconnect_backlog', iso(20), 'stale', false, 'old', 'silent'), E('reconnect_backlog', iso(30, 5), 'current', true, 'fresh', 'recent')] });   // after the flush the NEWEST backlog measurement is 65 s old, within the window
  out.push({ key: 'backlog_old_only', scenario: base('backlog_old_only', [...seq(5).map((i) => obs(i)), ...seq(5, 5).map((i) => ({ sourceTime: iso(i), receivedTime: iso(30, 0), value: val(i) }))], [iso(30, 5)]), expect: [E('backlog_old_only', iso(30, 5), 'stale', false, 'old', 'recent')] });
  const pol: AlertPolicy = { acknowledgeWithinSec: 300, escalateTo: 'SIMULATED-ESCALATION-TARGET' };
  out.push({ key: 'alert_ack', scenario: base('alert_ack', seq(5).map((i) => obs(i)), [iso(5)], { alert: { policy: pol, events: [{ at: iso(1), type: 'open' }, { at: iso(3), type: 'ack', by: 'synthetic-acknowledger' }, { at: iso(4), type: 'tick' }, { at: iso(5), type: 'close', by: 'synthetic-acknowledger' }] } }), expect: [E('alert_ack', iso(5), 'current', true, 'fresh', 'recent')], alertExpect: { caseKey: 'alert_ack', expectedFinalState: 'closed', expectedEscalated: false } });
  out.push({ key: 'alert_escalation', scenario: base('alert_escalation', seq(5).map((i) => obs(i)), [iso(12)], { alert: { policy: pol, events: [{ at: iso(1), type: 'open' }, { at: iso(3), type: 'tick' }, { at: iso(7), type: 'tick' }] } }), expect: [E('alert_escalation', iso(12), 'stale', false, 'old', 'silent')], alertExpect: { caseKey: 'alert_escalation', expectedFinalState: 'escalated', expectedEscalated: true } });
  return out;
}

export interface CheckpointObservation { checkpoint: string; state: string; valueExposed: boolean; sourceAge: string | null; receiptAge: string | null; label: string }
export interface ScenarioObservation {
  checkpoints: CheckpointObservation[]; accepted: number; rejected: Record<string, number>; duplicatesSeen: number; flagCounts: Record<string, number>; invariantViolations: string[];
  device: unknown; alert?: { finalState: string; escalated: boolean; simulation: true; ackLatencySec: number | null; timeline: Array<{ at: string; event: string }> };
}
/** Runs the PRODUCT's validation and freshness code over one synthetic scenario. `rules` lets a test inject a defective freshness rule set to prove the harness notices. */
export function observeScenario(s: MonitoringScenario, opts: { statusRules?: typeof DEFAULT_STATUS_RULES; defectExposeStale?: boolean } = {}): ScenarioObservation {
  const arrivals = s.observations.map((o) => ({ ...o, r: Date.parse(o.receivedTime) })).sort((a, b) => a.r - b.r);
  const rejected: Record<string, number> = {}; const flagCounts: Record<string, number> = {}; const seen = new Set<string>(); let dup = 0; let accepted = 0; let lastSrc: number | undefined;
  const acceptedRows: Array<Latest & { r: number }> = [];
  for (const a of arrivals) {
    if (seen.has(a.sourceTime)) dup++; seen.add(a.sourceTime);
    const raw: RawObservation = { metric: s.metric, value: a.value, unit: METRICS[s.metric].unit, sourceTime: a.sourceTime };
    const res = validateObservation(raw, new Date(a.r), DEFAULT_CLOCK_RULES, lastSrc);
    if (res.rejected) { rejected[res.rejected.reason] = (rejected[res.rejected.reason] ?? 0) + 1; continue; }
    accepted++; const acc = res.accepted!; for (const f of acc.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1; lastSrc = Math.max(lastSrc ?? -Infinity, Date.parse(acc.sourceTime));
    acceptedRows.push({ metric: s.metric, value: acc.value, unit: acc.unit, sourceTime: acc.sourceTime, receivedTime: acc.receivedTime, flags: acc.flags as QualityFlag[], r: a.r });
  }
  const violations: string[] = []; const checkpoints: CheckpointObservation[] = [];
  for (const cp of s.checkpoints) {
    const now = new Date(cp); const delivered = acceptedRows.filter((r) => r.r <= now.getTime());
    const st = evaluateStatus(delivered, now, { simulation: true, rules: opts.statusRules ?? DEFAULT_STATUS_RULES, metrics: [s.metric] }).metrics[0];
    const exposed = opts.defectExposeStale && st.lastKnown ? true : st.value !== null;
    checkpoints.push({ checkpoint: cp, state: st.state, valueExposed: exposed, sourceAge: st.sourceAge, receiptAge: st.receiptAge, label: st.label });
    // invariants (independent of any human expectation)
    if (exposed && st.state !== 'current') violations.push(`${cp}: a value is exposed although state is ${st.state}`);
    if (st.state === 'current' && !(st.sourceAge === 'fresh' && st.receiptAge === 'recent')) violations.push(`${cp}: current requires fresh source AND recent receipt (got ${st.sourceAge}/${st.receiptAge})`);
    if (st.state !== 'no_data' && (st.sourceAge === null || st.receiptAge === null)) violations.push(`${cp}: source and receipt ages must both be reported when data exist`);
    if (st.state === 'stale' && st.sourceAge === 'old' && st.receiptAge === 'recent' && !/NOT CURRENT/.test(st.label)) violations.push(`${cp}: delayed/backlog data must be labelled NOT CURRENT`);
  }
  let device: unknown = null;
  if (s.observations.length) { const log: DeviceLog = { schema: 'anuclaw-device-log/v1', provenance: { kind: 'synthetic_fixture', device: { kind: 'simulator' } }, metric: s.metric, windowStart: s.windowStart, windowEnd: s.windowEnd, observations: s.observations.map((o) => ({ ...o })) }; device = evaluateDevice(log, { minObservations: 1 }); }
  let alert: ScenarioObservation['alert'];
  if (s.alert) {
    let rec: AlertRecord | null = null; let ack: number | null = null; const timeline: Array<{ at: string; event: string }> = [];
    for (const e of s.alert.events) { const at = Date.parse(e.at);
      try { if (e.type === 'open') rec = AlertMachine.open('sim-1', at); else if (rec && e.type === 'ack') { rec = AlertMachine.acknowledge(rec, e.by ?? '', at); ack = (at - rec.openedAt) / 1000; } else if (rec && e.type === 'tick') rec = AlertMachine.escalateIfDue(rec, s.alert.policy, at); else if (rec && e.type === 'close') rec = AlertMachine.close(rec, e.by ?? '', at); timeline.push({ at: e.at, event: `${e.type}→${rec?.state}` }); }
      catch (err) { timeline.push({ at: e.at, event: `${e.type} refused: ${(err as Error).message}` }); } }
    alert = { finalState: rec?.state ?? 'none', escalated: !!rec?.escalatedAt || (rec?.history ?? []).some((h) => h.event === 'escalated'), simulation: true, ackLatencySec: ack, timeline };
  }
  return { checkpoints, accepted, rejected, duplicatesSeen: dup, flagCounts, invariantViolations: violations, device, ...(alert ? { alert } : {}) };
}
export const MON_NOTICE = 'Synthetic monitoring validation only — simulated data and a simulation-only alert workflow. No clinical alert, device or patient-safety claim is made or implied.';
