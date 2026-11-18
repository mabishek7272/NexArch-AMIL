/**
 * Physiological monitoring — pure logic (plan §9.2). No I/O.
 *
 * Principles enforced here:
 *  - Observations keep source clock AND receipt time; clock drift, future timestamps, duplicates and
 *    out-of-order arrival are detected and flagged, never silently "fixed".
 *  - An unusual value is NOT treated as a sensor error. Only physically impossible values are
 *    rejected (explicit bounds); everything else is stored exactly as received.
 *  - Silence, lost connection, delayed/backlog data and untrusted device clocks are never shown as a current
 *    reading: they yield `value: null` plus a labelled last-known value with source and receipt timestamps.
 *  - Nothing here interprets a value as normal/abnormal. Alerts are simulation-only (see AlertMachine).
 *  - Simulated data is always labelled `simulation: true` and cannot be mixed into real devices.
 */

export type MetricKey = 'heart_rate' | 'spo2' | 'resp_rate' | 'temperature' | 'bp_systolic' | 'bp_diastolic';

export interface MetricSpec { unit: string; /** physical-impossibility bounds only */ min: number; max: number; expectedIntervalSec: number; limitation?: string }

export const METRICS: Record<MetricKey, MetricSpec> = {
  heart_rate: { unit: '/min', min: 0, max: 400, expectedIntervalSec: 60 },
  spo2: { unit: '%', min: 0, max: 100, expectedIntervalSec: 60,
    limitation: 'Pulse oximetry has documented accuracy limitations (e.g. skin pigmentation, perfusion, motion); a reading is not a diagnosis.' },
  resp_rate: { unit: '/min', min: 0, max: 150, expectedIntervalSec: 60 },
  temperature: { unit: 'Cel', min: 10, max: 50, expectedIntervalSec: 300 },
  bp_systolic: { unit: 'mm[Hg]', min: 0, max: 400, expectedIntervalSec: 300 },
  bp_diastolic: { unit: 'mm[Hg]', min: 0, max: 300, expectedIntervalSec: 300 },
};

export interface RawObservation {
  metric: string; value: unknown; unit: string; sourceTime: string; sequence?: number | null;
  deviceQuality?: 'good' | 'poor' | 'unknown' | null;
  /** Original value/unit when an adapter converted (kept for audit). */
  original?: { value: number; unit: string };
}

export type QualityFlag = 'clock_ahead_of_receipt' | 'high_latency' | 'out_of_order' | 'device_reported_poor_quality' | 'converted_from_original_unit';

export type RejectReason = 'unknown_metric' | 'unit_mismatch' | 'value_not_finite' | 'value_physically_impossible' | 'bad_source_time';

export interface AcceptedObservation {
  metric: MetricKey; value: number; unit: string; sourceTime: string; receivedTime: string; sequence: number | null;
  flags: QualityFlag[]; limitation: string | null; original?: { value: number; unit: string };
}

export interface ClockRules { maxFutureSkewSec: number; maxLatencySec: number }
export const DEFAULT_CLOCK_RULES: ClockRules = { maxFutureSkewSec: 120, maxLatencySec: 900 };

export interface ValidationResult { accepted?: AcceptedObservation; rejected?: { reason: RejectReason; metric: string } }

/** `lastAcceptedSourceMs` = latest source time already stored for this device+metric (for ordering). */
export function validateObservation(o: RawObservation, receivedAt: Date, rules: ClockRules = DEFAULT_CLOCK_RULES, lastAcceptedSourceMs?: number): ValidationResult {
  if (!Object.hasOwn(METRICS, o.metric)) return { rejected: { reason: 'unknown_metric', metric: String(o.metric) } };
  const metric = o.metric as MetricKey, spec = METRICS[metric];
  if (o.unit !== spec.unit) return { rejected: { reason: 'unit_mismatch', metric } };
  if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return { rejected: { reason: 'value_not_finite', metric } };
  if (o.value < spec.min || o.value > spec.max) return { rejected: { reason: 'value_physically_impossible', metric } };
  const t = typeof o.sourceTime === 'string' ? Date.parse(o.sourceTime) : NaN;
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(o.sourceTime)) return { rejected: { reason: 'bad_source_time', metric } };

  const flags: QualityFlag[] = [];
  const recv = receivedAt.getTime();
  if (t > recv + rules.maxFutureSkewSec * 1000) flags.push('clock_ahead_of_receipt');
  if (recv - t > rules.maxLatencySec * 1000) flags.push('high_latency');
  if (lastAcceptedSourceMs !== undefined && t < lastAcceptedSourceMs) flags.push('out_of_order');
  if (o.deviceQuality === 'poor') flags.push('device_reported_poor_quality');
  if (o.original) flags.push('converted_from_original_unit');
  return {
    accepted: {
      metric, value: o.value, unit: o.unit, sourceTime: new Date(t).toISOString(), receivedTime: receivedAt.toISOString(),
      sequence: Number.isInteger(o.sequence) ? (o.sequence as number) : null, flags, limitation: spec.limitation ?? null,
      ...(o.original ? { original: o.original } : {}),
    },
  };
}

