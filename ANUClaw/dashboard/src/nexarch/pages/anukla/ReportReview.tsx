import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, PenLine, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../../../lib/api';
import { Badge, Button, Dialog, Field, Input, SR_ONLY, WorkspaceBar, type BadgeTone } from '../../ui';
import { useCurrentUser } from '../../useCurrentUser';

interface View {
  report: { id: string; jobId: string; tenantName: string | null; version: number; status: string; reviewState: string | null; reviewedBy: string | null; reviewedAt: number | null; rejectionReason: string | null; contentSha256: string; findingsSha256: string; narrativeMode: string; modelRequested: string | null; modelReturned: string | null; banner: string };
  governance: { routeState: string; routeReasons: string[]; followUp: boolean; referralReasonCodes: string[]; flags: Array<{ type: string; severity: string; detail: string }> };
  aiReview: { ok: boolean; state: string; checks: Array<{ id: string; ok: boolean }> } | null;
  history: Array<{ id: string; version: number; status: string; reviewState: string | null; reviewedBy: string | null }>;
  actions: { canSign: boolean; canReject: boolean; canRegenerate: boolean };
}
const STATE: Record<string, { tone: BadgeTone; text: string }> = {
  ai_reviewed: { tone: 'blue', text: 'AI-REVIEWED' }, awaiting_clinician: { tone: 'amber', text: 'AWAITING CLINICIAN' }, clinician_signed: { tone: 'green', text: 'SIGNED' }, rejected: { tone: 'red', text: 'REJECTED' },
};
const CHECK: Record<string, string> = {
  layers_bound_to_findings: 'Both layers are bound to the same findings and governance', layers_identical_findings: 'Both layers show identical findings', rows_match_source: 'Values and units match the source',
  positions_match_governance: 'Positions match the governance output', all_flags_surfaced: 'Every flag is shown', advisory_matches_governance: 'The referral advisory matches the rules',
  narrative_guards_pass: 'Wording checks pass (numbers, citations, no diagnosis or reassurance)', layers_cover_flagged_findings: 'Flagged findings are covered in both layers', no_blocking_flags: 'No blocking flag', no_review_flag_from_narrative: 'Explanation text was checked successfully',
};

type Dlg = null | 'sign' | 'reject' | 'regenerate';

