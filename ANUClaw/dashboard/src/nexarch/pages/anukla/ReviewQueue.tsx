import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, EmptyState, WorkspaceBar } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';

interface QueueItem {
  reportId: string; jobId: string; tenantId: string; tenantName: string | null; version: number;
  kind: 'awaiting_clinician' | 'follow_up'; reviewState: string | null;
  routeReasons: string[]; failedChecks: string[]; referralReasonCodes: string[]; readyAt: number | null;
}
type Kind = 'all' | 'awaiting' | 'follow_up';
const KINDS: Array<{ id: Kind; label: string }> = [{ id: 'all', label: 'All' }, { id: 'awaiting', label: 'Awaiting a clinician' }, { id: 'follow_up', label: 'Follow-ups' }];

/** Plain-language names for the machine codes the review queue carries. */
const REASON: Record<string, string> = {
  risk_indicator_flagged: 'Source flagged a risk indicator', high_risk_outside_reference: 'High-risk finding outside the source range', blocking_flag: 'Blocking data-quality flag',
  multiple_attention_on_high_risk: 'Several attention flags on high-risk findings', under_research_high: 'Experimental estimate flagged high',
  no_blocking_flags: 'Automatic review: blocking flag present', no_review_flag_from_narrative: 'Automatic review: explanation text could not be checked', narrative_guards_pass: 'Automatic review: wording check failed',
};
const label = (c: string) => REASON[c] ?? c.replace(/_/g, ' ');

export default function ReviewQueue() {
  const { user } = useCurrentUser();
  const [kind, setKind] = useState<Kind>('all');
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setItems((await api.get<{ items: QueueItem[] }>(`/anukla/review/queue?kind=${kind}&limit=100`)).items); } catch (e: any) { setItems([]); setError(String(e?.message ?? e)); }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  const canOpen = user?.role === 'clinician';
  const awaiting = items?.filter((i) => i.kind === 'awaiting_clinician').length ?? 0;

  return (
    <div>
      <WorkspaceBar badges={[
        { label: 'AWAITING A CLINICIAN', value: awaiting > 0 ? <Badge tone="amber">{awaiting}</Badge> : <Badge tone="green">NONE</Badge> },
        { label: 'IN VIEW', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{items?.length ?? '…'}</span> },
      ]} />
      <div style={{ padding: '20px 22px' }}>
        <h1 style={{ margin: 0, font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Clinical review</h1>
        <p style={{ margin: '6px 0 14px', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)', maxWidth: 720 }}>
          Reports that need a clinician before they should be relied on, and follow-ups for results delivered with a referral advisory. Reports are AI-reviewed by fixed rules only; nothing is signed until a named clinician signs it.
        </p>
        {!canOpen && <p role="note" style={{ margin: '0 0 12px', font: '400 12px Inter,sans-serif', color: 'var(--nx-amber)' }}>You can see the queue, but opening a report needs a provisioned clinician account.</p>}

        <div role="group" aria-label="Filter the queue" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {KINDS.map((k) => <Button key={k.id} variant={kind === k.id ? 'primary' : 'secondary'} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</Button>)}
        </div>

        {error && <div role="alert" style={{ marginBottom: 12, color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{error}</div>}
        {items === null ? <p style={{ color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</p> : items.length === 0 && !error ? (
          <EmptyState icon={<ClipboardCheck size={22} aria-hidden="true" />} title="Nothing waiting" description="No reports need review in this view." />
        ) : items.length > 0 && (
          <div className="nx-panel" tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
              <thead><tr>{['Tenant', 'Version', 'Status', 'Why it is here', 'Ready', ''].map((h) => <th key={h || 'open'} scope="col" style={{ textAlign: 'left', padding: '9px 12px' }} className="nx-label">{h || 'Open'}</th>)}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.reportId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                    <td style={{ padding: '9px 12px', color: 'var(--nx-text)' }}>{i.tenantName ?? i.tenantId}</td>
                    <td style={{ padding: '9px 12px' }} className="nx-mono">v{i.version}</td>
                    <td style={{ padding: '9px 12px' }}>{i.kind === 'awaiting_clinician' ? <Badge tone="amber">AWAITING CLINICIAN</Badge> : <Badge tone="blue">FOLLOW-UP</Badge>}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--nx-text-soft)' }}>{[...i.routeReasons, ...i.failedChecks, ...i.referralReasonCodes].map(label).filter((v, n, a) => a.indexOf(v) === n).join('; ') || '—'}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--nx-text-muted)' }}>{i.readyAt ? new Date(i.readyAt).toLocaleString() : '—'}</td>
                    <td style={{ padding: '9px 12px' }}>{canOpen ? <Link to={`/nexarch/anukla/review/${i.reportId}`} aria-label={`Open report for ${i.tenantName ?? i.tenantId}, version ${i.version}`} style={{ color: 'var(--nx-gold-bright)' }}>Open</Link> : <span style={{ color: 'var(--nx-text-dim)' }}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
