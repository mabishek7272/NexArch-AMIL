import { describe, expect, it } from 'vitest';
import {
  AlertMachine, convertUnit, evaluateStatus, findGaps, fromFhirObservation, simulate, validateObservation, METRICS, Latest, RawObservation,
} from './model';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const iso = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString();
const obs = (over: Partial<RawObservation> = {}): RawObservation => ({ metric: 'heart_rate', value: 72, unit: '/min', sourceTime: iso(-10), ...over });

describe('observation validation', () => {
  it('stores a plausible reading exactly as received, with both clocks', () => {
    const r = validateObservation(obs({ sequence: 5 }), NOW);
    expect(r.accepted).toMatchObject({ metric: 'heart_rate', value: 72, unit: '/min', sequence: 5, flags: [] });
    expect(r.accepted!.sourceTime).toBe(iso(-10)); expect(r.accepted!.receivedTime).toBe(NOW.toISOString());
  });

  it.each([
    ['unknown metric', obs({ metric: 'glucose' }), 'unknown_metric'],
    ['unit mismatch (no silent conversion)', obs({ unit: 'bpm' }), 'unit_mismatch'],
    ['NaN', obs({ value: NaN }), 'value_not_finite'],
    ['string value', obs({ value: '72' }), 'value_not_finite'],
    ['negative heart rate', obs({ value: -5 }), 'value_physically_impossible'],
    ['SpO2 above 100', obs({ metric: 'spo2', unit: '%', value: 101 }), 'value_physically_impossible'],
    ['unparseable time', obs({ sourceTime: 'yesterday' }), 'bad_source_time'],
    ['date-only time', obs({ sourceTime: '2026-11-17' }), 'bad_source_time'],
  ])('rejects %s', (_l, o, reason) => { expect(validateObservation(o, NOW).rejected?.reason).toBe(reason); });

  it('an UNUSUAL value is not an error: extreme-but-possible readings are stored unmodified', () => {
    for (const [m, v] of [['heart_rate', 190], ['heart_rate', 25], ['spo2', 70], ['temperature', 41.5]] as const) {
      const r = validateObservation(obs({ metric: m, unit: METRICS[m].unit, value: v }), NOW);
      expect(r.accepted?.value).toBe(v); expect(r.accepted?.flags).toEqual([]);
    }
  });

  it('clock rules: future source time, high latency and out-of-order are FLAGGED, not corrected', () => {
    expect(validateObservation(obs({ sourceTime: iso(600) }), NOW).accepted!.flags).toContain('clock_ahead_of_receipt');
    expect(validateObservation(obs({ sourceTime: iso(60) }), NOW).accepted!.flags).not.toContain('clock_ahead_of_receipt'); // within skew
    expect(validateObservation(obs({ sourceTime: iso(-3600) }), NOW).accepted!.flags).toContain('high_latency');
    const last = Date.parse(iso(-5));
    const late = validateObservation(obs({ sourceTime: iso(-30) }), NOW, undefined, last);
    expect(late.accepted!.flags).toContain('out_of_order');
    expect(late.accepted!.sourceTime).toBe(iso(-30));        // original time preserved
  });

  it('device-reported poor quality is carried; SpO2 carries its documented limitation', () => {
    expect(validateObservation(obs({ deviceQuality: 'poor' }), NOW).accepted!.flags).toContain('device_reported_poor_quality');
    expect(validateObservation(obs({ metric: 'spo2', unit: '%', value: 96 }), NOW).accepted!.limitation).toMatch(/accuracy limitations/);
    expect(validateObservation(obs(), NOW).accepted!.limitation).toBeNull();
  });
});

