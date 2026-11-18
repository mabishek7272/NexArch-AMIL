/**
 * Device reliability evaluation from a delivery log: completeness, gaps, duplicates, out-of-order delivery, delivery latency,
 * clock offset/drift and untrusted-clock rate, and — using the SAME freshness model the product uses — how much of the time a
 * current value would actually have been shown. Nothing here validates a device; it measures a recorded session.
 */
import { assessEvidence, EvidenceReport, EvidenceKind, median, quantile, rate, Rate, requireSchema, ValidationInputError } from './common';
import { DEFAULT_CLOCK_RULES, DEFAULT_STATUS_RULES, evaluateStatus, METRICS, MetricKey } from '../monitoring/model';

export interface DeviceLog {
  schema: 'anuclaw-device-log/v1';
  provenance: { kind: EvidenceKind; device: { kind: string; model?: string; firmware?: string }; recordedBy?: string; referenceClock?: string; protocolRef?: string };
  metric: MetricKey; windowStart: string; windowEnd: string;
  /** One row per delivered observation, in ARRIVAL order. */
  observations: Array<{ sourceTime: string; receivedTime: string; value?: number }>;
  /** Known outages injected/observed during the recording (for checking that gaps are detected). */
  knownOutages?: Array<{ from: string; to: string }>;
}
export interface DeviceEvaluation {
  schema: 'anuclaw-device-evaluation/v1'; metric: MetricKey; expectedIntervalSec: number;
  window: { start: string; end: string; seconds: number };
  completeness: { expected: number; uniqueDelivered: number; rate: Rate; duplicates: number; duplicateRate: Rate };
  gaps: { thresholdSec: number; count: number; longestSec: number | null; totalGapSec: number; list: Array<{ from: string; to: string; seconds: number }>; knownOutagesDetected?: { detected: number; total: number } };
  delivery: { latencySec: { p50: number | null; p95: number | null; p99: number | null; max: number | null }; delayedBeyondMaxLatency: Rate; outOfOrder: Rate; backlogBursts: number };
  clock: { medianOffsetSec: number | null; driftSecPerHour: number | null; aheadOfReceiptBeyondSkew: Rate; untrustedClockSuspected: boolean };
  currentValueAvailability: { stepSec: number; fractionCurrent: number | null; fractionStale: number | null; fractionNoData: number | null; note: string };
  evidence: EvidenceReport;
}

const ms = (s: string) => Date.parse(s);

