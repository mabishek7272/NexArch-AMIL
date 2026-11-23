import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, Dialog, Field, Input, WorkspaceBar } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';
import { KeyOnceDialog, Section } from './parts';

interface Tenant { tenant_id: string; company_name: string; email: string; status: string; plan: string; active_keys: number }
interface Key { key_id: string; key_prefix: string; label: string | null; created_at: number; expires_at: number | null; revoked_at: number | null; last_used_at: number | null }
type Tab = 'overview' | 'keys' | 'skills' | 'branding' | 'audit';
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'overview', label: 'Overview' }, { id: 'keys', label: 'API keys' }, { id: 'skills', label: 'Skills and narrative' }, { id: 'branding', label: 'Report branding' }, { id: 'audit', label: 'Audit trail' }];
const PLANS = ['free', 'pro', 'enterprise'];
const when = (v: number | null) => (v ? new Date(Number(v)).toLocaleString() : '—');
const msg = (e: any) => String(e?.message ?? e);

export default function TenantDetail() {
  const { id = '' } = useParams();
  const { user } = useCurrentUser(); const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState<Tab>('overview');
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<{ tenant: string; key: string } | null>(null);

  const loadTenant = useCallback(async () => {
    try { setTenant((await api.get<{ tenant: Tenant }>(`/v1/admin/tenants/${id}`)).tenant); } catch (e) { setError(msg(e)); }
  }, [id]);
  useEffect(() => { void loadTenant(); }, [loadTenant]);

  if (error) return <div style={{ padding: 22 }}><p role="alert" style={{ color: 'var(--nx-red)', font: '400 13px Inter,sans-serif' }}>{error}</p><Link to="/nexarch/anukla/tenants" style={{ color: 'var(--nx-gold-bright)' }}>Back to tenants</Link></div>;
  if (!tenant) return <div style={{ padding: 22, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</div>;
  const say = (t: string) => { setNotice(t); void loadTenant(); };

  return (
    <div>
      <WorkspaceBar badges={[
        { label: 'TENANT', value: <span style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{tenant.company_name}</span> },
        { label: 'STATUS', value: tenant.status === 'active' ? <Badge tone="green">ACTIVE</Badge> : <Badge tone="red">{tenant.status.toUpperCase()}</Badge> },
        { label: 'PLAN', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{tenant.plan}</span> },
      ]} />
      <div style={{ padding: '16px 22px' }}>
        <Link to="/nexarch/anukla/tenants" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}><ArrowLeft size={14} aria-hidden="true" /> Tenants</Link>
        <h1 style={{ margin: '8px 0 12px', font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>{tenant.company_name}</h1>
        {notice && <p role="status" style={{ margin: '0 0 12px', padding: '8px 12px', border: '1px solid var(--nx-green-border)', background: 'var(--nx-green-bg)', color: 'var(--nx-green)', borderRadius: 6, font: '500 12.5px Inter,sans-serif' }}>{notice}</p>}
        {!isAdmin && <p role="note" style={{ margin: '0 0 12px', font: '400 12px Inter,sans-serif', color: 'var(--nx-amber)' }}>Read-only: changes need an administrator account.</p>}
        <div role="tablist" aria-label="Tenant sections" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`nx-btn ${tab === t.id ? 'nx-btn-primary' : ''}`} onClick={() => { setTab(t.id); setNotice(null); }}>{t.label}</button>)}
        </div>
        {tab === 'overview' && <Overview tenant={tenant} isAdmin={isAdmin} say={say} />}
        {tab === 'keys' && <Keys tenant={tenant} isAdmin={isAdmin} say={say} showKey={setShown} />}
        {tab === 'skills' && <Skills tenant={tenant} isAdmin={isAdmin} say={say} />}
        {tab === 'branding' && <Branding tenant={tenant} isAdmin={isAdmin} say={say} />}
        {tab === 'audit' && <Audit tenant={tenant} />}
      </div>
      <KeyOnceDialog shown={shown} onDone={() => { setShown(null); void loadTenant(); }} />
    </div>
  );
}