describe('status: silence is never a normal reading', () => {
  const latest = (metric: Latest['metric'], recvOffsetSec: number, value = 72): Latest => ({ metric, value, unit: METRICS[metric].unit, sourceTime: iso(recvOffsetSec), receivedTime: iso(recvOffsetSec), flags: [] });

  it('current data shows its value', () => {
    const s = evaluateStatus([latest('heart_rate', -20)], NOW, { simulation: false, metrics: ['heart_rate'] });
    expect(s.state).toBe('receiving'); expect(s.metrics[0]).toMatchObject({ state: 'current', value: 72 });
  });

  it('stale data hides the value (null) and labels the last known reading with its age', () => {
    const s = evaluateStatus([latest('heart_rate', -400)], NOW, { simulation: false, metrics: ['heart_rate'] });   // 400 s > 3×60 s
    const m = s.metrics[0];
    expect(m.state).toBe('stale'); expect(m.value).toBeNull();
    expect(m.lastKnown).toMatchObject({ value: 72, ageSec: 400 }); expect(m.label).toMatch(/STALE.*not a current reading/);
    expect(s.state).toBe('stale');
  });

  it('long silence → device disconnected; no data → no_data; neither shows a value', () => {
    const d = evaluateStatus([latest('heart_rate', -3600)], NOW, { simulation: false, metrics: ['heart_rate'] });
    expect(d.state).toBe('disconnected'); expect(d.metrics[0].value).toBeNull();
    const n = evaluateStatus([], NOW, { simulation: false, metrics: ['heart_rate', 'spo2'] });
    expect(n.state).toBe('no_data'); expect(n.metrics.every((m) => m.value === null && m.state === 'no_data')).toBe(true);
  });

  it('an untrusted (future) device clock is never current, even when receipt is recent', () => {
    const l: Latest = { ...latest('heart_rate', -3600), sourceTime: iso(0) };      // source "now", but last heard an hour ago → source is 1 h ahead of receipt
    const m = evaluateStatus([l], NOW, { simulation: false, metrics: ['heart_rate'] }).metrics[0];
    expect(m.state).toBe('untrusted_time'); expect(m.value).toBeNull(); expect(m.lastKnown).toMatchObject({ value: 72, sourceAgeSec: null, sourceAge: 'future' });
  });

  it('mixed freshness: one current metric keeps the device "receiving" but the stale metric stays hidden', () => {
    const s = evaluateStatus([latest('heart_rate', -20), latest('spo2', -900, 97)], NOW, { simulation: false, metrics: ['heart_rate', 'spo2'] });
    expect(s.state).toBe('receiving'); expect(s.metrics.find((m) => m.metric === 'spo2')!.value).toBeNull();
  });

  it('never interprets values; simulated devices carry a banner', () => {
    const s = evaluateStatus([latest('heart_rate', -20, 190)], NOW, { simulation: true, metrics: ['heart_rate'] });
    const { note: _n, ...withoutNote } = s;   // the note legitimately says "not a normal reading"
    expect(JSON.stringify(withoutNote)).not.toMatch(/normal|abnormal|alarm|critical|alert|danger/i);   // no interpretation of values
    expect(s.banner).toMatch(/SIMULATION/); expect(s.note).toMatch(/not a normal reading/);
    expect(evaluateStatus([], NOW, { simulation: false }).banner).toBeNull();
  });
});

describe('gap detection', () => {
  it('finds gaps larger than the limit regardless of order', () => {
    const t = [iso(0), iso(60), iso(600), iso(660)].reverse();
    expect(findGaps(t, 120)).toEqual([{ from: iso(60), to: iso(600), seconds: 540 }]);
    expect(findGaps([iso(0), iso(60)], 120)).toEqual([]); expect(findGaps([], 60)).toEqual([]);
  });
});

