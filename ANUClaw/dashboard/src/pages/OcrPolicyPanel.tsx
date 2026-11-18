import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/**
 * Draft OCR study-policy panel (rendered inside /ocr-study). DRAFT ONLY — REAL-STUDY ACTIVATION BLOCKED.
 * Prepares draft values + source-reference fields and records a two-person REVIEW (metadata and external references only). There is deliberately no control that activates, approves,
 * accepts or releases anything, and no field is pre-filled: values, source references and decision/signature references are supplied by people and are never treated as verification.
 */
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const BANNER = 'DRAFT ONLY — REAL-STUDY ACTIVATION BLOCKED';

export default function OcrPolicyPanel({ studyId, can, reauth }: { studyId: string; can: (perm: string) => boolean; reauth: () => Record<string, string> }) {
  const base = `/ocr-study/studies/${studyId}/policy`;
  const [report, setReport] = useState<any>(null);
  const [policy, setPolicy] = useState<any>(null);
  const [ready, setReady] = useState<any>(null);
  const [reviews, setReviews] = useState<any>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [top, setTop] = useState<Record<string, string>>({});
  const [rv, setRv] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setChainError(null);
    try { setPolicy(await api.get<any>(base)); } catch (e: any) { setPolicy(null); setChainError(String(e?.message ?? e)); }
    try { setReport(await api.get<any>(`${base}/report`)); } catch { setReport(null); }
    try { setReady(await api.get<any>(`${base}/readiness`)); } catch { setReady(null); }
    try { setReviews(await api.get<any>(`${base}/reviews`)); } catch { setReviews(null); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); } };

  const fields: any[] = report?.realStudy?.fields ?? [];
  const editable = can('edit_policy');
  const save = () => act(async () => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(vals)) { if (!vals[k]?.trim()) continue; let v: unknown; try { v = JSON.parse(vals[k]); } catch { throw new Error(`${k}: the value must be valid JSON`); } out[k] = { value: v, sourceRef: refs[k] ?? '' }; }
    if (!Object.keys(out).length && top.dref === undefined && top.rref === undefined) throw new Error('Nothing to save: supply at least one value or reference.');
    await api.put(base, { kind: 'real_study', fields: out, ...(top.dref !== undefined ? { clinicalLeadDecisionRef: top.dref } : {}), ...(top.rref !== undefined ? { independentReviewRef: top.rref } : {}), ...reauth() }); setVals({}); setRefs({});
  }, 'Draft version saved (immutable). It is not active and cannot be activated in this build.');
  return (
    <GlassCard padding="md">
      <div data-testid="policy-panel">
        <h2 className="font-semibold">OCR study policy (draft)</h2>
        <p role="note" data-testid="policy-banner" className="text-sm font-bold" style={{ color: '#f43f5e' }}>{BANNER}</p>
        <p className="text-xs" style={muted}>Every real-study field is unconfigured until a person supplies it. A source reference is recorded, not verified. Nothing on this panel activates, approves, accepts or releases anything, and no draft or review can make real-data registration or real-study evaluation available.</p>
        {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}
        {chainError
          ? <p data-testid="policy-chain" className="text-xs" style={{ color: '#f43f5e' }}>Policy history integrity check FAILED — {chainError}. Nothing can be saved or reviewed until this is resolved outside the application.</p>
          : policy && <p data-testid="policy-chain" className="text-xs" style={muted}>Policy {policy.policy.policyId.slice(-8)} · version <b>{policy.policy.version}</b> · hash {policy.policy.sha256.slice(0, 12)}… · hash chain {policy.chainVerified ? 'verified' : 'NOT verified'} · state: {policy.effectiveState}</p>}
        <table className="text-xs w-full mt-2" data-testid="policy-fields"><thead><tr className="text-left"><th>Field</th><th>Status</th><th>Source ref.</th><th>Affected code paths</th>{editable && <th>Draft value (JSON) and source reference</th>}</tr></thead>
          <tbody>{fields.map((f) => (<tr key={f.key} data-testid={`policy-field-${f.key}`} className="align-top"><td>{f.key}<div style={muted}>{f.label}</div></td><td data-testid={`policy-status-${f.key}`}>{f.status}</td><td>{f.sourceReferencePresent ? 'present (not verified)' : 'absent'}</td><td>{f.affectedCodePaths.join('; ')}</td>
            {editable && <td><input className={`${box} w-full mb-1`} aria-label={`Value for ${f.key}`} placeholder="JSON value supplied by you" value={vals[f.key] ?? ''} onChange={(e) => setVals((x) => ({ ...x, [f.key]: e.target.value }))} />
              <input className={`${box} w-full`} aria-label={`Source reference for ${f.key}`} placeholder="source reference (title, version, publisher)" value={refs[f.key] ?? ''} onChange={(e) => setRefs((x) => ({ ...x, [f.key]: e.target.value }))} /></td>}</tr>))}</tbody></table>
        {editable ? (<div className="mt-2 space-y-1">
          <input className={`${box} w-full`} aria-label="Clinical-lead decision reference (external)" placeholder="external clinical-lead decision reference" onChange={(e) => setTop((x) => ({ ...x, dref: e.target.value }))} />
          <input className={`${box} w-full`} aria-label="Independent-review reference (external)" placeholder="external independent-review reference" onChange={(e) => setTop((x) => ({ ...x, rref: e.target.value }))} />
          <div className="flex gap-2"><button className={btn} disabled={busy || !!chainError} onClick={() => void save()}>Save draft version</button>
            <button className={btn} disabled={busy || !!chainError} onClick={() => act(() => api.post(`${base}/reviews`, { ...reauth() }), 'Draft submitted for two-person review.')}>Submit current draft for review</button></div></div>)
          : <p className="text-xs" style={muted} data-testid="policy-readonly">Read-only for your study role.</p>}

        <h3 className="font-semibold text-sm mt-4">Two-person review of drafts</h3>
        <p className="text-xs" style={muted}>{reviews?.statement}</p>
        <ul className="text-xs" data-testid="policy-reviews">{(reviews?.reviews ?? []).map((r: any) => (<li key={r.reviewId}>{r.reviewId} — version {r.policyVersion} — <b>{r.status}</b>{r.decision ? ` by ${r.decision.reviewer} (refs recorded, not verified)` : ''}
          {can('review_policy') && r.status === 'awaiting_review' && (<span className="block mt-1">
            <input className={`${box} mr-1`} aria-label="External decision reference" placeholder="external decision reference" onChange={(e) => setRv((x) => ({ ...x, d: e.target.value }))} />
            <input className={`${box} mr-1`} aria-label="External signature reference" placeholder="external signature reference" onChange={(e) => setRv((x) => ({ ...x, s: e.target.value }))} />
            <button className={`${btn} mr-1`} disabled={busy} onClick={() => act(() => api.post(`${base}/reviews/${r.reviewId}/decision`, { decision: 'reviewed', externalDecisionRef: rv.d, externalSignatureRef: rv.s, ...reauth() }), 'Review recorded (references only). The policy remains a draft.')}>Record review (reference only)</button>
            <button className={btn} disabled={busy} onClick={() => act(() => api.post(`${base}/reviews/${r.reviewId}/decision`, { decision: 'changes_requested', ...reauth() }), 'Changes requested.')}>Request changes</button></span>)}</li>))}</ul>

        <h3 className="font-semibold text-sm mt-4">Readiness report</h3>
        {ready && (<div data-testid="policy-readiness"><p className="text-sm font-bold" data-testid="policy-ineligible" style={{ color: '#f59e0b' }}>{ready.banner}</p><p className="text-xs" style={muted}>{ready.statement} {ready.counts.total} open item(s).</p>
          <ul className="text-xs">{ready.items.map((i: any) => (<li key={`${i.category}-${i.id}`}>[{i.category.replace(/_/g, ' ')}] {i.description} — <span style={muted}>{i.links.map((l: any) => `${l.label} (${l.path})`).join('; ')}</span></li>))}</ul></div>)}
      </div>
    </GlassCard>
  );
}
