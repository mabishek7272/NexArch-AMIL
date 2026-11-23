import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, Drawer, Field, Input, WorkspaceBar, type BadgeTone } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';
import { Section } from './parts';

type Tab = 'overview' | 'jobs' | 'webhooks' | 'usage' | 'audit';
const msg = (e: any) => String(e?.message ?? e);
const when = (v: number | null | undefined) => (v ? new Date(Number(v)).toLocaleString() : '—');
const age = (s: number | null) => (s === null ? '—' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const TONE: Record<string, BadgeTone> = { completed: 'green', delivered: 'green', ready: 'green', ai_reviewed: 'blue', clinician_signed: 'green', queued: 'amber', pending: 'amber', processing: 'blue', sending: 'blue', failed: 'red', dead: 'red', rejected: 'red', awaiting_clinician: 'amber', erased: 'neutral', superseded: 'neutral' };
const St = ({ v }: { v: string | null | undefined }) => (v ? <Badge tone={TONE[v] ?? 'neutral'}>{v.replace(/_/g, ' ').toUpperCase()}</Badge> : <span>—</span>);
const TH = ({ children }: { children?: React.ReactNode }) => <th scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{children}</th>;
const TD = ({ children, mono }: { children?: React.ReactNode; mono?: boolean }) => <td className={mono ? 'nx-mono' : undefined} style={{ padding: '7px 10px', fontSize: 12 }}>{children}</td>;
const Err = ({ e }: { e: string | null }) => (e ? <p role="alert" style={{ margin: '0 0 10px', color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{e}</p> : null);

export default function Operations() {
  const { user } = useCurrentUser();
  const role = user?.role ?? ''; const canAct = role === 'admin' || role === 'operator'; const canAudit = ['admin', 'auditor', 'compliance'].includes(role);
  const [tab, setTab] = useState<Tab>('overview');
  const TABS: Array<{ id: Tab; label: string }> = [{ id: 'overview', label: 'Overview' }, { id: 'jobs', label: 'Processing history' }, { id: 'webhooks', label: 'Webhook log' }, { id: 'usage', label: 'Usage and spend' }, ...(canAudit ? [{ id: 'audit' as Tab, label: 'Audit check' }] : [])];
  return (
    <div>
      <WorkspaceBar badges={[{ label: 'SCOPE', value: <span style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>Processing only — no patient data is shown here</span> }]} />
      <div style={{ padding: '20px 22px' }}>
        <h1 style={{ margin: 0, font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Operations</h1>
        <p style={{ margin: '6px 0 14px', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)', maxWidth: 720 }}>How the interpretation pipeline is running: queue health, failures and retries, webhook deliveries, usage and model spend, and whether each tenant's audit trail is intact.</p>
        <div role="tablist" aria-label="Operations sections" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`nx-btn ${tab === t.id ? 'nx-btn-primary' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        {tab === 'overview' && <Overview />}
        {tab === 'jobs' && <Jobs canAct={canAct} />}
        {tab === 'webhooks' && <Webhooks canAct={canAct} />}
        {tab === 'usage' && <Usage />}
        {tab === 'audit' && canAudit && <Audit />}
      </div>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setError(null); try { setData(await api.get<T>(path)); } catch (e) { setError(msg(e)); } }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, load };
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: BadgeTone }) {
  return <div className="nx-panel" style={{ padding: '10px 14px', minWidth: 120 }}><div className="nx-label">{label}</div><div style={{ marginTop: 6, font: '600 20px Inter,sans-serif', color: tone === 'red' ? 'var(--nx-red)' : tone === 'amber' ? 'var(--nx-amber)' : 'var(--nx-text)' }}>{value}</div></div>;
}

function Overview() {
  const { data: o, error, load } = useLoad<any>('/anukla/ops/overview');
  return (
    <>
      <div style={{ marginBottom: 10 }}><Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={load}>Refresh</Button></div>
      <Err e={error} />
      {o && <>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <Stat label="JOBS QUEUED" value={o.jobs.queued ?? 0} tone={(o.jobs.queued ?? 0) > 0 ? 'amber' : undefined} />
          <Stat label="JOBS FAILED" value={o.jobs.failed ?? 0} tone={(o.jobs.failed ?? 0) > 0 ? 'red' : undefined} />
          <Stat label="OLDEST QUEUED" value={age(o.oldestQueuedJobAgeSeconds)} />
          <Stat label="FAILURE RATE (24 H)" value={o.failureRateLast24h === null ? '—' : `${Math.round(o.failureRateLast24h * 100)}%`} />
          <Stat label="REPORTS IN PROGRESS" value={(o.reports.queued ?? 0) + (o.reports.governed ?? 0) + (o.reports.narrated ?? 0) + (o.reports.generating ?? 0) + (o.reports.narrating ?? 0) + (o.reports.assembling ?? 0)} />
          <Stat label="AWAITING A CLINICIAN" value={o.reviewStates.awaiting_clinician ?? 0} tone={(o.reviewStates.awaiting_clinician ?? 0) > 0 ? 'amber' : undefined} />
          <Stat label="WEBHOOKS DEAD" value={o.webhookDeliveries.dead ?? 0} tone={(o.webhookDeliveries.dead ?? 0) > 0 ? 'red' : undefined} />
        </div>
        <Section title="Most common failures, last 7 days" note="Error codes are machine names; a job or report can be re-queued from the history tab.">
          {o.topErrorCodesLast7d.length === 0 ? <p style={{ margin: 0, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>No failures in the last 7 days.</p> : (
            <table style={{ width: '100%' }}><thead><tr><TH>Error code</TH><TH>Where</TH><TH>Count</TH></tr></thead><tbody>{o.topErrorCodesLast7d.map((e: any) => <tr key={`${e.source}${e.code}`} style={{ borderTop: '1px solid var(--nx-hairline)' }}><TD mono>{e.code}</TD><TD>{e.source}</TD><TD mono>{e.count}</TD></tr>)}</tbody></table>
          )}
        </Section>
      </>}
    </>
  );
}

function Jobs({ canAct }: { canAct: boolean }) {
  const { data: u } = useLoad<any>('/anukla/ops/usage');
  const [tenantId, setTenantId] = useState(''); const [status, setStatus] = useState(''); const [errorCode, setErrorCode] = useState('');
  const qs = new URLSearchParams({ limit: '50', ...(tenantId ? { tenantId } : {}), ...(status ? { status } : {}), ...(errorCode ? { errorCode } : {}) }).toString();
  const { data, error, load } = useLoad<any>(`/anukla/ops/jobs?${qs}`);
  const [open, setOpen] = useState<string | null>(null); const returnRef = useRef<HTMLElement | null>(null);
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <Field label="TENANT"><select className="nx-input" value={tenantId} onChange={(e) => setTenantId(e.target.value)}><option value="">All tenants</option>{(u?.tenants ?? []).map((t: any) => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}</select></Field>
        <Field label="STATUS"><select className="nx-input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{['queued', 'processing', 'completed', 'failed', 'erased'].map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
        <Field label="ERROR CODE"><Input value={errorCode} onChange={(e) => setErrorCode(e.target.value.trim())} placeholder="e.g. adapter_error" /></Field>
        <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={load}>Refresh</Button>
      </div>
      <Err e={error} />
      <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead><tr><TH>Job</TH><TH>Tenant</TH><TH>Skill</TH><TH>Status</TH><TH>Attempts</TH><TH>Error</TH><TH>Report</TH><TH>Created</TH><TH>Details</TH></tr></thead>
          <tbody>{(data?.items ?? []).map((j: any) => (
            <tr key={j.jobId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
              <TD mono>{j.jobId.slice(0, 12)}…</TD><TD>{j.tenantName}</TD><TD>{j.skillId}</TD><TD><St v={j.status} /></TD><TD mono>{j.attempts}/{j.maxAttempts}</TD><TD mono>{j.errorCode ?? '—'}</TD>
              <TD>{j.report ? <><St v={j.report.status} /> {j.report.reviewState && <St v={j.report.reviewState} />}</> : '—'}</TD><TD>{when(j.createdAt)}</TD>
              <TD><Button aria-label={`Details for job ${j.jobId}`} onClick={(e) => { returnRef.current = e.currentTarget; setOpen(j.jobId); }}>Details</Button></TD>
            </tr>))}</tbody>
        </table>
        {data && data.items.length === 0 && <p style={{ margin: 12, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>No jobs match.</p>}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} title="Job details" returnFocusRef={returnRef}>{open && <JobDetail id={open} canAct={canAct} onChanged={load} />}</Drawer>
    </>
  );
}

function JobDetail({ id, canAct, onChanged }: { id: string; canAct: boolean; onChanged: () => void }) {
  const { data: d, error, load } = useLoad<any>(`/anukla/ops/jobs/${id}`);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [note, setNote] = useState<string | null>(null);
  const act = async (path: string, done: string) => { setBusy(true); setErr(null); try { await api.post(path, {}); await load(); setNote(done); onChanged(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  if (error) return <p role="alert" style={{ color: 'var(--nx-red)' }}>{error}</p>;
  if (!d) return <p style={{ color: 'var(--nx-text-muted)' }}>Loading…</p>;
  const j = d.job;
  return (
    <div style={{ font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
      {note && <p role="status" style={{ color: 'var(--nx-green)' }}>{note}</p>}<Err e={err} />
      <p style={{ margin: '0 0 6px' }}><St v={j.status} /> {j.tenantName} · {j.skillId}</p>
      <dl className="nx-mono" style={{ margin: 0, fontSize: 10.5, wordBreak: 'break-all', color: 'var(--nx-text-muted)' }}><dt>Job</dt><dd style={{ margin: 0 }}>{j.jobId}</dd><dt>Adapter</dt><dd style={{ margin: 0 }}>{j.adapter ?? '—'}</dd><dt>Error</dt><dd style={{ margin: 0 }}>{j.errorCode ?? '—'}</dd><dt>Findings SHA-256</dt><dd style={{ margin: 0 }}>{j.findingsSha256 ?? '—'}</dd></dl>
      {canAct && j.status === 'failed' && <div style={{ margin: '10px 0' }}><Button variant="primary" loading={busy} onClick={() => act(`/anukla/ops/jobs/${id}/retry`, 'Job re-queued.')}>Retry this job</Button></div>}
      <h3 style={{ margin: '14px 0 4px', font: '600 12px Inter,sans-serif', color: 'var(--nx-text)' }}>Reports</h3>
      {d.reports.length === 0 ? <p>None.</p> : d.reports.map((r: any) => (
        <div key={r.reportId} style={{ marginBottom: 8 }}>v{r.version} <St v={r.status} /> {r.reviewState && <St v={r.reviewState} />} {r.errorCode && <span className="nx-mono">{r.errorCode}</span>}
          {canAct && r.status === 'failed' && <div style={{ marginTop: 4 }}><Button loading={busy} aria-label={`Retry report version ${r.version}`} onClick={() => act(`/anukla/ops/reports/${r.reportId}/retry`, 'Report re-queued at the stage that failed.')}>Retry report</Button></div>}</div>))}
      <h3 style={{ margin: '14px 0 4px', font: '600 12px Inter,sans-serif', color: 'var(--nx-text)' }}>Webhook deliveries</h3>
      {d.deliveries.length === 0 ? <p>None.</p> : d.deliveries.map((x: any) => <div key={x.deliveryId}><span className="nx-mono">{x.eventType.replace('interpretation.', '')}</span> <St v={x.status} /> {x.lastError && <span className="nx-mono">{x.lastError}</span>}</div>)}
      <h3 style={{ margin: '14px 0 4px', font: '600 12px Inter,sans-serif', color: 'var(--nx-text)' }}>Audit events about this job</h3>
      {d.events.length === 0 ? <p>None.</p> : <ul style={{ margin: 0, paddingLeft: 16 }}>{d.events.map((e: any) => <li key={e.seq}><span className="nx-mono">{e.eventType}</span> · {e.actor} · {when(e.timestamp)}</li>)}</ul>}
    </div>
  );
}

function Webhooks({ canAct }: { canAct: boolean }) {
  const [status, setStatus] = useState('');
  const { data: eps } = useLoad<any>('/anukla/ops/webhooks/endpoints');
  const { data, error, load } = useLoad<any>(`/anukla/ops/webhooks/deliveries?limit=50${status ? `&status=${status}` : ''}`);
  const [err, setErr] = useState<string | null>(null); const [note, setNote] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const again = async (id: string) => { setBusy(true); setErr(null); try { await api.post(`/anukla/ops/webhooks/deliveries/${id}/redeliver`, {}); setNote('Delivery queued again.'); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return (
    <>
      <Section title="Endpoints" note="Where each tenant's events are sent (scheme and host only). Secrets are never shown.">
        <table style={{ width: '100%' }}><thead><tr><TH>Tenant</TH><TH>Endpoint</TH><TH>State</TH></tr></thead><tbody>{(eps?.endpoints ?? []).map((e: any) => <tr key={e.tenantId} style={{ borderTop: '1px solid var(--nx-hairline)' }}><TD>{e.tenantName}</TD><TD mono>{e.endpoint}</TD><TD>{e.enabled ? <Badge tone="green">ON</Badge> : <Badge>OFF</Badge>}</TD></tr>)}</tbody></table>
        {eps && eps.endpoints.length === 0 && <p style={{ margin: 0, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>No tenant has registered an endpoint.</p>}
      </Section>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10 }}>
        <Field label="STATUS"><select className="nx-input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{['pending', 'sending', 'delivered', 'dead'].map((s) => <option key={s} value={s}>{s}</option>)}</select></Field>
        <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={load}>Refresh</Button>
      </div>
      {note && <p role="status" style={{ color: 'var(--nx-green)', font: '500 12.5px Inter,sans-serif' }}>{note}</p>}<Err e={error ?? err} />
      <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead><tr><TH>Event</TH><TH>Tenant</TH><TH>Status</TH><TH>Attempts</TH><TH>Last result</TH><TH>Created</TH><TH>Action</TH></tr></thead>
          <tbody>{(data?.items ?? []).map((d: any) => (
            <tr key={d.deliveryId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
              <TD mono>{d.eventType.replace('interpretation.', '')}</TD><TD>{d.tenantName}</TD><TD><St v={d.status} /></TD><TD mono>{d.attempts}</TD><TD mono>{d.lastError ?? (d.lastStatusCode ?? '—')}</TD><TD>{when(d.createdAt)}</TD>
              <TD>{canAct && d.status === 'dead' && <Button disabled={busy} aria-label={`Send again: delivery ${d.deliveryId}`} onClick={() => again(d.deliveryId)}>Send again</Button>}</TD>
            </tr>))}</tbody>
        </table>
        {data && data.items.length === 0 && <p style={{ margin: 12, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>No deliveries match.</p>}
      </div>
    </>
  );
}

function Usage() {
  const { data: u, error } = useLoad<any>('/anukla/ops/usage');
  const usd = (n: number) => `$${n.toFixed(4)}`;
  return (
    <>
      <Err e={error} />
      {u && <>
        <Section title="Model spend" note={u.modelSpend.note}>
          <p style={{ margin: 0, font: '400 12.5px/1.7 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
            {u.from} to {u.to}: {u.modelSpend.allScopes.calls} model calls, {usd(u.modelSpend.allScopes.knownUsd)} known cost{u.modelSpend.totalIsLowerBound ? ` (a lower bound: ${u.modelSpend.allScopes.callsWithUnknownCost} calls have unknown cost)` : ''}.
            {' '}Daily budget: {u.modelSpend.budget.perScopeDailyUsd === null ? 'no per-tenant limit set' : `${usd(u.modelSpend.budget.perScopeDailyUsd)} per tenant`}; {u.modelSpend.budget.globalDailyUsd === null ? 'no overall limit set' : `${usd(u.modelSpend.budget.globalDailyUsd)} overall`}.
          </p>
        </Section>
        <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%' }}>
            <thead><tr><TH>Tenant</TH><TH>Plan</TH><TH>Status</TH><TH>Requests this month</TH><TH>Jobs (completed / failed / queued)</TH><TH>Model calls</TH><TH>Known cost</TH></tr></thead>
            <tbody>{u.tenants.map((t: any) => (
              <tr key={t.tenantId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                <TD>{t.tenantName}</TD><TD mono>{t.plan}</TD><TD><St v={t.status === 'active' ? 'completed' : 'failed'} /></TD><TD mono>{t.requestsThisMonth}</TD>
                <TD mono>{t.jobs.completed ?? 0} / {t.jobs.failed ?? 0} / {t.jobs.queued ?? 0}</TD><TD mono>{t.modelCalls}{t.modelCallsWithUnknownCost ? ` (${t.modelCallsWithUnknownCost} unknown)` : ''}</TD><TD mono>{usd(t.modelSpendKnownUsd)}{t.modelCallsWithUnknownCost ? '+' : ''}</TD>
              </tr>))}</tbody>
          </table>
        </div>
      </>}
    </>
  );
}

function Audit() {
  const [data, setData] = useState<any>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const run = async () => { setBusy(true); setErr(null); try { setData(await api.get('/anukla/ops/audit/verify')); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return (
    <Section title="Audit chain check" note="Every change to a tenant is recorded in a hash-linked chain. This re-computes each chain from the stored entries; any altered, removed or reordered entry shows up as a break, with where it happened.">
      <Err e={err} />
      <Button variant="primary" loading={busy} onClick={run}>Verify all tenants</Button>
      {data && <>
        <p role="status" style={{ margin: '12px 0' }}>{data.allValid ? <Badge tone="green">ALL {data.tenantsChecked} CHAINS INTACT</Badge> : <Badge tone="red">BROKEN CHAIN FOUND</Badge>} <span className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-muted)' }}>checked {when(data.checkedAt)} · fingerprint {data.fingerprint.slice(0, 16)}</span></p>
        <table style={{ width: '100%' }}><thead><tr><TH>Tenant</TH><TH>Entries</TH><TH>Result</TH></tr></thead><tbody>{data.results.map((r: any) => <tr key={r.tenantId} style={{ borderTop: '1px solid var(--nx-hairline)' }}><TD>{r.tenantName}</TD><TD mono>{r.entries}</TD><TD>{r.valid ? <Badge tone="green">INTACT</Badge> : <Badge tone="red">BROKEN AT ENTRY {r.brokenAt}: {r.reason}</Badge>}</TD></tr>)}</tbody></table>
      </>}
    </Section>
  );
}
