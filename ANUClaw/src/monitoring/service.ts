/**
 * Monitoring service (plan §9.2). Callers (routes) enforce patient access first.
 *
 * Device kinds: `simulator` (synthetic, labelled), `fhir_gateway` (FHIR Observation adapter) and
 * `manual_entry`. NO real hardware adapter exists — device identity/authentication, pairing at the
 * bedside and measured reliability are external requirements. A simulator device can only receive
 * simulator output and vice versa, so synthetic data cannot enter a real device's record.
 * Alerts exist ONLY for simulator devices (database CHECK + service guard). Emergency alerting is disabled.
 */
import * as crypto from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import {
  AlertMachine, AlertPolicy, AlertRecord, DEFAULT_CLOCK_RULES, MetricKey, METRICS, RawObservation, evaluateStatus, findGaps,
  fromFhirObservation, simulate, SimOptions, validateObservation, Latest, QualityFlag,
} from './model';

export type DeviceKind = 'simulator' | 'fhir_gateway' | 'manual_entry';
const KINDS: DeviceKind[] = ['simulator', 'fhir_gateway', 'manual_entry'];
export const MAX_BATCH = 1000;

export async function pairDevice(a: { patientId: string; userId: string; kind: unknown; label: unknown; purpose: unknown }) {
  if (!KINDS.includes(a.kind as DeviceKind)) throw new WorkflowError(400, 'validation', `kind must be one of ${KINDS.join(', ')}`);
  const label = typeof a.label === 'string' ? a.label.trim() : '', purpose = typeof a.purpose === 'string' ? a.purpose.trim() : '';
  if (!label || label.length > 200) throw new WorkflowError(400, 'validation', 'label is required (≤ 200 chars).');
  if (purpose.length < 5) throw new WorkflowError(400, 'validation', 'A purpose of use is required.');
  const id = crypto.randomUUID(), kind = a.kind as DeviceKind;
  await db.query(`INSERT INTO monitoring_devices (id, patient_id, kind, label, simulation, purpose, paired_by, paired_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, a.patientId, kind, label, kind === 'simulator', purpose, a.userId, Date.now()]);
  return { deviceId: id, kind, simulation: kind === 'simulator', banner: kind === 'simulator' ? 'SIMULATION — synthetic data' : null };
}

async function activeDevice(deviceId: string) {
  const d = await db.queryOne<any>('SELECT * FROM monitoring_devices WHERE id = $1', [deviceId]);
  if (!d) throw new WorkflowError(404, 'not_found', 'Device not found.');
  if (d.unpaired_at) throw new WorkflowError(409, 'device_unpaired', 'This device has been unpaired.');
  return d;
}

export async function unpairDevice(deviceId: string) {
  const r = await db.query(`UPDATE monitoring_devices SET unpaired_at = $2 WHERE id = $1 AND unpaired_at IS NULL RETURNING id`, [deviceId, Date.now()]);
  if (!r.length) throw new WorkflowError(409, 'not_active', 'Device not found or already unpaired.');
  return { ok: true };
}

export interface IngestResult { accepted: number; duplicates: number; rejected: Array<{ reason: string; metric: string; count: number }>; adapterProblems: string[]; flagged: Record<string, number> }

async function store(device: any, obs: RawObservation[], by: string, adapterProblems: string[], now: Date): Promise<IngestResult> {
  if (obs.length > MAX_BATCH) throw new WorkflowError(413, 'batch_too_large', `At most ${MAX_BATCH} observations per request.`);
  return db.transaction(async (tx) => {
    // Serialise ingestion per device so ordering decisions are consistent.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mon:${device.id}`]);
    const lastRows = await tx.query<{ metric: string; t: string }>('SELECT metric, MAX(source_time) AS t FROM monitoring_observations WHERE device_id = $1 GROUP BY metric', [device.id]);
    const last = new Map(lastRows.rows.map((r) => [r.metric, Number(r.t)]));
    let accepted = 0, duplicates = 0; const rejected = new Map<string, number>(); const flagged: Record<string, number> = {};
    for (const o of obs) {
      const v = validateObservation(o, now, DEFAULT_CLOCK_RULES, last.get(o.metric));
      if (v.rejected) { const k = `${v.rejected.reason}|${v.rejected.metric}`; rejected.set(k, (rejected.get(k) ?? 0) + 1); continue; }
      const a = v.accepted!, t = Date.parse(a.sourceTime);
      const ins = await tx.query(
        `INSERT INTO monitoring_observations (id, device_id, patient_id, metric, value, unit, source_time, received_time, sequence, flags_json, limitation, original_json, simulation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (device_id, metric, source_time) DO NOTHING`,
        [crypto.randomUUID(), device.id, device.patient_id, a.metric, a.value, a.unit, t, now.getTime(), a.sequence, JSON.stringify(a.flags), a.limitation, a.original ? JSON.stringify(a.original) : null, device.simulation]);
      if (ins.rowCount === 0) { duplicates++; continue; }
      accepted++; for (const f of a.flags) flagged[f] = (flagged[f] ?? 0) + 1;
      if (!last.has(a.metric) || t > last.get(a.metric)!) last.set(a.metric, t);
    }
    const rej = [...rejected].map(([k, count]) => { const [reason, metric] = k.split('|'); return { reason, metric, count }; });
    await tx.query(`INSERT INTO monitoring_ingest_log (id, device_id, received_at, accepted, duplicates, rejected_json, adapter_problems_json, by_user) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), device.id, now.getTime(), accepted, duplicates, JSON.stringify(rej), JSON.stringify(adapterProblems), by]);
    return { accepted, duplicates, rejected: rej, adapterProblems, flagged };
  });
}

/** Raw or FHIR observations — real device kinds only (never a simulator device). */
export async function ingest(a: { deviceId: string; userId: string; observations?: unknown; fhir?: unknown; now?: Date }): Promise<IngestResult> {
  const d = await activeDevice(a.deviceId);
  if (d.simulation) throw new WorkflowError(409, 'simulator_device', 'Simulator devices only accept simulator output; use /simulate.');
  let obs: RawObservation[] = []; const problems: string[] = [];
  if (a.fhir !== undefined) {
    if (d.kind !== 'fhir_gateway') throw new WorkflowError(409, 'wrong_device_kind', 'FHIR input is only accepted by fhir_gateway devices.');
    const list = Array.isArray(a.fhir) ? a.fhir : [a.fhir];
    for (const r of list) { const f = fromFhirObservation(r); obs.push(...f.observations); problems.push(...f.problems); }
  } else if (Array.isArray(a.observations)) obs = a.observations as RawObservation[];
  else throw new WorkflowError(400, 'validation', 'Provide `observations` (array) or `fhir` (Observation resource(s)).');
  return store(d, obs, a.userId, problems, a.now ?? new Date());
}

/** Synthetic stream into a simulator device. */
export async function simulateInto(a: { deviceId: string; userId: string; options: Partial<SimOptions>; now?: Date }): Promise<IngestResult & { simulation: true }> {
  const d = await activeDevice(a.deviceId);
  if (!d.simulation) throw new WorkflowError(409, 'not_a_simulator', 'Only simulator devices accept synthetic data.');
  const now = a.now ?? new Date(), o = a.options;
  const count = Math.min(Math.max(Math.trunc(Number(o.count ?? 20)), 1), 200);
  const metrics = (o.metrics ?? ['heart_rate', 'spo2']).filter((m) => Object.hasOwn(METRICS, m)) as MetricKey[];
  const sim = simulate({ ...o, seed: Number(o.seed ?? 1), count, metrics, startMs: Number(o.startMs ?? now.getTime() - count * (Number(o.intervalSec ?? 60)) * 1000) });
  return { ...(await store(d, sim.observations, a.userId, [], now)), simulation: true };
}

export async function status(deviceId: string, now = new Date()) {
  const d = await db.queryOne<any>('SELECT * FROM monitoring_devices WHERE id = $1', [deviceId]);
  if (!d) throw new WorkflowError(404, 'not_found', 'Device not found.');
  // Latest by SOURCE time (physiology), not arrival order. Rows whose device clock ran ahead of receipt are kept apart so a
  // future-dated reading can neither be shown as current nor shadow a real, earlier measurement.
  const pickLatest = (untrusted: boolean) => db.query<any>(
    `SELECT DISTINCT ON (metric) metric, value, unit, source_time, received_time, flags_json FROM monitoring_observations
      WHERE device_id = $1 AND (flags_json LIKE '%"clock_ahead_of_receipt"%') = $2 ORDER BY metric, source_time DESC, received_time DESC`, [deviceId, untrusted]);
  const rows = [...(await pickLatest(false)), ...(await pickLatest(true))];
  const latest: Latest[] = rows.map((r) => ({ metric: r.metric, value: r.value, unit: r.unit, sourceTime: new Date(Number(r.source_time)).toISOString(), receivedTime: new Date(Number(r.received_time)).toISOString(), flags: JSON.parse(r.flags_json) as QualityFlag[] }));
  const st = evaluateStatus(latest, now, { simulation: d.simulation });
  const times = await db.query<{ metric: string; t: string }>(`SELECT metric, source_time AS t FROM monitoring_observations WHERE device_id = $1 AND source_time > $2`, [deviceId, now.getTime() - 24 * 3600_000]);
  const gaps: Record<string, unknown> = {};
  for (const m of new Set(times.map((x) => x.metric))) gaps[m] = findGaps(times.filter((x) => x.metric === m).map((x) => new Date(Number(x.t)).toISOString()), METRICS[m as MetricKey].expectedIntervalSec * 3);
  return { deviceId, kind: d.kind, label: d.label, paired: !d.unpaired_at, ...st, gapsLast24h: gaps };
}

export async function listDevices(patientId: string) {
  return db.query('SELECT id, kind, label, simulation, purpose, paired_at, unpaired_at FROM monitoring_devices WHERE patient_id = $1 ORDER BY paired_at DESC', [patientId]);
}

export async function history(deviceId: string, limit = 100) {
  const rows = await db.query<any>('SELECT * FROM monitoring_observations WHERE device_id = $1 ORDER BY source_time DESC LIMIT $2', [deviceId, Math.min(Math.max(limit, 1), 1000)]);
  return rows.map((r) => ({ metric: r.metric, value: r.value, unit: r.unit, sourceTime: new Date(Number(r.source_time)).toISOString(), receivedTime: new Date(Number(r.received_time)).toISOString(), flags: JSON.parse(r.flags_json), limitation: r.limitation, original: r.original_json ? JSON.parse(r.original_json) : null, simulation: r.simulation }));
}

// ── alerts: simulation only ──────────────────────────────────────────────────

export const ALERT_GATE = {
  status: 'gated' as const,
  reason: 'Real alerting and emergency escalation are disabled: no clinically approved alert rules, validated delivery channel, recipient responsibility or measured latency exist. Alerts can only be created for simulator devices.',
};

export async function openSimulationAlert(deviceId: string, now = Date.now()) {
  const d = await activeDevice(deviceId);
  if (!d.simulation) throw new WorkflowError(409, 'alerts_gated_pending_validation', ALERT_GATE.reason);
  const rec = AlertMachine.open(crypto.randomUUID(), now);
  await db.query(`INSERT INTO monitoring_alerts (id, device_id, state, record_json, simulation, opened_at) VALUES ($1,$2,$3,$4,TRUE,$5)`, [rec.id, deviceId, rec.state, JSON.stringify(rec), now]);
  return { ...rec, banner: 'SIMULATION — no real recipient was notified' };
}

async function transition(alertId: string, fn: (a: AlertRecord) => AlertRecord) {
  return db.transaction(async (tx) => {
    const r = await tx.query<any>('SELECT * FROM monitoring_alerts WHERE id = $1 FOR UPDATE', [alertId]);
    if (!r.rows[0]) throw new WorkflowError(404, 'not_found', 'Alert not found.');
    let next: AlertRecord;
    try { next = fn(JSON.parse(r.rows[0].record_json)); } catch (e) { throw new WorkflowError(409, 'invalid_transition', (e as Error).message); }
    await tx.query('UPDATE monitoring_alerts SET state = $2, record_json = $3 WHERE id = $1', [alertId, next.state, JSON.stringify(next)]);
    return next;
  });
}
export const acknowledgeAlert = (id: string, by: string, now = Date.now()) => transition(id, (a) => AlertMachine.acknowledge(a, by, now));
export const closeAlert = (id: string, by: string, now = Date.now()) => transition(id, (a) => AlertMachine.close(a, by, now));
export const escalateDue = (id: string, policy: AlertPolicy, now = Date.now()) => transition(id, (a) => AlertMachine.escalateIfDue(a, policy, now));
export async function alertDevice(alertId: string): Promise<string | null> { return (await db.queryOne<{ device_id: string }>('SELECT device_id FROM monitoring_alerts WHERE id = $1', [alertId]))?.device_id ?? null; }
export async function listAlerts(deviceId: string) { return (await db.query<any>('SELECT record_json FROM monitoring_alerts WHERE device_id = $1 ORDER BY opened_at DESC', [deviceId])).map((r) => JSON.parse(r.record_json)); }
