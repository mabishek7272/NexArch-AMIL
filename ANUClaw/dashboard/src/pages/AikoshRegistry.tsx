import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/**
 * AIKosh data registry — LOCAL GOVERNANCE ONLY. Every file starts as "unknown — blocked from external processing". A person records provenance, licence, permitted uses and
 * sensitivity; a DIFFERENT authorized person approves. Identity and role come from the session. Nothing on this page approves anything by itself or validates any data.
 */
const NOTICE = 'AIKosh data governance only — no file is approved for RAG, embeddings, prompts, fine-tuning, external processing or clinical evidence unless a person records and a second person approves it. Nothing here is clinical validation.';
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const EXTERNAL = ['embeddings', 'model_prompt', 'fine_tuning', 'external_provider'];

export default function AikoshRegistry() {
  const [data, setData] = useState<any>(null);
  const [sel, setSel] = useState<any>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [uses, setUses] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const load = useCallback(async () => { setData(await api.get<any>('/aikosh')); }, []);
  useEffect(() => { void load().catch(() => setData(null)); }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(null); try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); } };
  const external = uses.some((u) => EXTERNAL.includes(u));
  return (
    <div className="space-y-5">
      <header><h1 className="text-2xl font-bold">AIKosh data registry</h1><p role="note" data-testid="aikosh-notice" className="text-sm font-semibold" style={{ color: '#f59e0b' }}>{NOTICE}</p>
        <p className="text-xs" style={muted}>Default status of every file: <b>{data?.defaultStatus ?? 'unknown — blocked from external processing'}</b>. Local deterministic tests and local-only evaluation need no approval. Personal-data indicators are heuristic hints, not findings.</p></header>
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}
      {data?.canApprove && <button className={btn} disabled={busy} onClick={() => act(() => api.post('/aikosh/sync', {}), 'Inventory registered (immutable rows).')}>Register generated inventory</button>}
      <GlassCard padding="md"><table className="text-xs w-full" data-testid="aikosh-table"><thead><tr className="text-left"><th>File</th><th>Domain</th><th>Rows</th><th>Restricted fields</th><th>Status</th><th>Approvals</th></tr></thead>
        <tbody>{(data?.files ?? []).map((x: any) => (<tr key={x.path} className="align-top"><td><button className="underline" onClick={() => { setSel(x); setUses([]); }}>{x.path}</button><div style={muted} className="break-all">{x.sha256.slice(0, 16)}…</div></td><td>{x.catalog?.domain}</td><td>{x.rowCount ?? '—'}</td>
          <td>{[...x.personalDataIndicators.narrativeColumns, ...x.personalDataIndicators.identifierColumns].join(', ') || '—'}</td><td>{x.status}</td><td>{x.registry?.approvals?.length ? x.registry.approvals.map((a: any) => `${a.id}: ${a.state}${a.appliesToCurrentBytes ? '' : ' (different bytes)'}`).join('; ') : 'none'}</td></tr>))}</tbody></table></GlassCard>
      {sel && data?.canApprove && (
        <GlassCard padding="md"><h2 className="font-semibold" data-testid="aikosh-form-title">Record an approval proposal for {sel.path}</h2><p className="text-xs" style={muted}>This grants nothing until a different admin/compliance user approves it. Evidence references are recorded, not verified.</p>
          <div className="grid grid-cols-2 gap-2 mt-2 max-w-3xl">
            {['provenance', 'licenceName', 'licenceRef', 'consentRef', 'deidentificationRef', 'dpaRef', 'clinicalOwnerRef', 'datasetCardSha256'].map((k) => <input key={k} className={box} placeholder={k} aria-label={k} value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} />)}
            <select className={box} aria-label="sensitivity" value={f.sensitivity ?? 'public_reference'} onChange={(e) => set('sensitivity', e.target.value)}>{(data.sensitivities as string[]).filter((s) => s !== 'unknown').map((s) => <option key={s}>{s}</option>)}</select>
            <input className={box} placeholder="externally released fields (comma separated)" aria-label="externalFieldsReleased" value={f.released ?? ''} onChange={(e) => set('released', e.target.value)} /></div>
          <div className="flex flex-wrap gap-3 mt-2 text-xs">{(data.uses as string[]).filter((u) => !u.startsWith('local_')).map((u) => <label key={u}><input type="checkbox" checked={uses.includes(u)} onChange={(e) => setUses((x) => e.target.checked ? [...x, u] : x.filter((y) => y !== u))} /> {u}</label>)}</div>
          {external && <p className="text-xs mt-1" style={{ color: '#f43f5e' }}>External use selected: requires a signed data-processing agreement reference, a non-identifiable sensitivity, and (for fine-tuning) consent, de-identification and a dataset-card hash.</p>}
          <button className={`${btn} mt-2`} disabled={busy || !uses.length} onClick={() => act(() => api.post('/aikosh/approvals', { path: sel.path, sha256: sel.sha256, provenance: f.provenance, licenceName: f.licenceName, licenceRef: f.licenceRef, licencePermitsUses: uses, permittedUses: uses, sensitivity: f.sensitivity ?? 'public_reference',
            consentRef: f.consentRef || null, deidentificationRef: f.deidentificationRef || null, externalProcessing: external ? 'approved' : 'not_approved', dpaRef: f.dpaRef || null, clinicalOwnerRef: f.clinicalOwnerRef || null, datasetCardSha256: f.datasetCardSha256 || null,
            externalFieldsReleased: (f.released ?? '').split(',').map((s) => s.trim()).filter(Boolean) }), 'Proposal recorded; a different person must approve it.')}>Record proposal</button></GlassCard>)}
      {data?.canApprove && sel?.registry?.approvals?.length > 0 && (<GlassCard padding="md"><h2 className="font-semibold">Decisions for {sel.path}</h2><input className={`${box} w-full my-1`} placeholder="Reason (required)" aria-label="Decision reason" value={f.reason ?? ''} onChange={(e) => set('reason', e.target.value)} />
        {sel.registry.approvals.map((a: any) => <div key={a.id} className="text-xs">{a.id} — {a.state} — uses {a.permittedUses.join(', ')}{' '}
          {a.state === 'awaiting_second_person' && <button className={btn} disabled={busy || !f.reason} onClick={() => act(() => api.post(`/aikosh/approvals/${a.id}/decision`, { decision: 'approve', reason: f.reason }), 'Approved by you (must differ from the recorder).')}>Approve</button>}
          {a.state === 'approve' && <button className={btn} disabled={busy || !f.reason} onClick={() => act(() => api.post(`/aikosh/approvals/${a.id}/decision`, { decision: 'revoke', reason: f.reason }), 'Revoked (permanent).')}>Revoke</button>}</div>)}</GlassCard>)}
      <p className="text-xs" style={muted} data-testid="aikosh-notice-footer">{NOTICE}</p>
    </div>
  );
}