export function evaluateDevice(log: DeviceLog, opts: { minObservations?: number; maxLatencySec?: number; maxFutureSkewSec?: number; stepSec?: number } = {}): DeviceEvaluation {
  requireSchema(log, 'anuclaw-device-log/v1', 'device log');
  const problems: string[] = [];
  if (!Object.hasOwn(METRICS, log.metric)) problems.push(`unknown metric ${log.metric}`);
  const w0 = ms(log.windowStart), w1 = ms(log.windowEnd);
  if (!(w1 > w0)) problems.push('windowEnd must be after windowStart');
  for (const [i, o] of log.observations.entries()) if (Number.isNaN(ms(o.sourceTime)) || Number.isNaN(ms(o.receivedTime))) problems.push(`observation ${i} has an unparsable time`);
  if (problems.length) throw new ValidationInputError(problems);

  const interval = METRICS[log.metric].expectedIntervalSec, maxLat = opts.maxLatencySec ?? DEFAULT_CLOCK_RULES.maxLatencySec, skew = opts.maxFutureSkewSec ?? DEFAULT_CLOCK_RULES.maxFutureSkewSec;
  const obs = log.observations.map((o) => ({ s: ms(o.sourceTime), r: ms(o.receivedTime) }));
  const windowSec = (w1 - w0) / 1000;
  const expected = Math.floor(windowSec / interval);
  const seen = new Set<number>(); let dup = 0; const uniq: Array<{ s: number; r: number }> = [];
  for (const o of obs) { if (seen.has(o.s)) { dup++; continue; } seen.add(o.s); uniq.push(o); }
  const inWindow = uniq.filter((o) => o.s >= w0 && o.s <= w1);

  // gaps on SOURCE time (what physiology was actually covered)
  const times = [w0, ...inWindow.map((o) => o.s).sort((a, b) => a - b), w1];
  const thr = interval * 3; const gaps: DeviceEvaluation['gaps']['list'] = [];
  for (let i = 1; i < times.length; i++) { const g = (times[i] - times[i - 1]) / 1000; if (g > thr) gaps.push({ from: new Date(times[i - 1]).toISOString(), to: new Date(times[i]).toISOString(), seconds: g }); }
  const outagesDetected = log.knownOutages ? log.knownOutages.filter((k) => gaps.some((g) => ms(g.from) <= ms(k.to) && ms(g.to) >= ms(k.from))).length : undefined;

  // delivery
  const lat = obs.map((o) => (o.r - o.s) / 1000);
  const nonNeg = lat.filter((x) => x >= 0).sort((a, b) => a - b);
  let ooo = 0, maxSrc = -Infinity; for (const o of obs) { if (o.s < maxSrc) ooo++; else maxSrc = o.s; }
  // backlog burst: >= 5 observations delivered within 1 s whose source times span > 3 intervals
  let bursts = 0; const byRecv = [...obs].sort((a, b) => a.r - b.r);
  for (let i = 0; i < byRecv.length;) { let j = i; while (j + 1 < byRecv.length && byRecv[j + 1].r - byRecv[i].r <= 1000) j++; const grp = byRecv.slice(i, j + 1); if (grp.length >= 5 && (Math.max(...grp.map((x) => x.s)) - Math.min(...grp.map((x) => x.s))) / 1000 > interval * 3) bursts++; i = j + 1; }

  // clock: offset = received - source; drift = slope of offset against source time
  const offs = obs.map((o) => ({ x: (o.s - w0) / 3_600_000, y: (o.r - o.s) / 1000 }));
  let drift: number | null = null;
  if (offs.length >= 3) { const mx = offs.reduce((a, b) => a + b.x, 0) / offs.length, my = offs.reduce((a, b) => a + b.y, 0) / offs.length; const vx = offs.reduce((a, b) => a + (b.x - mx) ** 2, 0); drift = vx > 0 ? offs.reduce((a, b) => a + (b.x - mx) * (b.y - my), 0) / vx : null; }
  const ahead = lat.filter((x) => x < -skew).length;

  // replay with the product's freshness model
  const step = opts.stepSec ?? Math.max(5, Math.floor(interval / 4)); const spec = METRICS[log.metric];
  const sorted = [...obs].sort((a, b) => a.r - b.r);
  let cur = 0, stale = 0, none = 0, total = 0;
  for (let t = w0 + step * 1000; t <= w1; t += step * 1000) {
    const delivered = sorted.filter((o) => o.r <= t);
    total++;
    if (!delivered.length) { none++; continue; }
    const rows = delivered.slice(-400).map((o) => ({ metric: log.metric, value: 0, unit: spec.unit, sourceTime: new Date(o.s).toISOString(), receivedTime: new Date(o.r).toISOString(), flags: [] as never[] }));
    const st = evaluateStatus(rows, new Date(t), { simulation: false, rules: DEFAULT_STATUS_RULES, clock: { maxFutureSkewSec: skew, maxLatencySec: maxLat }, metrics: [log.metric] }).metrics[0];
    if (st.state === 'current') cur++; else if (st.state === 'no_data') none++; else stale++;
  }
  const minObs = opts.minObservations ?? 1000;
  return {
    schema: 'anuclaw-device-evaluation/v1', metric: log.metric, expectedIntervalSec: interval,
    window: { start: log.windowStart, end: log.windowEnd, seconds: windowSec },
    completeness: { expected, uniqueDelivered: inWindow.length, rate: rate(Math.min(inWindow.length, expected), expected), duplicates: dup, duplicateRate: rate(dup, obs.length) },
    gaps: { thresholdSec: thr, count: gaps.length, longestSec: gaps.length ? Math.max(...gaps.map((g) => g.seconds)) : null, totalGapSec: gaps.reduce((a, g) => a + g.seconds, 0), list: gaps, ...(outagesDetected !== undefined ? { knownOutagesDetected: { detected: outagesDetected, total: log.knownOutages!.length } } : {}) },
    delivery: { latencySec: { p50: quantile(nonNeg, 0.5), p95: quantile(nonNeg, 0.95), p99: quantile(nonNeg, 0.99), max: nonNeg.length ? nonNeg[nonNeg.length - 1] : null }, delayedBeyondMaxLatency: rate(lat.filter((x) => x > maxLat).length, lat.length), outOfOrder: rate(ooo, obs.length), backlogBursts: bursts },
    clock: { medianOffsetSec: median(lat), driftSecPerHour: drift, aheadOfReceiptBeyondSkew: rate(ahead, lat.length), untrustedClockSuspected: ahead > 0 || (drift !== null && Math.abs(drift) > skew) },
    currentValueAvailability: { stepSec: step, fractionCurrent: total ? cur / total : null, fractionStale: total ? stale / total : null, fractionNoData: total ? none / total : null, note: 'Replayed with the same two-clock freshness rules the product applies (src/monitoring/model.ts). A value counts as current only if the measurement AND the delivery are recent and the device clock is trusted.' },
    evidence: assessEvidence({ kind: log.provenance.kind, n: obs.length, minN: minObs, minSource: opts.minObservations !== undefined ? 'caller_specified' : 'tool_default_placeholder', protocolRef: log.provenance.protocolRef, extra: ['a single recorded session of one device cannot establish reliability across devices, sites or conditions'] }),
  };
}