describe('FHIR Observation adapter', () => {
  const hr = (over: any = {}) => ({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
    effectiveDateTime: iso(-5), device: { reference: 'Device/synthetic-1' }, valueQuantity: { value: 80, unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' }, ...over });

  it('maps LOINC heart rate with UCUM unit and device reference', () => {
    const r = fromFhirObservation(hr());
    expect(r.problems).toEqual([]); expect(r.deviceRef).toBe('Device/synthetic-1');
    expect(r.observations).toEqual([{ metric: 'heart_rate', value: 80, unit: '/min', sourceTime: iso(-5), deviceQuality: 'good' }]);
  });
  it('blood-pressure panel yields systolic and diastolic from components', () => {
    const bp = { resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] }, effectiveDateTime: iso(-5),
      component: [{ code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 120, code: 'mm[Hg]' } }, { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 80, code: 'mm[Hg]' } }] };
    expect(fromFhirObservation(bp).observations.map((o) => [o.metric, o.value])).toEqual([['bp_systolic', 120], ['bp_diastolic', 80]]);
  });
  it('tested unit conversion keeps the original value/unit and flags it', () => {
    const t = fromFhirObservation({ ...hr(), code: { coding: [{ system: 'http://loinc.org', code: '8310-5' }] }, valueQuantity: { value: 98.6, code: '[degF]' } });
    expect(t.observations[0]).toMatchObject({ metric: 'temperature', value: 37, unit: 'Cel', original: { value: 98.6, unit: '[degF]' } });
    expect(validateObservation(t.observations[0], NOW).accepted!.flags).toContain('converted_from_original_unit');
    expect(convertUnit(310.15, 'K', 'temperature')?.value).toBe(37);
  });
  it.each([
    ['unsupported code', hr({ code: { coding: [{ system: 'http://loinc.org', code: '2339-0' }] } }), /unsupported_code_2339-0/],
    ['unsupported unit (no guessing)', hr({ valueQuantity: { value: 80, code: 'mg' } }), /unsupported_unit_mg_for_heart_rate/],
    ['missing time', hr({ effectiveDateTime: undefined }), /missing_effective_time/],
    ['non-final status', hr({ status: 'entered-in-error' }), /status_entered-in-error_not_ingested/],
    ['not an Observation', { resourceType: 'Patient' }, /not_an_observation/],
  ])('reports a problem for %s and ingests nothing', (_l, input, re) => {
    const r = fromFhirObservation(input);
    expect(r.problems.join()).toMatch(re);
    if (!/status_/.test(r.problems.join())) expect(r.observations).toEqual([]);
  });
  it('preliminary results carry unknown device quality', () => {
    expect(fromFhirObservation(hr({ status: 'preliminary' })).observations[0].deviceQuality).toBe('unknown');
  });
});

describe('simulator (synthetic, deterministic)', () => {
  it('is reproducible for a seed and always labelled simulation', () => {
    const a = simulate({ seed: 7, startMs: 0, count: 5 }), b = simulate({ seed: 7, startMs: 0, count: 5 });
    expect(a).toEqual(b); expect(a.simulation).toBe(true);
    expect(simulate({ seed: 8, startMs: 0, count: 5 }).observations).not.toEqual(a.observations);
  });
  it('can inject dropouts, duplicates and out-of-order arrival for adapter tests', () => {
    const drop = simulate({ seed: 1, startMs: 0, count: 10, metrics: ['heart_rate'], dropoutFrom: 4, dropoutLength: 3 }).observations;
    expect(drop).toHaveLength(7); expect(findGaps(drop.map((o) => o.sourceTime), 90)).toHaveLength(1);
    const dup = simulate({ seed: 1, startMs: 0, count: 10, metrics: ['heart_rate'], duplicateEvery: 3 }).observations;
    expect(new Set(dup.map((o) => o.sourceTime)).size).toBeLessThan(dup.length);
    const ooo = simulate({ seed: 1, startMs: 0, count: 10, metrics: ['heart_rate'], outOfOrderAt: 2 }).observations;
    expect(Date.parse(ooo[5].sourceTime)).toBeLessThan(Date.parse(ooo[4].sourceTime));
  });
});