// ── freshness / connection status ────────────────────────────────────────────
//
// TWO clocks, never conflated:
//   receipt time  → communication freshness (when we last heard from the device)
//   source time   → physiological freshness (when the measurement was actually taken)
// A reading is shown as a CURRENT value only if BOTH are fresh AND the source clock is trustworthy.
// Anything else is kept as a last-known value with both timestamps, never in the current-value field.

export type MetricState = 'current' | 'stale' | 'untrusted_time' | 'no_data';
export type DeviceState = 'receiving' | 'delayed' | 'stale' | 'disconnected' | 'no_data';
/** Age of the MEASUREMENT (source clock). `future` = source time later than permitted skew allows. */
export type SourceAge = 'fresh' | 'old' | 'future';
/** Age of the last COMMUNICATION (receipt clock). */
export type ReceiptAge = 'recent' | 'silent';

export interface Latest { metric: MetricKey; value: number; unit: string; sourceTime: string; receivedTime: string; flags: QualityFlag[] }
export interface StatusRules { staleFactor: number; disconnectFactor: number }
export const DEFAULT_STATUS_RULES: StatusRules = { staleFactor: 3, disconnectFactor: 10 };

export interface LastKnown {
  value: number; sourceTime: string; receivedTime: string;
  /** now − source time (null when the source clock is untrusted: the age cannot be known). */
  sourceAgeSec: number | null; receiptAgeSec: number;
  /** Kept for existing consumers: equals sourceAgeSec, or receiptAgeSec when the source clock is untrusted. */
  ageSec: number;
  sourceAge: SourceAge; receiptAge: ReceiptAge;
}
export interface MetricStatus {
  metric: MetricKey; state: MetricState;
  /** Present ONLY when state is 'current'. Stale/untrusted/no-data readings are never exposed as a live value. */
  value: number | null; unit: string;
  lastKnown: LastKnown | null;
  sourceAge: SourceAge | null; receiptAge: ReceiptAge | null;
  flags: QualityFlag[]; label: string;
}
export interface DeviceStatus { state: DeviceState; metrics: MetricStatus[]; simulation: boolean; banner: string | null; note: string }

/**
 * Per metric, the input may hold several candidate rows (e.g. the latest trusted one and the latest one with an
 * untrusted clock). Selection is by SOURCE time among rows whose clock is trustworthy; ordering of arrival
 * cannot promote an older measurement over a newer one, and a future-dated reading cannot shadow a real one.
 */
