import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, Dialog, EmptyState, Field, Input, WorkspaceBar } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';
import { KeyOnceDialog } from './parts';

interface TenantRow { tenant_id: string; company_name: string; email: string; status: string; plan: string; created_at: number | string; active_keys: number }
const PLANS = ['free', 'pro', 'enterprise'];

export default function Tenants() {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [plan, setPlan] = useState('free');
  const [busy, setBusy] = useState(false); const [dlgError, setDlgError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ tenant: string; key: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows((await api.get<{ tenants: TenantRow[] }>('/v1/admin/tenants?limit=200')).tenants); } catch (e: any) { setRows([]); setError(String(e?.message ?? e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true); setDlgError(null);
    try {
      const t = await api.post<any>('/v1/admin/tenants', { company_name: name, email, plan });
      setOpen(false); setName(''); setEmail(''); setPlan('free'); setShown({ tenant: t.company_name, key: t.api_key }); await load();
    } catch (e: any) { setDlgError(String(e?.message ?? e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <WorkspaceBar badges={[{ label: 'TENANTS', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{rows?.length ?? '…'}</span> }]} />
      <div style={{ padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <div>
            <h1 style={{ margin: 0, font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Tenants</h1>
            <p style={{ margin: '6px 0 0', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)', maxWidth: 680 }}>Applications that send their AI output to Anukla for interpretation. Each has its own keys, skills, settings and audit trail.</p>
          </div>
          {isAdmin && <Button variant="primary" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setOpen(true)}>New tenant…</Button>}
        </div>
        {error && <div role="alert" style={{ marginBottom: 12, color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{error}</div>}
        {rows === null ? <p style={{ color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</p> : rows.length === 0 && !error ? (
          <EmptyState icon={<Building2 size={22} aria-hidden="true" />} title="No tenants yet" description="Create a tenant to give an application its own API key." />
        ) : rows.length > 0 && (
          <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
              <thead><tr>{['Tenant', 'Contact', 'Plan', 'Status', 'Active keys', 'Created'].map((h) => <th key={h} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '9px 12px' }}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.tenant_id} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                    <td style={{ padding: '9px 12px' }}><Link to={`/nexarch/anukla/tenants/${t.tenant_id}`} style={{ color: 'var(--nx-gold-bright)' }}>{t.company_name}</Link></td>
                    <td style={{ padding: '9px 12px', color: 'var(--nx-text-soft)' }}>{t.email}</td>
                    <td style={{ padding: '9px 12px' }} className="nx-mono">{t.plan}</td>
                    <td style={{ padding: '9px 12px' }}>{t.status === 'active' ? <Badge tone="green">ACTIVE</Badge> : <Badge tone="red">{t.status.toUpperCase()}</Badge>}</td>
                    <td style={{ padding: '9px 12px' }} className="nx-mono">{t.active_keys}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--nx-text-muted)' }}>{new Date(Number(t.created_at)).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={open} onClose={busy ? () => {} : () => setOpen(false)} icon={<Building2 size={15} aria-hidden="true" />} title="New tenant"
        footer={<><Button onClick={() => setOpen(false)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !email.trim()} onClick={create}>Create</Button></>}>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="COMPANY NAME"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="CONTACT EMAIL"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="PLAN"><select className="nx-input" value={plan} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
          {dlgError && <p role="alert" style={{ margin: 0, color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{dlgError}</p>}
        </div>
      </Dialog>
      <KeyOnceDialog shown={shown} onDone={() => setShown(null)} />
    </div>
  );
}