function useAction(say: (t: string) => void) {
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, done: string) => { setBusy(true); setErr(null); try { await fn(); say(done); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return { busy, err, run, setErr };
}

function Overview({ tenant, isAdmin, say }: { tenant: Tenant; isAdmin: boolean; say: (t: string) => void }) {
  const a = useAction(say); const [plan, setPlan] = useState(tenant.plan); const [confirm, setConfirm] = useState(false);
  useEffect(() => setPlan(tenant.plan), [tenant.plan]);
  return (
    <>
      <Section title="Account"><dl style={{ margin: 0, font: '400 12.5px/1.8 Inter,sans-serif', color: 'var(--nx-text-soft)' }}><dt className="nx-label">CONTACT</dt><dd style={{ margin: 0 }}>{tenant.email}</dd><dt className="nx-label" style={{ marginTop: 6 }}>TENANT ID</dt><dd className="nx-mono" style={{ margin: 0, fontSize: 11 }}>{tenant.tenant_id}</dd></dl></Section>
      <Section title="Plan" note="The plan sets rate limits and the monthly quota. Only an administrator can change it.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Field label="PLAN"><select className="nx-input" value={plan} disabled={!isAdmin} onChange={(e) => setPlan(e.target.value)}>{PLANS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
          {isAdmin && <Button disabled={a.busy || plan === tenant.plan} onClick={() => a.run(() => api.put(`/v1/admin/tenants/${tenant.tenant_id}/plan`, { plan }), `Plan changed to ${plan}.`)}>Change plan</Button>}
        </div>
      </Section>
      <Section title="Access" note={tenant.status === 'active' ? 'Suspending stops every key of this tenant immediately.' : 'This tenant is suspended: none of its keys work.'}>
        {isAdmin && (tenant.status === 'active'
          ? <Button variant="destructive" onClick={() => setConfirm(true)}>Suspend tenant…</Button>
          : <Button variant="primary" disabled={a.busy} onClick={() => a.run(() => api.post(`/v1/admin/tenants/${tenant.tenant_id}/reactivate`, {}), 'Tenant reactivated.')}>Reactivate tenant</Button>)}
      </Section>
      {a.err && <p role="alert" style={{ color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{a.err}</p>}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Suspend this tenant?" footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="destructive" onClick={() => { setConfirm(false); void a.run(() => api.post(`/v1/admin/tenants/${tenant.tenant_id}/suspend`, {}), 'Tenant suspended.'); }}>Suspend</Button></>}>
        <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>All API keys of {tenant.company_name} stop working until it is reactivated. Queued work is kept.</p>
      </Dialog>
    </>
  );
}

function Keys({ tenant, isAdmin, say, showKey }: { tenant: Tenant; isAdmin: boolean; say: (t: string) => void; showKey: (k: { tenant: string; key: string }) => void }) {
  const [keys, setKeys] = useState<Key[] | null>(null); const [label, setLabel] = useState(''); const [revoke, setRevoke] = useState<Key | null>(null); const [reason, setReason] = useState('');
  const a = useAction((t) => { say(t); void load(); });
  const load = useCallback(async () => { try { setKeys((await api.get<{ keys: Key[] }>(`/v1/admin/tenants/${tenant.tenant_id}/keys`)).keys); } catch (e) { a.setErr(msg(e)); setKeys([]); } }, [tenant.tenant_id]);
  useEffect(() => { void load(); }, [load]);
  const state = (k: Key) => (k.revoked_at ? 'revoked' : k.expires_at && Number(k.expires_at) < Date.now() ? 'expired' : 'active');
  return (
    <Section title="API keys" note="Only the first characters of a key are kept for display. A new key is shown once.">
      {isAdmin && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
        <Field label="LABEL (OPTIONAL)"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Button variant="primary" disabled={a.busy} onClick={() => a.run(async () => { const r = await api.post<any>(`/v1/admin/tenants/${tenant.tenant_id}/keys`, label ? { label } : {}); setLabel(''); showKey({ tenant: tenant.company_name, key: r.api_key }); }, 'Key created.')}>Create key</Button>
      </div>}
      {a.err && <p role="alert" style={{ color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{a.err}</p>}
      <div tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
          <thead><tr>{['Key', 'Label', 'State', 'Created', 'Last used', ''].map((h) => <th key={h || 'actions'} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{h || 'Actions'}</th>)}</tr></thead>
          <tbody>{(keys ?? []).map((k) => (
            <tr key={k.key_id} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
              <td className="nx-mono" style={{ padding: '8px 10px' }}>{k.key_prefix}</td><td style={{ padding: '8px 10px' }}>{k.label ?? '—'}</td>
              <td style={{ padding: '8px 10px' }}><Badge tone={state(k) === 'active' ? 'green' : 'neutral'}>{state(k).toUpperCase()}</Badge></td>
              <td style={{ padding: '8px 10px', color: 'var(--nx-text-muted)' }}>{when(k.created_at)}</td><td style={{ padding: '8px 10px', color: 'var(--nx-text-muted)' }}>{when(k.last_used_at)}</td>
              <td style={{ padding: '8px 10px', display: 'flex', gap: 6 }}>{isAdmin && state(k) === 'active' && <>
                <Button disabled={a.busy} aria-label={`Rotate key ${k.key_prefix}`} onClick={() => a.run(async () => { const r = await api.post<any>(`/v1/admin/tenants/${tenant.tenant_id}/keys/${k.key_id}/rotate`, { grace_seconds: 3600 }); showKey({ tenant: tenant.company_name, key: r.api_key }); }, 'Key rotated; the old key works for one more hour.')}>Rotate</Button>
                <Button variant="destructive" aria-label={`Revoke key ${k.key_prefix}`} onClick={() => setRevoke(k)}>Revoke</Button></>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <Dialog open={!!revoke} onClose={() => { setRevoke(null); setReason(''); }} title="Revoke this key?" footer={<><Button onClick={() => { setRevoke(null); setReason(''); }}>Cancel</Button><Button variant="destructive" disabled={!reason.trim()} onClick={() => { const k = revoke!; setRevoke(null); void a.run(() => api.post(`/v1/admin/tenants/${tenant.tenant_id}/keys/${k.key_id}/revoke`, { reason }), 'Key revoked.'); setReason(''); }}>Revoke now</Button></>}>
        <p style={{ margin: '0 0 10px', font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>The key stops working immediately.</p>
        <Field label="REASON"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Dialog>
    </Section>
  );
}

interface SkillRow { skill_id: string; kind: string; title: string; version: string; enabled: boolean; manifest: Record<string, unknown> }
interface AssignRow { skill: SkillRow; assignment: { enabled: boolean; config: Record<string, any> } }

function Skills({ tenant, isAdmin, say }: { tenant: Tenant; isAdmin: boolean; say: (t: string) => void }) {
  const [all, setAll] = useState<SkillRow[]>([]); const [mine, setMine] = useState<AssignRow[]>([]); const [models, setModels] = useState<string[]>([]);
  const a = useAction((t) => { say(t); void load(); });
  const load = useCallback(async () => {
    try {
      setAll((await api.get<{ skills: SkillRow[] }>('/v1/admin/skills')).skills); setMine((await api.get<{ skills: AssignRow[] }>(`/v1/admin/tenants/${tenant.tenant_id}/skills`)).skills);
      setModels((await api.get<{ models: string[] }>('/v1/admin/narrative-models')).models);
    } catch (e) { a.setErr(msg(e)); }
  }, [tenant.tenant_id]);
  useEffect(() => { void load(); }, [load]);
  const byId = new Map(mine.map((m) => [m.skill.skill_id, m]));
  return (
    <Section title="Skills and explanation text" note="A tenant can only run skills assigned to it. For interpretation skills, the explanation text uses fixed templates unless a model is enabled here; every model answer is still checked by fixed rules, and any failure falls back to the template.">
      {a.err && <p role="alert" style={{ color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{a.err}</p>}
      <div style={{ display: 'grid', gap: 10 }}>
        {all.filter((s) => s.kind === 'interpretation').map((s) => <SkillCard key={s.skill_id} s={s} row={byId.get(s.skill_id)} tenantId={tenant.tenant_id} models={models} isAdmin={isAdmin} a={a} />)}
      </div>
      {all.some((s) => s.kind !== 'interpretation') && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', font: '500 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Other skills ({all.filter((s) => s.kind !== 'interpretation').length}): agent tools, not used for interpretation</summary>
          <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
            {all.filter((s) => s.kind !== 'interpretation').map((s) => <SkillCard key={s.skill_id} s={s} row={byId.get(s.skill_id)} tenantId={tenant.tenant_id} models={models} isAdmin={isAdmin} a={a} />)}
          </div>
        </details>
      )}
    </Section>
  );
}

function SkillCard({ s, row, tenantId, models, isAdmin, a }: { s: SkillRow; row?: AssignRow; tenantId: string; models: string[]; isAdmin: boolean; a: ReturnType<typeof useAction> }) {
  const hasPrompts = !!(s.manifest as any)?.prompts && Object.keys((s.manifest as any).prompts).length > 0;
  const cur = row?.assignment.config?.narrative as { enabled?: boolean; model?: string } | undefined;
  const [on, setOn] = useState(!!cur?.enabled); const [model, setModel] = useState(cur?.model ?? models[0] ?? '');
  useEffect(() => { setOn(!!cur?.enabled); setModel(cur?.model ?? models[0] ?? ''); }, [cur?.enabled, cur?.model, models.join('|')]);
  const base = `/v1/admin/tenants/${tenantId}/skills/${s.skill_id}`;
  return (
    <div className="nx-panel" data-skill={s.skill_id} style={{ padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div><strong style={{ font: '600 12.5px Inter,sans-serif', color: 'var(--nx-text)' }}>{s.title}</strong> <span className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-muted)' }}>{s.skill_id} · v{s.version} · {s.kind}</span>
          {!s.enabled && <> <Badge tone="amber">DISABLED GLOBALLY</Badge></>}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {row ? <Badge tone={row.assignment.enabled ? 'green' : 'neutral'}>{row.assignment.enabled ? 'ASSIGNED' : 'ASSIGNED, OFF'}</Badge> : <Badge>NOT ASSIGNED</Badge>}
          {isAdmin && (row
            ? <><Button disabled={a.busy} onClick={() => a.run(() => api.put(base, { enabled: !row.assignment.enabled }), row.assignment.enabled ? 'Skill switched off for this tenant.' : 'Skill switched on for this tenant.')}>{row.assignment.enabled ? 'Switch off' : 'Switch on'}</Button>
              <Button variant="destructive" aria-label={`Remove ${s.title}`} disabled={a.busy} onClick={() => a.run(() => api.delete(base), 'Skill removed from this tenant.')}>Remove</Button></>
            : <Button variant="primary" aria-label={`Assign ${s.title}`} disabled={a.busy || !s.enabled} onClick={() => a.run(() => api.put(base, {}), 'Skill assigned.')}>Assign</Button>)}
        </div>
      </div>
      {row && hasPrompts && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--nx-hairline)', display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', font: '400 12px Inter,sans-serif', color: 'var(--nx-text)' }}>
            <input type="checkbox" disabled={!isAdmin} checked={on} onChange={(e) => setOn(e.target.checked)} /> Use a language model for the explanation text</label>
          <Field label="MODEL"><select className="nx-input" disabled={!isAdmin || !on} value={model} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
          {isAdmin && <Button disabled={a.busy || (on === !!cur?.enabled && (!on || model === cur?.model))} onClick={() => a.run(() => api.put(base, { config: { ...(row.assignment.config ?? {}), narrative: on ? { enabled: true, model } : { enabled: false } } }), on ? 'Explanation text will use the selected model.' : 'Explanation text uses fixed templates.')}>Save</Button>}
          <span style={{ font: '400 11px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{cur?.enabled ? `Currently: ${cur.model}` : 'Currently: fixed templates (no model)'}</span>
        </div>
      )}
    </div>
  );
}

function Branding({ tenant, isAdmin, say }: { tenant: Tenant; isAdmin: boolean; say: (t: string) => void }) {
  const [view, setView] = useState<{ productName: string | null; hasLogo: boolean; logoMime: string | null } | null>(null);
  const [name, setName] = useState(''); const [logo, setLogo] = useState<string | null>(null); const [logoName, setLogoName] = useState('');
  const a = useAction((t) => { say(t); void load(); });
  const load = useCallback(async () => { try { const r = await api.get<any>(`/v1/admin/tenants/${tenant.tenant_id}/branding`); setView(r.branding); setName(r.branding.productName ?? ''); } catch (e) { a.setErr(msg(e)); } }, [tenant.tenant_id]);
  useEffect(() => { void load(); }, [load]);
  const pick = (f: File | undefined) => {
    if (!f) return; setLogoName(f.name);
    const rd = new FileReader(); rd.onload = () => setLogo(String(rd.result).split(',')[1] ?? null); rd.readAsDataURL(f);
  };
  return (
    <Section title="Report branding" note="A tenant's reports carry its product name and logo and nothing else. The governance statement, the review status banner and the referral advisory are fixed and cannot be changed here.">
      {a.err && <p role="alert" style={{ color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{a.err}</p>}
      <p style={{ margin: '0 0 10px', font: '400 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{view ? <>Current: {view.productName ?? 'no product name'}; {view.hasLogo ? `logo (${view.logoMime})` : 'no logo'}.</> : 'Loading…'}</p>
      <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
        <Field label="PRODUCT NAME (LETTERS, DIGITS, SPACES AND . , & ' ( ) -)"><Input value={name} disabled={!isAdmin || !view} maxLength={60} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="LOGO (PNG OR JPEG, UP TO 256 KB)"><input type="file" className="nx-input" accept="image/png,image/jpeg" disabled={!isAdmin || !view} onChange={(e) => pick(e.target.files?.[0])} /></Field>
        {logoName && <span style={{ font: '400 11px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>Selected: {logoName}</span>}
        {isAdmin && <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={a.busy || (!name.trim() && !logo)} onClick={() => a.run(async () => { await api.put(`/v1/admin/tenants/${tenant.tenant_id}/branding`, { ...(name.trim() ? { productName: name.trim() } : {}), ...(logo ? { logoBase64: logo } : {}) }); setLogo(null); setLogoName(''); }, 'Branding saved.')}>Save branding</Button>
          <Button variant="destructive" disabled={a.busy || (!view?.productName && !view?.hasLogo)} onClick={() => a.run(() => api.delete(`/v1/admin/tenants/${tenant.tenant_id}/branding`), 'Branding removed.')}>Remove branding</Button>
        </div>}
      </div>
    </Section>
  );
}

function Audit({ tenant }: { tenant: Tenant }) {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get<any>(`/v1/admin/tenants/${tenant.tenant_id}/audit`).then(setData).catch((e) => setErr(msg(e))); }, [tenant.tenant_id]);
  if (err) return <p role="alert" style={{ color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{err}</p>;
  if (!data) return <p style={{ color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</p>;
  const ok = data.chain?.valid === true;
  const entries = [...data.entries].reverse().slice(0, 200);
  return (
    <Section title="Audit trail" note="Every change is recorded in a hash-linked chain; altering or removing an entry breaks every link after it.">
      <p role="status" style={{ margin: '0 0 10px' }}>{ok ? <Badge tone="green">CHAIN VERIFIED · {data.entry_count} ENTRIES</Badge> : <Badge tone="red">CHAIN BROKEN AT ENTRY {data.chain?.brokenAt}: {data.chain?.reason}</Badge>}</p>
      <div tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
          <thead><tr>{['#', 'When', 'Event', 'By'].map((h) => <th key={h} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{h}</th>)}</tr></thead>
          <tbody>{entries.map((e: any) => <tr key={e.seq} style={{ borderTop: '1px solid var(--nx-hairline)' }}><td className="nx-mono" style={{ padding: '7px 10px' }}>{e.seq}</td><td style={{ padding: '7px 10px', color: 'var(--nx-text-muted)' }}>{new Date(Number(e.timestamp)).toLocaleString()}</td><td className="nx-mono" style={{ padding: '7px 10px' }}>{e.event_type}</td><td style={{ padding: '7px 10px', color: 'var(--nx-text-soft)' }}>{e.actor}</td></tr>)}</tbody>
        </table>
      </div>
    </Section>
  );
}
