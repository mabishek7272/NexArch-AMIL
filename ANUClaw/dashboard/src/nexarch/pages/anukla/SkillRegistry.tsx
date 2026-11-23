import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Badge, Button, WorkspaceBar } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';

interface SkillRow { skill_id: string; kind: string; title: string; version: string; risk_tier: string; requires_release: boolean; enabled: boolean; tenants_assigned: number; manifest: Record<string, any> }
interface Adapter { id: string; implemented?: boolean; available?: boolean }

export default function SkillRegistry() {
  const { user } = useCurrentUser(); const isAdmin = user?.role === 'admin';
  const [skills, setSkills] = useState<SkillRow[] | null>(null); const [adapters, setAdapters] = useState<Adapter[]>([]); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setSkills((await api.get<{ skills: SkillRow[] }>('/v1/admin/skills')).skills); setAdapters((await api.get<{ adapters: Adapter[] }>('/v1/admin/adapters')).adapters); } catch (e: any) { setErr(String(e?.message ?? e)); setSkills([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const toggle = async (s: SkillRow) => { setBusy(true); setErr(null); try { await api.patch(`/v1/admin/skills/${s.skill_id}`, { enabled: !s.enabled }); await load(); } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setBusy(false); } };
  return (
    <div>
      <WorkspaceBar badges={[{ label: 'SKILLS', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{skills?.length ?? '…'}</span> }]} />
      <div style={{ padding: '20px 22px' }}>
        <h1 style={{ margin: 0, font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Skill registry</h1>
        <p style={{ margin: '6px 0 14px', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)', maxWidth: 720 }}>Skills are what a tenant can ask Anukla to do. A skill must be switched on here and assigned to a tenant before that tenant can run it. Assign skills to a tenant from the tenant's page.</p>
        {err && <div role="alert" style={{ marginBottom: 12, color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{err}</div>}
        <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
            <thead><tr>{['Skill', 'Kind', 'Version', 'Risk', 'Tenants', 'Status', ''].map((h) => <th key={h || 'a'} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '9px 12px' }}>{h || 'Action'}</th>)}</tr></thead>
            <tbody>{(skills ?? []).map((s) => (
              <tr key={s.skill_id} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                <td style={{ padding: '9px 12px' }}><div style={{ color: 'var(--nx-text)' }}>{s.title}</div><div className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-muted)' }}>{s.skill_id}</div></td>
                <td style={{ padding: '9px 12px' }}>{s.kind}</td><td className="nx-mono" style={{ padding: '9px 12px' }}>{s.version}</td>
                <td style={{ padding: '9px 12px' }}>{s.risk_tier}{s.requires_release ? <> <Badge tone="amber">NEEDS RELEASE</Badge></> : null}</td>
                <td className="nx-mono" style={{ padding: '9px 12px' }}>{s.tenants_assigned}</td>
                <td style={{ padding: '9px 12px' }}>{s.enabled ? <Badge tone="green">ON</Badge> : <Badge tone="amber">OFF</Badge>}</td>
                <td style={{ padding: '9px 12px' }}>{isAdmin && <Button disabled={busy} aria-label={`${s.enabled ? 'Switch off' : 'Switch on'} ${s.title}`} onClick={() => toggle(s)}>{s.enabled ? 'Switch off' : 'Switch on'}</Button>}</td>
              </tr>))}</tbody>
          </table>
        </div>
        <h2 style={{ margin: '22px 0 8px', font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>Adapters</h2>
        <p style={{ margin: '0 0 8px', font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>An adapter turns one application's output into the common findings format. A skill whose adapter is not available cannot run.</p>
        <ul style={{ margin: 0, paddingLeft: 18, font: '400 12px/1.8 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{adapters.map((a) => <li key={a.id}><span className="nx-mono">{a.id}</span> {(a.implemented ?? a.available) ? <Badge tone="green">AVAILABLE</Badge> : <Badge>NOT AVAILABLE</Badge>}</li>)}</ul>
      </div>
    </div>
  );
}