export default function ReportReview() {
  const { id = '' } = useParams();
  const { user } = useCurrentUser();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState<'clinical' | 'layman'>('clinical');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [attested, setAttested] = useState(false);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dlgError, setDlgError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setView(await api.get<View>(`/anukla/review/reports/${id}`)); } catch (e: any) { setView(null); setError(String(e?.message ?? e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const close = () => { setDlg(null); setAttested(false); setPassword(''); setReason(''); setDlgError(null); };
  const run = async (fn: () => Promise<any>, doneText: (r: any) => string) => {
    setBusy(true); setDlgError(null);
    try { const r = await fn(); close(); setDone(doneText(r)); await load(); } catch (e: any) { setDlgError(String(e?.message ?? e)); setPassword(''); } finally { setBusy(false); }
  };
  const sign = () => run(() => api.post(`/anukla/review/reports/${id}/sign`, { contentSha256: view!.report.contentSha256, attested: true, password }), (r) => `Signed. A new version (v${r.version}) now carries your signature.`);
  const reject = () => run(() => api.post(`/anukla/review/reports/${id}/reject`, { contentSha256: view!.report.contentSha256, reason, password }), () => 'Rejected. The tenant now sees a rejected banner.');
  const regenerate = () => run(() => api.post(`/anukla/review/reports/${id}/regenerate`, {}), (r) => `A replacement version (v${r.version}) was queued. It appears here when it is ready.`);

  if (error) return <div style={{ padding: 22 }}><p role="alert" style={{ color: 'var(--nx-red)', font: '400 13px Inter,sans-serif' }}>{error}</p><Link to="/nexarch/anukla/review" style={{ color: 'var(--nx-gold-bright)' }}>Back to the queue</Link></div>;
  if (!view) return <div style={{ padding: 22, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}>Loading…</div>;
  const r = view.report; const st = r.reviewState ? STATE[r.reviewState] : undefined;
  const canRegenerate = view.actions.canRegenerate && (user?.role === 'clinician' || user?.role === 'admin');

  return (
    <div>
      <WorkspaceBar badges={[
        { label: 'TENANT', value: <span style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{r.tenantName ?? '—'}</span> },
        { label: 'VERSION', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>v{r.version}</span> },
        { label: 'STATUS', value: st ? <Badge tone={st.tone}>{st.text}</Badge> : <Badge>{r.status.toUpperCase()}</Badge> },
      ]} />
      <div style={{ padding: '16px 22px' }}>
        <Link to="/nexarch/anukla/review" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--nx-text-muted)', font: '400 12px Inter,sans-serif' }}><ArrowLeft size={14} aria-hidden="true" /> Review queue</Link>
        <h1 style={{ margin: '8px 0 4px', font: '600 20px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Report review</h1>
        <p role="status" style={{ margin: '0 0 12px', font: '500 12.5px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{r.banner}</p>
        {done && <p role="status" style={{ margin: '0 0 12px', padding: '8px 12px', border: '1px solid var(--nx-green-border)', background: 'var(--nx-green-bg)', color: 'var(--nx-green)', borderRadius: 6, font: '500 12.5px Inter,sans-serif' }}>{done}</p>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <Button variant="primary" icon={<PenLine size={14} aria-hidden="true" />} disabled={!view.actions.canSign} onClick={() => setDlg('sign')}>Sign this version…</Button>
          <Button variant="destructive" icon={<XCircle size={14} aria-hidden="true" />} disabled={!view.actions.canReject} onClick={() => setDlg('reject')}>Reject…</Button>
          <Link to={`/nexarch/anukla/timeline/${r.jobId}`} className="nx-btn" style={{ textDecoration: 'none' }}>Scans over time</Link>
          {canRegenerate && <Button icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => setDlg('regenerate')}>Request a replacement version…</Button>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 16 }} className="anukla-review-grid">
          <div>
            <div role="tablist" aria-label="Report layer" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(['clinical', 'layman'] as const).map((l) => (
                <button key={l} role="tab" aria-selected={layer === l} className={`nx-btn ${layer === l ? 'nx-btn-primary' : ''}`} onClick={() => setLayer(l)}>{l === 'clinical' ? 'Clinical layer' : 'Layman layer'}</button>
              ))}
            </div>
            <iframe title={`${layer} report, version ${r.version}`} src={`/api/anukla/review/reports/${r.id}/html?layer=${layer}`} sandbox="" style={{ width: '100%', height: 720, border: '1px solid var(--nx-border)', borderRadius: 7, background: '#fff' }} />
          </div>
          <aside aria-label="Review facts" style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
            <section className="nx-panel" style={{ padding: 12 }}>
              <div className="nx-label">WHY THIS NEEDS REVIEW</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 16, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
                {[...view.governance.routeReasons, ...view.governance.referralReasonCodes].length === 0 && <li>No special reason recorded.</li>}
                {[...view.governance.routeReasons, ...view.governance.referralReasonCodes].map((c) => <li key={c}>{c.replace(/_/g, ' ')}</li>)}
              </ul>
            </section>
            <section className="nx-panel" style={{ padding: 12 }}>
              <div className="nx-label">AUTOMATIC REVIEW (RULES, NOT A CLINICIAN)</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none', font: '400 12px/1.6 Inter,sans-serif' }}>
                {(view.aiReview?.checks ?? []).map((c) => <li key={c.id} style={{ color: c.ok ? 'var(--nx-text-soft)' : 'var(--nx-red)' }}><span aria-hidden="true">{c.ok ? '✓' : '✗'}</span><span style={SR_ONLY}>{c.ok ? 'Passed: ' : 'Failed: '}</span> {CHECK[c.id] ?? c.id}</li>)}
              </ul>
            </section>
            <section className="nx-panel" style={{ padding: 12 }}>
              <div className="nx-label">FLAGS</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 16, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>
                {view.governance.flags.length === 0 && <li>None.</li>}
                {view.governance.flags.map((f, n) => <li key={n}><Badge tone={f.severity === 'blocking' ? 'red' : f.severity === 'attention' ? 'amber' : 'neutral'}>{f.severity.toUpperCase()}</Badge> {f.type.replace(/_/g, ' ')}</li>)}
              </ul>
            </section>
            <section className="nx-panel" style={{ padding: 12 }}>
              <div className="nx-label">PROVENANCE</div>
              <dl className="nx-mono" style={{ margin: '8px 0 0', fontSize: 10.5, lineHeight: 1.7, color: 'var(--nx-text-muted)', wordBreak: 'break-all' }}>
                <dt>Explanation text</dt><dd style={{ margin: 0 }}>{r.narrativeMode === 'deterministic' ? 'fixed templates (no model)' : `${r.narrativeMode}; ${r.modelReturned ?? r.modelRequested ?? ''}`}</dd>
                <dt>Content SHA-256 (what you would sign)</dt><dd style={{ margin: 0 }}>{r.contentSha256}</dd>
                <dt>Findings SHA-256</dt><dd style={{ margin: 0 }}>{r.findingsSha256}</dd>
              </dl>
            </section>
            <section className="nx-panel" style={{ padding: 12 }}>
              <div className="nx-label">VERSIONS</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none', font: '400 12px/1.7 Inter,sans-serif' }}>
                {view.history.map((h) => (
                  <li key={h.id} style={{ color: 'var(--nx-text-soft)' }}>
                    {h.id === r.id ? <strong>v{h.version} (this one)</strong> : <Link to={`/nexarch/anukla/review/${h.id}`} style={{ color: 'var(--nx-gold-bright)' }}>v{h.version}</Link>} — {h.status}{h.reviewState ? `, ${h.reviewState.replace(/_/g, ' ')}` : ''}{h.reviewedBy ? ` by ${h.reviewedBy}` : ''}
                  </li>
                ))}
              </ul>
            </section>
            {r.rejectionReason && <section className="nx-panel" style={{ padding: 12 }}><div className="nx-label">REJECTION REASON</div><p style={{ margin: '8px 0 0', font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)', whiteSpace: 'pre-wrap' }}>{r.rejectionReason}</p></section>}
          </aside>
        </div>
      </div>

      <Dialog open={dlg === 'sign'} onClose={busy ? () => {} : close} icon={<PenLine size={15} aria-hidden="true" />} title="Sign this version"
        footer={<><Button onClick={close} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={!attested || !password} onClick={sign}>Sign</Button></>}>
        <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>Signing creates a new version that carries your name and the time, for exactly the content identified by the hash below. Nothing else changes.</p>
        <p className="nx-mono" style={{ margin: '8px 0', fontSize: 10.5, color: 'var(--nx-text-muted)', wordBreak: 'break-all' }}>{r.contentSha256}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', font: '400 12px/1.5 Inter,sans-serif', color: 'var(--nx-text)' }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I have reviewed both layers of this exact version, and I am responsible for signing it as a licensed clinician.</span>
        </label>
        <div style={{ marginTop: 12 }}><Field label="YOUR PASSWORD" error={dlgError ?? undefined}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={!!dlgError} /></Field></div>
      </Dialog>

      <Dialog open={dlg === 'reject'} onClose={busy ? () => {} : close} icon={<XCircle size={15} aria-hidden="true" />} title="Reject this version"
        footer={<><Button onClick={close} disabled={busy}>Cancel</Button><Button variant="destructive" loading={busy} disabled={!reason.trim() || !password} onClick={reject}>Reject</Button></>}>
        <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>The tenant will see that a clinician rejected this version. The reason is kept for your records and is not sent to the tenant.</p>
        <div style={{ marginTop: 12 }}><Field label="REASON (1-500 CHARACTERS)"><textarea className="nx-input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} /></Field></div>
        <div style={{ marginTop: 12 }}><Field label="YOUR PASSWORD" error={dlgError ?? undefined}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={!!dlgError} /></Field></div>
      </Dialog>

      <Dialog open={dlg === 'regenerate'} onClose={busy ? () => {} : close} icon={<RefreshCw size={15} aria-hidden="true" />} title="Request a replacement version"
        footer={<><Button onClick={close} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={regenerate}>Request</Button></>}>
        <p style={{ margin: 0, font: '400 12px/1.6 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>A new version is produced from the same findings, using the tenant's current settings, and reviewed by the same rules. The rejected version stays visible to the tenant until the replacement is ready.</p>
        {dlgError && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--nx-red)', font: '400 12px Inter,sans-serif' }}>{dlgError}</p>}
      </Dialog>
    </div>
  );
}
