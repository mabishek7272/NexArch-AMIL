import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { GlassCard } from '../GlassCard';

/**
 * Browser connector status (M3). Every profile shown here is METADATA only — provider, label, status, lock holder.
 * No credential, cookie or token is ever stored or displayed. The only working provider is "simulated" (an offline
 * test fixture); a real provider stays disabled until one is chosen and its automation terms are confirmed — see
 * docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md. This panel never implies a live connection to a real AI provider.
 */
const box = 'rounded-lg border px-2 py-1.5 text-xs bg-transparent';
const btn = 'rounded-md px-2.5 py-1 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const STATUS_TONE: Record<string, string> = { disconnected: '#8a94a6', connecting: '#f59e0b', active: '#10b981', expired: '#f59e0b', revoked: '#f43f5e' };

export function ConnectorStatus() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { const r = await api.get<any>('/research-studio/browser-profiles'); setProfiles(r.profiles ?? []); }, []);
  useEffect(() => { void load().catch(() => {}); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const create = () => act(async () => { await api.post('/research-studio/browser-profiles', { provider: 'simulated', label }); setLabel(''); }, 'Profile created (metadata only — no credential stored).');
  const connect = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/connect`, {}); }, 'Connecting — for the simulated provider, confirm immediately; a real provider would need manual login first.');
  const confirm = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/confirm`, {}); }, 'Confirmed active.');
  const disconnect = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/disconnect`, {}); }, 'Disconnected; local session data cleared.');
  const revoke = (id: string) => act(async () => { if (window.confirm('Revoke permanently? This cannot be undone.')) await api.post(`/research-studio/browser-profiles/${id}/revoke`, {}); }, 'Revoked permanently.');

  return (
    <GlassCard padding="md">
      <h3 className="font-semibold text-sm">Browser connector status</h3>
      <p className="text-xs" style={muted} data-testid="connector-status-notice">
        Only the offline "simulated" provider works today — a local Playwright test fixture, never a real website. No
        real AI-provider automation is connected; that needs a provider and its automation terms to be chosen first.
        Nothing here stores a password, cookie, or token.
      </p>
      <div className="flex gap-2 mt-2">
        <input className={box} placeholder="Profile label" aria-label="new-profile-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className={btn} disabled={busy || !label.trim()} onClick={create}>Create simulated profile</button>
      </div>
      {msg && <p role="status" className="text-xs mt-1" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}
      <table className="text-xs w-full mt-2" data-testid="connector-profiles"><thead><tr className="text-left"><th>Label</th><th>Provider</th><th>Status</th><th>Lock</th><th>Actions</th></tr></thead>
        <tbody>{profiles.map((p) => (
          <tr key={p.id}>
            <td>{p.label}</td><td>{p.provider}</td>
            <td><span style={{ color: STATUS_TONE[p.status] }}>{p.status}</span></td>
            <td style={muted}>{p.locked_by_task_id ? `locked (${String(p.locked_by_task_id).slice(0, 8)})` : 'free'}</td>
            <td>
              {['disconnected', 'expired'].includes(p.status) && <button className={btn} disabled={busy} onClick={() => connect(p.id)}>Connect</button>}
              {p.status === 'connecting' && <button className={btn} disabled={busy} onClick={() => confirm(p.id)}>Confirm login complete</button>}
              {p.status === 'active' && <button className={btn} disabled={busy} onClick={() => disconnect(p.id)}>Disconnect</button>}
              {p.status !== 'revoked' && <button className={btn} disabled={busy} onClick={() => revoke(p.id)}>Revoke</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </GlassCard>
  );
}
