import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Activity, MonitorCog } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Input, Field, WorkspaceBar, DestructiveConfirmDialog } from '../ui';

const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  active: 'green', connecting: 'amber', expired: 'amber', revoked: 'red', disconnected: 'neutral',
};

/**
 * AI Connections — screen 03. Wired to the real /research-studio/browser-profiles endpoint (same
 * data ConnectorStatus.tsx already shows in classic Research Studio) — profile/provider/status/lock
 * only, never a credential. The mockup's 4 fixed named providers (OCR engine, literature connector,
 * etc.) aren't a real backend concept — only user-created profiles are — so this page lists real
 * profiles instead of inventing fixed cards for providers that don't exist as distinct rows.
 */
export default function Connections() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<any>(null);

  const load = useCallback(async () => {
    const r = await api.get<any>('/research-studio/browser-profiles');
    setProfiles(r.profiles ?? []);
  }, []);
  useEffect(() => { void load().catch(() => {}); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const create = () => act(async () => { await api.post('/research-studio/browser-profiles', { provider: 'simulated', label }); setLabel(''); }, 'Profile created (metadata only — no credential stored).');
  const connect = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/connect`, {}); }, 'Connecting.');
  const confirm = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/confirm`, {}); }, 'Confirmed active.');
  const disconnect = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/disconnect`, {}); }, 'Disconnected; local session data cleared.');
  const revoke = (id: string) => act(async () => { await api.post(`/research-studio/browser-profiles/${id}/revoke`, {}); }, 'Revoked permanently.');

  const expiredCount = profiles.filter((p) => p.status === 'expired').length;

  return (
    <div>
      <WorkspaceBar
        badges={[
          { label: 'SESSIONS', value: expiredCount > 0 ? <Badge tone="amber">{expiredCount} EXPIRED</Badge> : <Badge tone="green">ALL HEALTHY</Badge> },
          { label: 'PROFILES', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{profiles.length}</span> },
        ]}
      />

      <div style={{ padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>AI Connections</h1>
            <p style={{ margin: '6px 0 0', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>
              Profiles hold provider, label, status and lock only. No credential material is stored or displayed anywhere in this product.
            </p>
          </div>
        </div>

        <div className="nx-panel" style={{ padding: '14px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, maxWidth: 280 }}>
            <Field label="NEW PROFILE LABEL">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Literature search" />
            </Field>
          </div>
          <Button variant="primary" icon={<Plus size={13} strokeWidth={2} />} disabled={busy || !label.trim()} onClick={create}>Add profile (simulated)</Button>
        </div>
        {msg && <p role="status" style={{ font: '400 12px Inter,sans-serif', color: msg.kind === 'ok' ? 'var(--nx-green)' : 'var(--nx-red)', marginBottom: 12 }}>{msg.text}</p>}

        <div className="nx-panel" style={{ overflow: 'hidden' }}>
          <div className="nx-panel-head">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><MonitorCog size={14} strokeWidth={1.7} color="var(--nx-gold)" />Browser profiles</span>
            <span className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-dim)' }}>METADATA ONLY · NO CREDENTIAL FIELDS EXIST</span>
          </div>
          <table className="nx-table">
            <thead><tr><th style={{ width: '24%' }}>Profile</th><th style={{ width: '13%' }}>Provider</th><th style={{ width: '16%' }}>Status</th><th style={{ width: '18%' }}>Session lock</th><th style={{ width: '29%', textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td style={{ color: 'var(--nx-text)' }}>{p.label}</td>
                  <td className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-muted)' }}>{p.provider}</td>
                  <td><Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status.toUpperCase()}</Badge></td>
                  <td className="nx-mono" style={{ fontSize: 10.5, color: p.locked_by_task_id ? 'var(--nx-amber)' : 'var(--nx-text-dim)' }}>{p.locked_by_task_id ? `task ${String(p.locked_by_task_id).slice(0, 8)}` : 'free'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {['disconnected', 'expired'].includes(p.status) && <Button disabled={busy} onClick={() => connect(p.id)} style={{ marginRight: 6 }}>Connect</Button>}
                    {p.status === 'connecting' && <Button disabled={busy} onClick={() => confirm(p.id)} style={{ marginRight: 6 }}>Confirm login complete</Button>}
                    {p.status === 'active' && <Button disabled={busy} onClick={() => disconnect(p.id)} style={{ marginRight: 6 }}>Disconnect</Button>}
                    {p.status !== 'revoked' && <Button variant="destructive" disabled={busy} onClick={() => setRevokeTarget(p)}>Revoke</Button>}
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--nx-text-muted)' }}>No profiles yet — create one above.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 13, padding: '13px 16px', border: '1px solid var(--nx-amber-border)', borderRadius: 7, background: '#120E09' }}>
          <Activity size={16} strokeWidth={1.7} color="var(--nx-amber)" style={{ flex: 'none', marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>Only the simulated provider works today</div>
            <p style={{ margin: '4px 0 0', font: '400 12px/1.5 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
              A real provider needs you to log in yourself in a visible browser window first — NexArch Lab never asks for, transmits, or stores that credential.
            </p>
            <details style={{ marginTop: 8 }}>
              <summary className="nx-mono" style={{ cursor: 'pointer', fontSize: 10.5, letterSpacing: '.08em', color: 'var(--nx-text-dim)' }}>
                TECHNICAL DETAILS
              </summary>
              <p className="nx-mono" style={{ margin: '6px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--nx-text-dim)' }}>
                See docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md for the full connector lifecycle and provider requirements.
              </p>
            </details>
          </div>
        </div>
      </div>

      <DestructiveConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => { if (revokeTarget) revoke(revokeTarget.id); setRevokeTarget(null); }}
        resourceLabel={revokeTarget?.label ?? ''}
        description={`Revoking "${revokeTarget?.label}" releases its session lock and prevents reconnection. This cannot be undone.`}
      />
    </div>
  );
}