export function evaluateStatus(latest: Latest[], now: Date, opts: { simulation: boolean; rules?: StatusRules; clock?: ClockRules; metrics?: MetricKey[] }): DeviceStatus {
  const rules = opts.rules ?? DEFAULT_STATUS_RULES, clock = opts.clock ?? DEFAULT_CLOCK_RULES;
  const keys = opts.metrics ?? (Object.keys(METRICS) as MetricKey[]);
  const nowMs = now.getTime(), skewMs = clock.maxFutureSkewSec * 1000;
  const untrusted = (l: Latest) => {
    const t = Date.parse(l.sourceTime), r = Date.parse(l.receivedTime);
    return l.flags.includes('clock_ahead_of_receipt') || Number.isNaN(t) || t > r + skewMs || t > nowMs + skewMs;
  };
  const metrics: MetricStatus[] = keys.map((metric): MetricStatus => {
    const spec = METRICS[metric], rows = latest.filter((l) => l.metric === metric);
    if (!rows.length) return { metric, state: 'no_data', value: null, unit: spec.unit, lastKnown: null, sourceAge: null, receiptAge: null, flags: [], label: 'No data received' };
    const windowSec = spec.expectedIntervalSec * rules.staleFactor;
    const trusted = rows.filter((l) => !untrusted(l)).sort((x, y) => Date.parse(y.sourceTime) - Date.parse(x.sourceTime) || Date.parse(y.receivedTime) - Date.parse(x.receivedTime));
    const anyUntrusted = rows.some(untrusted);
    const pick = trusted[0] ?? rows.slice().sort((x, y) => Date.parse(y.receivedTime) - Date.parse(x.receivedTime))[0];
    const trustedPick = trusted.length > 0;
    const receiptAgeSec = Math.max(0, (nowMs - Date.parse(pick.receivedTime)) / 1000);
    const receiptAge: ReceiptAge = receiptAgeSec > windowSec ? 'silent' : 'recent';
    const flags = [...new Set<QualityFlag>([...pick.flags, ...(anyUntrusted ? ['clock_ahead_of_receipt' as QualityFlag] : [])])];
    if (!trustedPick) {
      const lk: LastKnown = { value: pick.value, sourceTime: pick.sourceTime, receivedTime: pick.receivedTime, sourceAgeSec: null, receiptAgeSec: Math.round(receiptAgeSec), ageSec: Math.round(receiptAgeSec), sourceAge: 'future', receiptAge };
      return { metric, state: 'untrusted_time', value: null, unit: spec.unit, lastKnown: lk, sourceAge: 'future', receiptAge, flags, label: 'UNTRUSTED DEVICE CLOCK — measurement time is later than the time it was received; not shown as a current reading' };
    }
    const sourceAgeSec = Math.max(0, (nowMs - Date.parse(pick.sourceTime)) / 1000);
    const sourceAge: SourceAge = sourceAgeSec > windowSec ? 'old' : 'fresh';
    const lk: LastKnown = { value: pick.value, sourceTime: pick.sourceTime, receivedTime: pick.receivedTime, sourceAgeSec: Math.round(sourceAgeSec), receiptAgeSec: Math.round(receiptAgeSec), ageSec: Math.round(sourceAgeSec), sourceAge, receiptAge };
    const current = sourceAge === 'fresh' && receiptAge === 'recent';
    const label = current ? 'Current'
      : sourceAge === 'old' && receiptAge === 'recent' ? `NOT CURRENT — measured ${Math.round(sourceAgeSec)} s ago (received ${Math.round(receiptAgeSec)} s ago); delayed or backlog data is not a current reading`
        : `STALE — measured ${Math.round(sourceAgeSec)} s ago, last heard ${Math.round(receiptAgeSec)} s ago; not a current reading`;
    return { metric, state: current ? 'current' : 'stale', value: current ? pick.value : null, unit: spec.unit, lastKnown: lk, sourceAge, receiptAge, flags, label };
  });
  const seen = metrics.filter((m) => m.state !== 'no_data');
  let state: DeviceState;
  if (!seen.length) state = 'no_data';
  else {
    // Communication state is judged on the RECEIPT clock only.
    const freshest = Math.min(...seen.map((m) => m.lastKnown!.receiptAgeSec / METRICS[m.metric].expectedIntervalSec));
    state = freshest > rules.disconnectFactor ? 'disconnected'
      : metrics.some((m) => m.state === 'current') ? 'receiving'
        : seen.some((m) => m.receiptAge === 'recent') ? 'delayed' : 'stale';
  }
  return {
    state, metrics, simulation: opts.simulation,
    banner: opts.simulation ? 'SIMULATION — synthetic data, not a real patient or device' : null,
    note: 'No value is interpreted as normal or abnormal. A current value requires both a recent measurement time and recent communication; absence of data is not a normal reading.',
  };
}

