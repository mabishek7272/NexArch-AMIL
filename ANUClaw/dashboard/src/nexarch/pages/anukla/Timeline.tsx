import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, Field, WorkspaceBar, type BadgeTone } from '../../ui';
import { Section } from './parts';

interface Item { jobId: string; skillId: string; status: string; capturedAt: string; self: boolean; report: { reportId: string; version: number; reviewState: string | null } | null }
interface Point { jobId: string; capturedAt: string; value: number | string | boolean | null; unit?: string; uncertainty?: number; status: string }
interface Step { fromJobId: string; toJobId: string; intervalSeconds: number; status: string; reason?: string; delta?: number; combinedUncertainty?: number; laterIs?: 'higher' | 'lower'; shortInterval?: boolean }
interface Timeline { skillId: string; count: number; truncated: boolean; items: Item[]; findingKeys: Array<{ key: string; label: string; unit: string | null }>; series?: { findingKey: string; points: Point[]; steps: Step[] } }
interface Comparison {
  earlier: { jobId: string; capturedAt: string }; later: { jobId: string; capturedAt: string }; intervalSeconds: number; statement: string; comparisonSha256: string;
  summary: Record<string, number>; flags: Array<{ type: string; severity: string; detail: string; findingKeys?: string[] }>;
  comparisons: Array<{ findingKey: string; label: string; unit?: string; status: string; reason?: string; earlier?: { value: unknown; uncertainty?: number }; later?: { value: unknown; uncertainty?: number }; delta?: number; combinedUncertainty?: number; laterIs?: string; identical?: boolean; shortInterval?: boolean }>;
}
const msg = (e: any) => String(e?.message ?? e);
const REASON: Record<string, string> = {
  missing_in_earlier: 'Not reported in the earlier scan', missing_in_later: 'Not reported in the later scan', value_missing: 'A value is missing', excluded: 'Excluded by the source', non_numeric: 'Not a number',
  unit_changed: 'The unit changed', no_uncertainty: 'The source gave no uncertainty for both values', source_model_changed: 'The source model, version or calibration changed',
};
const STATUS: Record<string, { tone: BadgeTone; text: string }> = { within_uncertainty: { tone: 'neutral', text: 'WITHIN UNCERTAINTY' }, beyond_uncertainty: { tone: 'amber', text: 'BEYOND UNCERTAINTY' }, not_comparable: { tone: 'disabled', text: 'NOT COMPARABLE' } };
const dur = (s: number) => (s < 120 ? `${s} seconds` : s < 7200 ? `${Math.round(s / 60)} minutes` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`);
const fmt = (v: unknown, unit?: string | null) => (v === null || v === undefined ? '—' : `${v}${unit ? ` ${unit}` : ''}`);

export default function TimelinePage() {
  const { jobId = '' } = useParams();
  const [key, setKey] = useState('');
  const [tl, setTl] = useState<Timeline | null>(null); const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(''); const [cmp, setCmp] = useState<Comparison | null>(null); const [cmpErr, setCmpErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setTl(await api.get<Timeline>(`/anukla/longitudinal/scans/${jobId}${key ? `?findingKey=${encodeURIComponent(key)}` : ''}`)); } catch (e) { setTl(null); setError(msg(e)); }
  }, [jobId, key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setCmp(null); setCmpErr(null); }, [other]);

  const doCompare = async () => {
    setBusy(true); setCmpErr(null); setCmp(null);
    try { setCmp(await api.get<Comparison>(`/anukla/longitudinal/compare?a=${jobId}&b=${other}`)); } catch (e) { setCmpErr(msg(e)); } finally { setBusy(false); }
  };

  const others = useMemo(() => (tl?.items ?? []).filter((i) => !i.self && i.status === 'completed'), [tl]);
  const label = (id: string) => { const i = tl?.items.find((x) => x.jobId === id); return i ? new Date(i.capturedAt).toLocaleString() : id; };
  if (error) return <div style={{ padding: 22 }}><p role="alert" style={{ color: 'var(--nx-red)', font: '400 13px Inter,sans-serif' }}>{error}</p></div>;
  if (!tl) return <div style={{ padding: 22, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</div>;

  return (
    <div>
      <WorkspaceBar badges={[{ label: 'SCANS OF THIS SUBJECT', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{tl.count}{tl.truncated ? ' (most recent)' : ''}</span> }, { label: 'SKILL', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{tl.skillId}</span> }]} />
      <div style={{ padding: '16px 22px' }}>
        <Link to="/nexarch/anukla/review" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}><ArrowLeft size={14} aria-hidden="true" /> Review queue</Link>
        <h1 style={{ margin: '8px 0 4px', font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Scans over time</h1>
        <p style={{ margin: '0 0 14px', font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)', maxWidth: 720 }}>Differences are described neutrally and only with the uncertainty the source reported. Nothing here says a change is an improvement or a deterioration, and nothing is a diagnosis.</p>

        <Section title="Scans">
          <div tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
              <thead><tr>{['Captured', 'Status', 'Report', ''].map((h) => <th key={h || 'x'} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{h || 'Open'}</th>)}</tr></thead>
              <tbody>{tl.items.map((i) => (
                <tr key={i.jobId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                  <td style={{ padding: '7px 10px' }}>{new Date(i.capturedAt).toLocaleString()} {i.self && <Badge tone="gold">THIS SCAN</Badge>}</td>
                  <td style={{ padding: '7px 10px' }}>{i.status}</td>
                  <td style={{ padding: '7px 10px' }}>{i.report ? `v${i.report.version}${i.report.reviewState ? `, ${i.report.reviewState.replace(/_/g, ' ')}` : ''}` : '—'}</td>
                  <td style={{ padding: '7px 10px' }}>{i.report && <Link to={`/nexarch/anukla/review/${i.report.reportId}`} aria-label={`Open report for the scan of ${new Date(i.capturedAt).toLocaleString()}`} style={{ color: 'var(--nx-gold-bright)' }}>Open report</Link>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Section>

        <Section title="One finding over time" note="Choose a finding to see its values across these scans, with the neutral step between each pair.">
          <div style={{ maxWidth: 420 }}>
            <Field label="FINDING"><select className="nx-input" value={key} onChange={(e) => setKey(e.target.value)}><option value="">Choose a finding…</option>{tl.findingKeys.map((f) => <option key={f.key} value={f.key}>{f.label}{f.unit ? ` (${f.unit})` : ''}</option>)}</select></Field>
          </div>
          {tl.series && <SeriesView series={tl.series} label={tl.findingKeys.find((f) => f.key === tl.series!.findingKey)?.label ?? tl.series.findingKey} when={label} />}
        </Section>

        <Section title="Compare two scans" note="Compare this scan with another scan of the same subject.">
          {others.length === 0 ? <p style={{ margin: 0, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>There is no other completed scan of this subject to compare with.</p> : (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="COMPARE THIS SCAN WITH"><select className="nx-input" value={other} onChange={(e) => setOther(e.target.value)}><option value="">Choose a scan…</option>{others.map((i) => <option key={i.jobId} value={i.jobId}>{new Date(i.capturedAt).toLocaleString()}</option>)}</select></Field>
              <Button variant="primary" disabled={!other} loading={busy} onClick={doCompare}>Compare</Button>
            </div>
          )}
          {cmpErr && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{cmpErr}</p>}
          {cmp && <ComparisonView c={cmp} />}
        </Section>
      </div>
    </div>
  );
}

function SeriesView({ series, label, when }: { series: NonNullable<Timeline['series']>; label: string; when: (id: string) => string }) {
  const nums = series.points.map((p, i) => ({ i, v: typeof p.value === 'number' ? p.value : null, u: p.uncertainty ?? 0 }));
  const have = nums.filter((n) => n.v !== null) as Array<{ i: number; v: number; u: number }>;
  const W = 520, H = 150, pad = 28;
  const lo = have.length ? Math.min(...have.map((n) => n.v - n.u)) : 0, hi = have.length ? Math.max(...have.map((n) => n.v + n.u)) : 1;
  const x = (i: number) => (series.points.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (series.points.length - 1));
  const y = (v: number) => (hi === lo ? H / 2 : H - pad - ((v - lo) * (H - 2 * pad)) / (hi - lo));
  return (
    <div style={{ marginTop: 12 }}>
      {have.length >= 1 && (
        <svg role="img" aria-label={`${label} across ${series.points.length} scans; the table below has the same values`} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, background: 'var(--nx-panel-alt)', borderRadius: 6 }}>
          {have.map((n) => <line key={`u${n.i}`} x1={x(n.i)} x2={x(n.i)} y1={y(n.v - n.u)} y2={y(n.v + n.u)} stroke="var(--nx-text-dim)" strokeWidth="2" />)}
          <polyline fill="none" stroke="var(--nx-gold)" strokeWidth="1.5" points={have.map((n) => `${x(n.i)},${y(n.v)}`).join(' ')} />
          {have.map((n) => <circle key={n.i} cx={x(n.i)} cy={y(n.v)} r="3.5" fill="var(--nx-gold-bright)" />)}
        </svg>
      )}
      <div tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto', marginTop: 10 }}>
        <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
          <caption style={{ position: 'absolute', left: -9999 }}>{label} across scans</caption>
          <thead><tr>{['Captured', 'Value', 'Uncertainty (±)', 'Step from the previous scan'].map((h) => <th key={h} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{h}</th>)}</tr></thead>
          <tbody>{series.points.map((p, i) => {
            const st = i > 0 ? series.steps[i - 1] : null;
            return (
              <tr key={p.jobId} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                <td style={{ padding: '7px 10px' }}>{when(p.jobId)}</td><td className="nx-mono" style={{ padding: '7px 10px' }}>{p.status === 'absent' ? 'not reported' : fmt(p.value, p.unit)}</td><td className="nx-mono" style={{ padding: '7px 10px' }}>{p.uncertainty ?? '—'}</td>
                <td style={{ padding: '7px 10px' }}>{st ? <StepText s={st} /> : '—'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

function StepText({ s }: { s: Step }) {
  const m = STATUS[s.status];
  return (
    <span><Badge tone={m.tone}>{m.text}</Badge> {s.status === 'not_comparable' && s.reason ? REASON[s.reason] ?? s.reason : s.status === 'beyond_uncertainty' ? `the later value is ${s.laterIs}${s.shortInterval ? ' (scans very close together: check this discrepancy)' : ''}` : ''}</span>
  );
}

function ComparisonView({ c }: { c: Comparison }) {
  return (
    <div style={{ marginTop: 14 }}>
      <p style={{ margin: '0 0 8px', font: '400 12.5px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Earlier scan {new Date(c.earlier.capturedAt).toLocaleString()}; later scan {new Date(c.later.capturedAt).toLocaleString()}; {dur(c.intervalSeconds)} apart. {c.summary.beyond_uncertainty} beyond uncertainty, {c.summary.within_uncertainty} within, {c.summary.not_comparable} not comparable.</p>
      {c.flags.map((f, n) => <p key={n} role="note" style={{ margin: '0 0 8px', padding: '8px 10px', border: '1px solid var(--nx-amber-border)', background: 'var(--nx-amber-bg)', color: 'var(--nx-amber)', borderRadius: 6, font: '400 12px/1.5 Inter,sans-serif' }}>{f.detail}</p>)}
      <div tabIndex={0} role="region" aria-label="Table (scrolls sideways on small screens)" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', font: '400 12px Inter,sans-serif' }}>
          <thead><tr>{['Finding', 'Earlier', 'Later', 'Difference', 'Result'].map((h) => <th key={h} scope="col" className="nx-label" style={{ textAlign: 'left', padding: '8px 10px' }}>{h}</th>)}</tr></thead>
          <tbody>{c.comparisons.map((r) => {
            const m = STATUS[r.status];
            return (
              <tr key={r.findingKey} style={{ borderTop: '1px solid var(--nx-hairline)' }}>
                <td style={{ padding: '7px 10px' }}>{r.label}</td><td className="nx-mono" style={{ padding: '7px 10px' }}>{fmt(r.earlier?.value, r.unit)}</td><td className="nx-mono" style={{ padding: '7px 10px' }}>{fmt(r.later?.value, r.unit)}</td>
                <td className="nx-mono" style={{ padding: '7px 10px' }}>{r.delta === undefined ? '—' : `${r.delta > 0 ? '+' : ''}${r.delta}${r.combinedUncertainty !== undefined ? ` (uncertainty ±${r.combinedUncertainty.toFixed(2)})` : ''}`}</td>
                <td style={{ padding: '7px 10px' }}><Badge tone={m.tone}>{m.text}</Badge> {r.status === 'not_comparable' ? (r.reason === 'non_numeric' ? (r.identical ? 'Same value' : 'Different value') : REASON[r.reason ?? ''] ?? '') : r.status === 'beyond_uncertainty' ? `The later value is ${r.laterIs}.` : ''}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <p style={{ margin: '10px 0 0', font: '400 11.5px/1.5 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{c.statement}</p>
      <p className="nx-mono" style={{ margin: '6px 0 0', fontSize: 10, color: 'var(--nx-text-dim)', wordBreak: 'break-all' }}>comparison SHA-256 {c.comparisonSha256}</p>
    </div>
  );
}