describe('alert state machine (simulation only)', () => {
  const policy = { acknowledgeWithinSec: 300, escalateTo: 'on-call-synthetic' };
  it('open → acknowledged → closed, with an accountable actor recorded', () => {
    let a = AlertMachine.open('a1', 0);
    a = AlertMachine.acknowledge(a, 'nurse-synthetic', 60_000);
    a = AlertMachine.close(a, 'nurse-synthetic', 120_000);
    expect(a.state).toBe('closed'); expect(a.history.map((h) => h.event)).toEqual(['opened', 'acknowledged', 'closed']); expect(a.simulation).toBe(true);
  });
  it('missed acknowledgment escalates only after the deadline; escalation is idempotent', () => {
    const open = AlertMachine.open('a1', 0);
    expect(AlertMachine.escalateIfDue(open, policy, 299_000).state).toBe('open');
    const esc = AlertMachine.escalateIfDue(open, policy, 301_000);
    expect(esc).toMatchObject({ state: 'escalated', escalatedTo: 'on-call-synthetic' });
    expect(AlertMachine.escalateIfDue(esc, policy, 900_000)).toBe(esc);
  });
  it('an acknowledged alert is never escalated; an escalated one can still be acknowledged', () => {
    const ack = AlertMachine.acknowledge(AlertMachine.open('a', 0), 'n', 10);
    expect(AlertMachine.escalateIfDue(ack, policy, 10_000_000).state).toBe('acknowledged');
    expect(AlertMachine.acknowledge(AlertMachine.escalateIfDue(AlertMachine.open('b', 0), policy, 400_000), 'oncall', 500_000).state).toBe('acknowledged');
  });
  it('invalid transitions throw: close before ack, double close, anonymous acknowledge', () => {
    const open = AlertMachine.open('a', 0);
    expect(() => AlertMachine.close(open, 'x', 1)).toThrow(/acknowledged before/);
    expect(() => AlertMachine.acknowledge(open, '  ', 1)).toThrow(/accountable/);
    const closed = AlertMachine.close(AlertMachine.acknowledge(open, 'n', 1), 'n', 2);
    expect(() => AlertMachine.close(closed, 'n', 3)).toThrow(/already closed/);
    expect(() => AlertMachine.acknowledge(closed, 'n', 3)).toThrow(/cannot acknowledge/);
  });
});