export interface Gap { from: string; to: string; seconds: number }
/** Gaps between consecutive source times larger than maxGapSec (times need not be sorted). */
export function findGaps(sourceTimes: string[], maxGapSec: number): Gap[] {
  const t = sourceTimes.map((s) => Date.parse(s)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const gaps: Gap[] = [];
  for (let i = 1; i < t.length; i++) if ((t[i] - t[i - 1]) / 1000 > maxGapSec) gaps.push({ from: new Date(t[i - 1]).toISOString(), to: new Date(t[i]).toISOString(), seconds: (t[i] - t[i - 1]) / 1000 });
  return gaps;
}

// ── FHIR Observation adapter ─────────────────────────────────────────────────

const LOINC: Record<string, MetricKey> = { '8867-4': 'heart_rate', '59408-5': 'spo2', '2708-6': 'spo2', '9279-1': 'resp_rate', '8310-5': 'temperature', '8480-6': 'bp_systolic', '8462-4': 'bp_diastolic' };
const BP_PANEL = '85354-9';

/** Dimension-aware conversions; anything else is rejected (no guessing). */
export function convertUnit(value: number, unit: string, metric: MetricKey): { value: number; unit: string; converted: boolean } | null {
  const target = METRICS[metric].unit;
  if (unit === target) return { value, unit, converted: false };
  if (metric === 'temperature' && (unit === '[degF]' || unit === 'degF')) return { value: Math.round(((value - 32) * 5 / 9) * 1000) / 1000, unit: 'Cel', converted: true };
  if (metric === 'temperature' && (unit === 'K')) return { value: Math.round((value - 273.15) * 1000) / 1000, unit: 'Cel', converted: true };
  if (metric === 'heart_rate' && unit === '{beats}/min') return { value, unit: '/min', converted: false };
  if (metric === 'resp_rate' && unit === '{breaths}/min') return { value, unit: '/min', converted: false };
  if (metric === 'spo2' && unit === '%') return { value, unit, converted: false };
  return null;
}

export type FhirResult = { observations: RawObservation[]; deviceRef: string | null; problems: string[] };

const codingsOf = (c: any): string[] => (Array.isArray(c?.coding) ? c.coding.filter((x: any) => x?.system === 'http://loinc.org' && typeof x.code === 'string').map((x: any) => x.code) : []);

export function fromFhirObservation(res: any): FhirResult {
  const problems: string[] = [], out: RawObservation[] = [];
  if (!res || res.resourceType !== 'Observation') return { observations: [], deviceRef: null, problems: ['not_an_observation'] };
  if (res.status && !['final', 'amended', 'corrected', 'preliminary'].includes(res.status)) problems.push(`status_${res.status}_not_ingested`);
  const time: string | undefined = res.effectiveDateTime ?? res.effectiveInstant;
  if (typeof time !== 'string') problems.push('missing_effective_time');
  const deviceRef: string | null = typeof res.device?.reference === 'string' ? res.device.reference : null;
  const quality = res.status === 'preliminary' ? 'unknown' : 'good';

  const push = (codes: string[], q: any) => {
    const metrics = codes.map((c) => LOINC[c]).filter(Boolean);
    if (!metrics.length) { problems.push(`unsupported_code_${codes[0] ?? 'none'}`); return; }
    if (typeof q?.value !== 'number' || typeof q?.unit !== 'string' && typeof q?.code !== 'string') { problems.push('missing_quantity'); return; }
    const unit = String(q.code ?? q.unit);
    const conv = convertUnit(q.value, unit, metrics[0]);
    if (!conv) { problems.push(`unsupported_unit_${unit}_for_${metrics[0]}`); return; }
    if (typeof time !== 'string') return;
    out.push({ metric: metrics[0], value: conv.value, unit: conv.unit, sourceTime: time, deviceQuality: quality, ...(conv.converted ? { original: { value: q.value, unit } } : {}) });
  };

  const codes = codingsOf(res.code);
  if (codes.includes(BP_PANEL)) {
    for (const comp of Array.isArray(res.component) ? res.component : []) push(codingsOf(comp.code), comp.valueQuantity);
  } else push(codes, res.valueQuantity);
  return { observations: out, deviceRef, problems };
}

// ── deterministic simulator (explicitly synthetic) ───────────────────────────

export interface SimOptions { seed: number; startMs: number; count: number; intervalSec?: number; metrics?: MetricKey[]; dropoutFrom?: number; dropoutLength?: number; duplicateEvery?: number; outOfOrderAt?: number }

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Synthetic generator for tests/demos. Values are arbitrary smooth noise — they carry NO physiological meaning. */
export function simulate(o: SimOptions): { observations: RawObservation[]; simulation: true } {
  const r = rng(o.seed), step = (o.intervalSec ?? 60) * 1000, metrics = o.metrics ?? ['heart_rate', 'spo2'];
  const base: Record<MetricKey, number> = { heart_rate: 70, spo2: 97, resp_rate: 14, temperature: 36.8, bp_systolic: 118, bp_diastolic: 76 };
  const obs: RawObservation[] = [];
  for (let i = 0; i < o.count; i++) {
    if (o.dropoutFrom !== undefined && i >= o.dropoutFrom && i < o.dropoutFrom + (o.dropoutLength ?? 0)) continue; // sensor dropout
    for (const m of metrics) {
      const v = Math.round((base[m] + (r() - 0.5) * 4) * 10) / 10;
      obs.push({ metric: m, value: Math.min(METRICS[m].max, Math.max(METRICS[m].min, v)), unit: METRICS[m].unit, sourceTime: new Date(o.startMs + i * step).toISOString(), sequence: i, deviceQuality: 'unknown' });
    }
    if (o.duplicateEvery && i > 0 && i % o.duplicateEvery === 0) obs.push({ ...obs[obs.length - metrics.length] });
  }
  if (o.outOfOrderAt !== undefined && obs.length > o.outOfOrderAt + 3) { const [x] = obs.splice(o.outOfOrderAt, 1); obs.splice(o.outOfOrderAt + 3, 0, x); }
  return { observations: obs, simulation: true };
}

// ── alert state machine (SIMULATION ONLY) ────────────────────────────────────

export type AlertState = 'open' | 'acknowledged' | 'escalated' | 'closed';
export interface AlertPolicy { acknowledgeWithinSec: number; escalateTo: string }
export interface AlertRecord { id: string; state: AlertState; simulation: true; openedAt: number; acknowledgedAt?: number; escalatedAt?: number; closedAt?: number; acknowledgedBy?: string; escalatedTo?: string; history: Array<{ at: number; event: string; by?: string }> }

/**
 * Pure transitions for the alert workflow. REAL alerts are not available: monitoring_alerts are only
 * created for simulation devices (`simulation: true` is part of the type). Missed acknowledgment → escalation
 * is evaluated against an explicit deadline, never inferred.
 */
export const AlertMachine = {
  open(id: string, now: number): AlertRecord { return { id, state: 'open', simulation: true, openedAt: now, history: [{ at: now, event: 'opened' }] }; },
  acknowledge(a: AlertRecord, by: string, now: number): AlertRecord {
    if (a.state !== 'open' && a.state !== 'escalated') throw new Error(`cannot acknowledge an alert in state ${a.state}`);
    if (!by?.trim()) throw new Error('an accountable acknowledger is required');
    return { ...a, state: 'acknowledged', acknowledgedAt: now, acknowledgedBy: by, history: [...a.history, { at: now, event: 'acknowledged', by }] };
  },
  /** Escalates an UNACKNOWLEDGED alert only once its deadline has passed. Idempotent for already-escalated alerts. */
  escalateIfDue(a: AlertRecord, policy: AlertPolicy, now: number): AlertRecord {
    if (a.state !== 'open') return a;
    if (now - a.openedAt < policy.acknowledgeWithinSec * 1000) return a;
    return { ...a, state: 'escalated', escalatedAt: now, escalatedTo: policy.escalateTo, history: [...a.history, { at: now, event: 'escalated', by: policy.escalateTo }] };
  },
  close(a: AlertRecord, by: string, now: number): AlertRecord {
    if (a.state === 'closed') throw new Error('alert already closed');
    if (a.state === 'open' || a.state === 'escalated') throw new Error('an alert must be acknowledged before it is closed');
    return { ...a, state: 'closed', closedAt: now, history: [...a.history, { at: now, event: 'closed', by }] };
  },
};
