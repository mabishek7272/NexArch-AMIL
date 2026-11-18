import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/**
 * Physiological monitoring (gated). The page shows exactly what the server returns:
 * stale, delayed/backlog, untrusted-clock and no-data metrics have NO current value (last-known is shown with its measurement and receipt times), simulator devices carry the SIMULATION banner,
 * and alerts exist only for simulator devices. No value is interpreted here.
 */
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };

export default function Monitoring() {
  const [patients, setPatients] = useState<any[]>([]);
  const [patientId, setPatientId] = useState('');
  const [devices, setDevices] = useState<any[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [alerts, setAlerts] = useState<any>(null);
  const [gate, setGate] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [form, setForm] = useState({ kind: 'simulator', label: '', purpose: '' });
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  useEffect(() => {
    api.get<{ patients: any[] }>('/patients').then((d) => setPatients(d.patients)).catch(() => setPatients([]));
    api.get<any>('/clinical/monitoring/alert-policy').then(setGate).catch(() => setGate(null));
  }, []);
  const loadDevices = useCallback(async (pid: string) => { setDevices(pid ? (await api.get<any>(`/clinical/patients/${pid}/monitoring/devices`)).devices : []); }, []);
  const loadDevice = useCallback(async (id: string) => {
    setDeviceId(id);
    if (!id) { setStatus(null); setAlerts(null); return; }
    setStatus(await api.get(`/clinical/monitoring/devices/${id}/status`));
    setAlerts(await api.get(`/clinical/monitoring/devices/${id}/alerts`));
  }, []);
  useEffect(() => { void loadDevices(patientId).catch((e) => setMsg({ kind: 'err', text: String(e.message) })); setDeviceId(''); setStatus(null); }, [patientId, loadDevices]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Physiological monitoring</h1>
        <p className="text-sm" style={muted}>Gated: no real device adapter is validated. Values are shown as received and never interpreted; absence of data is not a normal reading.</p>
        {gate && <p className="text-xs mt-1" style={{ color: '#f59e0b' }} data-testid="alert-gate">Alerts: {gate.status} — {gate.reason}</p>}
      </header>
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <label className="text-xs font-semibold">Patient</label>
        <select className={`${box} w-full mt-1`} value={patientId} onChange={(e) => setPatientId(e.target.value)} aria-label="Patient">
          <option value="">Select…</option>{patients.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.uid} · {p.access_level}</option>)}
        </select>
        {patientId && (
          <form className="flex flex-wrap gap-2 items-end mt-3" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/clinical/patients/${patientId}/monitoring/devices`, form); await loadDevices(patientId); }, 'Device paired.'); }}>
            <select className={box} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Device kind">
              <option value="simulator">simulator (synthetic)</option><option value="fhir_gateway">FHIR gateway</option><option value="manual_entry">manual entry</option>
            </select>
            <input className={box} placeholder="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required aria-label="Device label" />
            <input className={box} placeholder="Purpose (required)" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} required aria-label="Purpose" />
            <button className={btn} disabled={busy}>Pair device</button>
          </form>
        )}
        {devices.length > 0 && (
          <ul className="mt-3 text-sm space-y-1" data-testid="device-list">
            {devices.map((d) => <li key={d.id}><button className="underline" onClick={() => void act(() => loadDevice(d.id))}>{d.label} · {d.kind}{d.simulation ? ' · SIMULATION' : ''}{d.unpaired_at ? ' · unpaired' : ''}</button></li>)}
          </ul>
        )}
      </GlassCard>

      {status && (
        <GlassCard padding="md">
          {status.banner && <p role="status" className="font-semibold mb-2" style={{ color: '#f59e0b' }} data-testid="sim-banner">{status.banner}</p>}
          <h2 className="font-semibold">{status.label} · device state: <span data-testid="device-state">{status.state}</span></h2>
          <p className="text-xs" style={muted}>{status.note}</p>
          <table className="w-full text-sm mt-3"><thead><tr className="text-left text-xs" style={muted}><th>Metric</th><th>State</th><th>Value</th><th>Last known (measured · received)</th><th>Flags</th></tr></thead>
            <tbody>{status.metrics.map((m: any) => (
              <tr key={m.metric} data-testid={`metric-${m.metric}`}>
                <td>{m.metric}</td><td data-testid={`state-${m.metric}`}>{m.state}</td>
                <td>{m.value === null ? <em style={muted}>— ({m.label})</em> : `${m.value} ${m.unit}`}</td>
                <td className="text-xs" style={muted}>{m.lastKnown ? `${m.lastKnown.value} ${m.unit} · measured ${m.lastKnown.sourceAgeSec === null ? 'at an untrusted time' : `${m.lastKnown.sourceAgeSec}s ago`} (${m.lastKnown.sourceTime}) · received ${m.lastKnown.receiptAgeSec}s ago (${m.lastKnown.receivedTime})` : '—'}</td>
                <td className="text-xs" style={{ color: '#f59e0b' }}>{m.flags.join(', ')}</td>
              </tr>))}</tbody></table>
          {Object.entries(status.gapsLast24h ?? {}).some(([, g]: any) => g.length) && <p className="text-xs mt-2" style={{ color: '#f59e0b' }}>Gaps in the last 24 h: {Object.entries(status.gapsLast24h).map(([m, g]: any) => `${m}: ${g.length}`).join(' · ')}</p>}
          <div className="flex flex-wrap gap-2 mt-3">
            {status.simulation && <button className={btn} disabled={busy || !status.paired} onClick={() => act(async () => { await api.post(`/clinical/monitoring/devices/${deviceId}/simulate`, { count: 20, seed: Date.now() % 100000 }); await loadDevice(deviceId); }, 'Synthetic stream ingested (simulation).')}>Simulate 20 synthetic readings</button>}
            <button className={btn} disabled={busy} onClick={() => act(() => loadDevice(deviceId))}>Refresh</button>
            <button className={btn} disabled={busy || !status.paired} onClick={() => act(async () => { await api.post(`/clinical/monitoring/devices/${deviceId}/unpair`, {}); await loadDevices(patientId); await loadDevice(deviceId); }, 'Device unpaired.')}>Unpair</button>
          </div>
          <h3 className="font-semibold mt-4">Alerts {status.simulation ? '(simulation only)' : '(gated — not available for real devices)'}</h3>
          {status.simulation && status.paired && <button className={`${btn} mt-1`} disabled={busy} onClick={() => act(async () => { await api.post(`/clinical/monitoring/devices/${deviceId}/alerts`, {}); await loadDevice(deviceId); }, 'Simulation alert opened — no real recipient notified.')}>Open simulation alert</button>}
          <ul className="text-sm mt-2 space-y-1" data-testid="alert-list">
            {(alerts?.alerts ?? []).map((a: any) => (
              <li key={a.id} className={box}>{a.state} · opened {new Date(a.openedAt).toLocaleTimeString()}{a.acknowledgedBy ? ` · ack by ${a.acknowledgedBy}` : ''}{a.escalatedTo ? ` · escalated to ${a.escalatedTo}` : ''}
                {(a.state === 'open' || a.state === 'escalated') && <button className={`${btn} ml-2`} disabled={busy} onClick={() => act(async () => { await api.post(`/clinical/monitoring/alerts/${a.id}/acknowledge`, {}); await loadDevice(deviceId); })}>Acknowledge</button>}
                {a.state === 'acknowledged' && <button className={`${btn} ml-2`} disabled={busy} onClick={() => act(async () => { await api.post(`/clinical/monitoring/alerts/${a.id}/close`, {}); await loadDevice(deviceId); })}>Close</button>}
              </li>))}
          </ul>
        </GlassCard>
      )}
    </div>
  );
}
