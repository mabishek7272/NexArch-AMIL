import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { useCurrentUser } from '../../useCurrentUser';

interface Ops { jobs: Record<string, number>; failureRateLast24h: number | null; reviewStates: Record<string, number>; webhookDeliveries: Record<string, number>; oldestQueuedJobAgeSeconds: number | null }

/**
 * Interpretation tiles for the landing page. Each tile is only fetched for a role that may see it, shows a real number from the
 * same endpoint as its page, and links there. If a figure cannot be loaded the tile says so instead of showing a number.
 */
export function InterpretationTiles() {
  const { user } = useCurrentUser();
  const role = user?.role;
  const ops = role === 'admin' || role === 'operator' || role === 'auditor' || role === 'compliance';
  const review = role === 'admin' || role === 'clinician';
  const [o, setO] = useState<Ops | null | 'error'>(null);
  const [q, setQ] = useState<number | null | 'error'>(null);
  useEffect(() => {
    if (ops) api.get<Ops>('/anukla/ops/overview').then(setO).catch(() => setO('error'));
    if (review) api.get<{ items: unknown[] }>('/anukla/review/queue?kind=awaiting&limit=100').then((r) => setQ(r.items.length)).catch(() => setQ('error'));
  }, [ops, review]);
  if (!ops && !review) return null;

  const Tile = ({ label, value, to, warn, sr }: { label: string; value: React.ReactNode; to: string; warn?: boolean; sr: string }) => (
    <Link to={to} aria-label={`${sr}: ${typeof value === 'string' || typeof value === 'number' ? value : 'unavailable'}`} style={{ textDecoration: 'none', minWidth: 150, flex: '1 1 150px' }}>
      <div className="nx-panel" style={{ padding: '10px 14px', borderColor: warn ? 'var(--nx-amber-border)' : undefined }}>
        <div className="nx-label" aria-hidden="true">{label}</div>
        <div aria-hidden="true" style={{ marginTop: 6, font: '600 20px Inter,sans-serif', color: warn ? 'var(--nx-amber)' : 'var(--nx-text)' }}>{value}</div>
      </div>
    </Link>
  );
  const n = (v: number | undefined) => v ?? 0;
  return (
    <section aria-label="Interpretation" style={{ padding: '14px 22px 0' }}>
      <h2 style={{ margin: '0 0 8px', font: '600 12.5px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Interpretation</h2>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {review && <Tile label="AWAITING A CLINICIAN" sr="Reports awaiting a clinician" to="/nexarch/anukla/review" warn={typeof q === 'number' && q > 0} value={q === null ? '…' : q === 'error' ? '—' : q} />}
        {ops && o !== 'error' && o !== null && <>
          <Tile label="JOBS QUEUED" sr="Jobs queued" to="/nexarch/anukla/operations" warn={n(o.jobs.queued) > 0} value={n(o.jobs.queued)} />
          <Tile label="JOBS FAILED" sr="Jobs failed" to="/nexarch/anukla/operations" warn={n(o.jobs.failed) > 0} value={n(o.jobs.failed)} />
          <Tile label="FAILURE RATE (24 H)" sr="Failure rate over 24 hours" to="/nexarch/anukla/operations" value={o.failureRateLast24h === null ? '—' : `${Math.round(o.failureRateLast24h * 100)}%`} />
          <Tile label="WEBHOOKS DEAD" sr="Webhook deliveries dead" to="/nexarch/anukla/operations" warn={n(o.webhookDeliveries.dead) > 0} value={n(o.webhookDeliveries.dead)} />
        </>}
        {ops && o === 'error' && <p role="status" style={{ margin: 0, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>Operations figures are not available right now.</p>}
      </div>
    </section>
  );
}