describe('two clocks: source (physiological) vs receipt (communication) freshness', () => {
  const row = (srcOff: number, recvOff: number, value = 72, flags: Latest['flags'] = [], metric: Latest['metric'] = 'heart_rate'): Latest =>
    ({ metric, value, unit: METRICS[metric].unit, sourceTime: iso(srcOff), receivedTime: iso(recvOff), flags });
  const ev = (rows: Latest[], metrics: Latest['metric'][] = ['heart_rate']) => evaluateStatus(rows, NOW, { simulation: false, metrics });

  it('REGRESSION: a measurement taken an hour ago and received just now is NOT a current vital', () => {
    const s = ev([row(-3600, -2, 70, ['high_latency'])]);
    const m = s.metrics[0];
    expect(m.state).toBe('stale'); expect(m.value).toBeNull();                       // not in the current-value field
    expect(m.sourceAge).toBe('old'); expect(m.receiptAge).toBe('recent');
    expect(m.lastKnown).toMatchObject({ value: 70, sourceAgeSec: 3600, receiptAgeSec: 2, sourceTime: iso(-3600), receivedTime: iso(-2) });
    expect(m.label).toMatch(/NOT CURRENT.*measured 3600 s ago.*received 2 s ago/);
    expect(s.state).toBe('delayed');                                                  // communication is live; physiology is not
  });

  it('source fresh + receipt recent → current (the only way to get a value)', () => {
    const m = ev([row(-20, -5)]).metrics[0];
    expect(m).toMatchObject({ state: 'current', value: 72, sourceAge: 'fresh', receiptAge: 'recent' });
  });

  it('fresh measurement but silent device → stale (receipt clock); old measurement + silent → stale; both explicit', () => {
    const m = ev([row(-200, -200)]).metrics[0];                                       // both 200 s > 180 s window
    expect(m).toMatchObject({ state: 'stale', value: null, sourceAge: 'old', receiptAge: 'silent' });
    expect(m.label).toMatch(/STALE.*measured 200 s ago.*last heard 200 s ago/);
  });

  it('the window boundary: exactly at 3× the expected interval is still current, one second past is not', () => {
    expect(ev([row(-180, -1)]).metrics[0].state).toBe('current');
    expect(ev([row(-181, -1)]).metrics[0].state).toBe('stale');
  });

  it('clock skew: source slightly ahead within permitted skew is accepted as fresh; beyond skew is untrusted', () => {
    expect(ev([row(+60, 0)]).metrics[0]).toMatchObject({ state: 'current', sourceAge: 'fresh' });          // 60 s ahead ≤ 120 s skew
    const far = ev([row(+600, 0)]).metrics[0];
    expect(far).toMatchObject({ state: 'untrusted_time', value: null }); expect(far.flags).toContain('clock_ahead_of_receipt');
    expect(ev([row(+5, -30, 72, ['clock_ahead_of_receipt'])]).metrics[0].state).toBe('untrusted_time');    // stored flag is honoured even if times look plausible
  });

  it('a future-dated reading cannot shadow a genuine earlier measurement', () => {
    const m = ev([row(+900, -1, 999 - 900, ['clock_ahead_of_receipt']), row(-30, -29, 71)]).metrics[0];
    expect(m).toMatchObject({ state: 'current', value: 71 });
    expect(m.flags).toContain('clock_ahead_of_receipt');                                                   // the clock problem is still surfaced
  });

  it('out-of-order arrival: the most recent MEASUREMENT wins, not the most recent arrival', () => {
    const newer = row(-10, -60, 80), olderArrivedLast = row(-100, -1, 60, ['out_of_order']);
    expect(ev([olderArrivedLast, newer]).metrics[0]).toMatchObject({ state: 'current', value: 80 });
    // and when only the old one is fresh enough to matter it is still judged on its own source time
    expect(ev([row(-100, -1, 60, ['out_of_order'])]).metrics[0]).toMatchObject({ state: 'current', value: 60 });
    expect(ev([row(-500, -1, 60, ['out_of_order'])]).metrics[0]).toMatchObject({ state: 'stale', value: null });
  });

  it('reconnect backlog: a burst received now whose newest measurement is old exposes no current value', () => {
    const backlog = [-3000, -2400, -1800, -1200, -600].map((o, i) => row(o, -1, 60 + i, ['high_latency']));
    const s = ev(backlog);
    expect(s.metrics[0]).toMatchObject({ state: 'stale', value: null, lastKnown: { value: 64, sourceAgeSec: 600 } });
    expect(s.state).toBe('delayed');
    // once the backlog catches up to a fresh measurement, that measurement (only) is current
    expect(ev([...backlog, row(-15, -1, 77)]).metrics[0]).toMatchObject({ state: 'current', value: 77 });
  });

  it('only untrusted rows → untrusted_time with the reading retained as last-known with both timestamps', () => {
    const m = ev([row(+3000, -5, 66, ['clock_ahead_of_receipt'])]).metrics[0];
    expect(m).toMatchObject({ state: 'untrusted_time', value: null, lastKnown: { value: 66, sourceTime: iso(3000), receivedTime: iso(-5) } });
  });

  it('device state follows the receipt clock for connection and the source clock for "receiving"', () => {
    expect(ev([row(-20, -5)]).state).toBe('receiving');
    expect(ev([row(-3600, -5)]).state).toBe('delayed');
    expect(ev([row(-3600, -400)]).state).toBe('stale');
    expect(ev([row(-7200, -3600)]).state).toBe('disconnected');
  });

  it('metrics with different intervals use their own windows (temperature 300 s → 900 s window)', () => {
    const t = ev([row(-600, -1, 36.8, [], 'temperature')], ['temperature']).metrics[0];
    expect(t.state).toBe('current');
    expect(ev([row(-600, -1, 72)]).metrics[0].state).toBe('stale');                  // same age is too old for heart rate
  });
});
