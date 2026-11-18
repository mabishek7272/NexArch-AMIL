import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/**
 * Clinical workflow: document review & confirmation (source-linked), snapshot →
 * rule run → report → sign-off → export, optional AI-assisted review, and patient
 * access administration. Every action is enforced server-side; the UI only shows
 * what the server returns (no optimistic success).
 */

type Tab = 'documents' | 'report' | 'access';
interface Patient { id: string; name: string; uid: string; access_level?: string }
interface Candidate { id: string; status: string; flags: string[]; data: { analyte: string; valueRaw: string; unit: string | null; refLow: number | null; refHigh: number | null; page: number; line: number; sourceText: string; method: string; ocrConfidence: number | null } }
interface Review { document: any; extraction: any; pages: Array<{ page: number; method: string; status: string; text: string; ocr_confidence: number | null }>; candidates: Candidate[]; observations: any[] }

const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';  // transparent: inherits the theme (inputs default to white)
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const FLAG_TEXT: Record<string, string> = {
  missing_unit: 'unit missing', inequality_value: 'inequality', comma_decimal_ambiguous: 'ambiguous decimal',
  missing_reference_interval: 'no interval', ocr_source: 'from OCR', ocr_low_confidence: 'low/no OCR confidence', lab_flag_present: 'lab flag',
};

function Msg({ m }: { m: { kind: 'ok' | 'err'; text: string } | null }) {
  if (!m) return null;
  return <p role="status" className="text-xs mt-2" style={{ color: m.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{m.text}</p>;
}

export default function Clinical() {
  const [tab, setTab] = useState<Tab>('documents');
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState('');
  const [docs, setDocs] = useState<any[]>([]);
  const [docId, setDocId] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [snap, setSnap] = useState<any>(null);
  const [run, setRun] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [aiReview, setAiReview] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); }
    catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    fetch('/auth/me', { credentials: 'include' }).then((r) => r.json()).then((d) => setMe(d.user ?? null)).catch(() => setMe(null));
    api.get<{ patients: Patient[] }>('/patients').then((d) => setPatients(d.patients)).catch(() => setPatients([]));
  }, []);

  const loadDocs = useCallback(async (pid: string) => {
    if (!pid) { setDocs([]); setReports([]); return; }
    const d = await api.get<{ documents: any[] }>(`/clinical/patients/${pid}/documents`);
    setDocs(d.documents);
    const r = await api.get<{ reports: any[] }>(`/clinical/patients/${pid}/reports`);
    setReports(r.reports);
  }, []);
  const openReport = async (id: string) => { setReport(await api.get(`/clinical/reports/${id}`)); setTab('report'); };
  const loadReview = useCallback(async (id: string) => {
    setDocId(id); setSnap(null); setRun(null); setReport(null); setAiReview(null);
    setReview(id ? await api.get<Review>(`/clinical/documents/${id}`) : null);
  }, []);

  useEffect(() => { void loadDocs(patientId).catch((e) => setMsg({ kind: 'err', text: String(e.message) })); setDocId(''); setReview(null); }, [patientId, loadDocs]);

  async function upload(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = new FormData(ev.currentTarget);
    await act(async () => {
      const r = await fetch(`/api/clinical/patients/${patientId}/documents`, { method: 'POST', credentials: 'include', body: form });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      await loadDocs(patientId);
      await loadReview(body.documentId);
      setMsg({ kind: body.extraction?.status === 'complete' ? 'ok' : 'err', text: `Extraction ${body.extraction?.status}${body.extraction?.error ? ` (${body.extraction.error})` : ''}: ${body.candidates} value(s) need confirmation.` });
    });
  }

  const decide = (c: Candidate, action: 'confirm' | 'reject' | 'correct', correction?: any, reason?: string) =>
    act(async () => { await api.post(`/clinical/candidates/${c.id}/decision`, { action, correction, reason }); await loadReview(docId); }, `Candidate ${action}ed.`);

  const isAdmin = me?.role === 'admin';
  const isClinician = me?.role === 'clinician';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Clinical workflow</h1>
        <p className="text-sm" style={muted}>Drafts for qualified review — not diagnoses. Values must be confirmed against the source before use.</p>
      </header>
      <nav className="flex gap-2" role="tablist">
        {(['documents', 'report', ...(isAdmin ? ['access'] : [])] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={btn} onClick={() => setTab(t)}>{t === 'documents' ? 'Documents & confirmation' : t === 'report' ? 'Report' : 'Patient access'}</button>
        ))}
      </nav>
      <Msg m={msg} />

      {tab === 'documents' && (
        <>
          <GlassCard padding="md">
            <label className="text-xs font-semibold">Patient (only patients you have been granted)</label>
            <select className={`${box} w-full mt-1 bg-transparent`} value={patientId} onChange={(e) => setPatientId(e.target.value)} aria-label="Patient">
              <option value="">Select…</option>
              {patients.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.uid} · {p.access_level}</option>)}
            </select>
            {patientId && (
              <form className="flex flex-wrap gap-2 items-end mt-3" onSubmit={upload}>
                <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.txt" required aria-label="Document file" />
                <input name="purpose" required placeholder="Purpose of use" className={box} aria-label="Purpose" />
                <button className={btn} disabled={busy}>Upload</button>
              </form>
            )}
            {reports.length > 0 && (
              <div className="mt-3">
                <h2 className="text-xs font-semibold">Reports for this patient</h2>
                <ul className="text-sm space-y-1" data-testid="report-list">
                  {reports.map((r) => (
                    <li key={r.id}><button className="underline" onClick={() => void act(() => openReport(r.id))}>
                      v{r.version} · {r.superseded_at && r.status !== 'superseded' ? 'superseded data' : r.status} · {new Date(Number(r.created_at)).toLocaleString()}
                    </button></li>
                  ))}
                </ul>
              </div>
            )}
            {docs.length > 0 && (
              <ul className="mt-3 text-sm space-y-1" data-testid="doc-list">
                {docs.map((d) => (
                  <li key={d.id}><button className="underline" onClick={() => void act(() => loadReview(d.id))}>{new Date(Number(d.created_at)).toLocaleString()} · {d.media_type} · {d.page_count ?? '?'} page(s) · {d.status}</button></li>
                ))}
              </ul>
            )}
          </GlassCard>

          {review && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <GlassCard padding="md">
                <h2 className="font-semibold mb-2">Source pages</h2>
                <p className="text-xs mb-2" style={muted}>Extraction: {review.extraction?.status} · parser {review.extraction?.parser}{review.extraction?.ocrEngine ? ` · OCR ${review.extraction.ocrEngine}` : ' · OCR not configured'}</p>
                {review.pages.map((p) => (
                  <section key={p.page} className="mb-3">
                    <h3 className="text-xs font-semibold">Page {p.page} · {p.method} · {p.status}{p.ocr_confidence !== null ? ` · OCR confidence ${p.ocr_confidence.toFixed(2)}` : ''}</h3>
                    <pre className="text-xs whitespace-pre-wrap rounded p-2 mt-1" style={{ background: 'rgba(127,127,127,.08)', maxHeight: 260, overflow: 'auto' }}>{p.text || '(no text on this page)'}</pre>
                  </section>
                ))}
              </GlassCard>

              <GlassCard padding="md">
                <h2 className="font-semibold mb-2">Extracted values — confirm against the source</h2>
                {review.candidates.length === 0 && <p className="text-sm" style={muted}>No result lines were recognised. Nothing was inferred.</p>}
                <ul className="space-y-3">
                  {review.candidates.map((c) => <CandidateRow key={c.id} c={c} busy={busy} onDecide={decide} />)}
                </ul>

                <h2 className="font-semibold mt-5 mb-2">Confirmed observations</h2>
                <ul className="space-y-2 text-sm">
                  {review.observations.map((o) => <ObservationRow key={o.id} o={o} busy={busy} onCorrect={(correction, reason) => act(async () => { const r = await api.post<any>(`/clinical/observations/${o.id}/correct`, { correction, reason }); await loadReview(docId); await loadDocs(patientId); if (report) setReport(await api.get(`/clinical/reports/${report.id}`)); setMsg({ kind: 'ok', text: `Revision ${r.revision}; superseded ${r.snapshotsSuperseded} snapshot(s), ${r.reportsSuperseded} report(s).` }); })} />)}
                </ul>

                <div className="flex flex-wrap gap-2 mt-4">
                  <button className={btn} disabled={busy} onClick={() => act(async () => setSnap(await api.post(`/clinical/documents/${docId}/snapshots`, {})), 'Snapshot created.')}>1 · Create snapshot</button>
                  <button className={btn} disabled={busy || !snap} onClick={() => act(async () => setRun(await api.post(`/clinical/snapshots/${snap.snapshotId}/rule-runs`, {})), 'Rules run recorded.')}>2 · Run released rules</button>
                  <button className={btn} disabled={busy || !run} onClick={() => act(async () => { const r = await api.post<any>(`/clinical/snapshots/${snap.snapshotId}/reports`, { engineRunId: run.engineRunId }); await loadDocs(patientId); await openReport(r.reportId); }, 'Draft report created.')}>3 · Create report</button>
                  <button className={btn} disabled={busy || !run} onClick={() => act(async () => { const r = await fetch(`/api/clinical/snapshots/${snap.snapshotId}/engine-runs/${run.engineRunId}/model-review`, { method: 'POST', credentials: 'include' }); setAiReview(await r.json()); })}>AI-assisted review (optional)</button>
                </div>
                {snap && <p className="text-xs mt-2" style={muted}>Snapshot {snap.snapshotId} · sha256 {snap.sha256?.slice(0, 16)}… · {snap.observations} observation(s)</p>}
                {run && <p className="text-xs" style={muted}>Rule run {run.engineRunId} · {run.findings} finding(s) · clinical rules: {run.clinicalState}</p>}
                {aiReview && <AiReviewPanel r={aiReview} />}
              </GlassCard>
            </div>
          )}
        </>
      )}

      {tab === 'report' && <ReportPanel report={report} isClinician={isClinician} busy={busy} onRefresh={async (id) => setReport(await api.get(`/clinical/reports/${id}`))} act={act} />}
      {tab === 'access' && isAdmin && <AccessAdmin act={act} />}
    </div>
  );
}

function CandidateRow({ c, busy, onDecide }: { c: Candidate; busy: boolean; onDecide: (c: Candidate, a: 'confirm' | 'reject' | 'correct', corr?: any, reason?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(c.data.valueRaw);
  const [unit, setUnit] = useState(c.data.unit ?? '');
  const [reason, setReason] = useState('');
  const d = c.data;
  return (
    <li className={box}>
      <div className="flex flex-wrap justify-between gap-2">
        <span><strong>{d.analyte}</strong> {d.valueRaw} {d.unit ?? <em>(no unit)</em>} {d.refLow !== null ? `· interval ${d.refLow}–${d.refHigh}` : ''}</span>
        <span className="text-xs">{c.status}</span>
      </div>
      <p className="text-xs mt-1" style={muted}>Source p.{d.page} line {d.line} ({d.method}): “{d.sourceText}”</p>
      {c.flags.length > 0 && <p className="text-xs mt-1" style={{ color: '#f59e0b' }}>Check: {c.flags.map((f) => FLAG_TEXT[f] ?? f).join(', ')}</p>}
      {c.status === 'pending' && !editing && (
        <div className="flex gap-2 mt-2">
          <button className={btn} disabled={busy} onClick={() => onDecide(c, 'confirm')}>Confirm</button>
          <button className={btn} disabled={busy} onClick={() => setEditing(true)}>Correct…</button>
          <button className={btn} disabled={busy} onClick={() => onDecide(c, 'reject')}>Reject</button>
        </div>
      )}
      {editing && (
        <form className="flex flex-wrap gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); onDecide(c, 'correct', { valueRaw: value, unit: unit || null }, reason); }}>
          <input className={box} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Corrected value" />
          <input className={box} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit" aria-label="Corrected unit" />
          <input className={box} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" required aria-label="Correction reason" />
          <button className={btn} disabled={busy}>Save correction</button>
          <button type="button" className={btn} onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
    </li>
  );
}

function ObservationRow({ o, busy, onCorrect }: { o: any; busy: boolean; onCorrect: (c: any, reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(o.value_raw);
  const [reason, setReason] = useState('');
  return (
    <li className={box}>
      {o.analyte}: {o.value_raw} {o.unit ?? ''} · rev {o.revision} · {o.status} · p.{o.page ?? '?'}
      {!open ? <button className={`${btn} ml-2`} onClick={() => setOpen(true)}>Correct…</button> : (
        <form className="flex flex-wrap gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); onCorrect({ valueRaw: value }, reason); setOpen(false); }}>
          <input className={box} value={value} onChange={(e) => setValue(e.target.value)} aria-label="New value" />
          <input className={box} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" required aria-label="Reason" />
          <button className={btn} disabled={busy}>Save (supersedes reports)</button>
        </form>
      )}
    </li>
  );
}

function AiReviewPanel({ r }: { r: any }) {
  return (
    <div className="mt-3 rounded-md p-3 text-sm" style={{ border: '1px dashed #64748b' }}>
      <p className="text-xs font-semibold">AI-assisted review — model output, not clinical approval · status: {r.status ?? r.error}</p>
      {r.review ? (
        <>
          <p className="mt-1">{r.review.summary}</p>
          <ul className="list-disc ml-5 mt-1">{r.review.points.map((p: any, i: number) => <li key={i}>{p.text} <span style={muted}>[findings {p.cites.join(', ')}]</span></li>)}</ul>
        </>
      ) : <p className="mt-1" style={muted}>No review shown ({(r.problems ?? []).slice(0, 3).join('; ') || 'not completed'}).</p>}
      {r.models && <p className="text-xs mt-1" style={muted}>Models: {r.models.decision} → {r.models.review}</p>}
    </div>
  );
}

function ReportPanel({ report, isClinician, busy, onRefresh, act }: { report: any; isClinician: boolean; busy: boolean; onRefresh: (id: string) => Promise<void>; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  if (!report) return <GlassCard padding="md"><p className="text-sm" style={muted}>Create a report from the Documents tab.</p></GlassCard>;
  const r = report.report;
  const banner = report.status === 'reviewed' ? 'Reviewed' : report.status === 'superseded' ? 'SUPERSEDED — do not use' : 'DRAFT — not reviewed';
  return (
    <GlassCard padding="md">
      <p role="status" className="font-semibold" style={{ color: report.status === 'reviewed' ? '#10b981' : '#f59e0b' }}>{banner} · version {report.version}</p>
      <h2 className="font-semibold mt-3">Subjective</h2><p className="text-sm">{r.soap.subjective.provided ? r.soap.subjective.items.map((i: any) => i.text).join('; ') : r.soap.subjective.note}</p>
      <h2 className="font-semibold mt-3">Objective</h2><ul className="text-sm list-disc ml-5">{r.soap.objective.items.map((i: any) => <li key={i.observationId}>{i.text} <span style={muted}>({i.source})</span></li>)}</ul>
      <h2 className="font-semibold mt-3">Assessment</h2><ul className="text-sm list-disc ml-5">{r.soap.assessment.items.map((i: any, k: number) => <li key={k}>{i.text}</li>)}</ul>
      <p className="text-xs" style={muted}>{r.soap.assessment.note} {r.soap.assessment.clinicalRules}</p>
      <h2 className="font-semibold mt-3">Plan</h2><p className="text-sm">{r.soap.plan.note}</p>
      <h2 className="font-semibold mt-3">Plain-language summary</h2><ul className="text-sm list-disc ml-5">{r.layman.items.map((t: string, k: number) => <li key={k}>{t}</li>)}</ul>
      <p className="text-xs mt-3" style={muted}>Snapshot sha256 {r.provenance.snapshotHash.slice(0, 16)}… · rule run {r.provenance.ruleRunId}</p>
      <div className="flex flex-wrap gap-2 mt-4">
        <a className={btn} href={`/api/clinical/reports/${report.id}/export.html`} target="_blank" rel="noreferrer">Export HTML</a>
        <a className={btn} href={`/api/clinical/reports/${report.id}/export.pdf`}>Export PDF</a>
        {report.status === 'draft' && (
          <button className={btn} disabled={busy || !isClinician} title={isClinician ? '' : 'Only a provisioned licensed clinician can sign off'}
            onClick={() => act(async () => { const v = await api.post<any>(`/clinical/reports/${report.id}/review`, {}); await onRefresh(v.reportId); }, 'Signed off — new immutable version created.')}>
            Sign off (clinician)
          </button>
        )}
      </div>
    </GlassCard>
  );
}

function AccessAdmin({ act }: { act: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const [unassigned, setUnassigned] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState({ patient: '', user: '', level: 'read', purpose: '' });
  const reload = useCallback(async () => {
    setUnassigned((await api.get<any>('/patients/unassigned')).unassigned);
    setUsers((await api.get<any>('/users')).users);
  }, []);
  useEffect(() => { void reload().catch(() => {}); }, [reload]);
  return (
    <GlassCard padding="md">
      <h2 className="font-semibold">Unassigned patient records</h2>
      <p className="text-xs" style={muted}>These records are inaccessible to everyone until access is granted with a purpose. Only identifiers are shown.</p>
      <ul className="text-sm mt-2">{unassigned.map((u) => <li key={u.id}>{u.uid} <span style={muted}>({u.id})</span></li>)}{!unassigned.length && <li style={muted}>None.</li>}</ul>
      <h2 className="font-semibold mt-4">Grant or revoke access</h2>
      <form className="flex flex-wrap gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/patients/${form.patient}/access`, { user_id: form.user, access_level: form.level, purpose: form.purpose }); await reload(); }, 'Access granted (audited).'); }}>
        <input className={box} placeholder="Patient id" value={form.patient} onChange={(e) => setForm({ ...form, patient: e.target.value })} required aria-label="Patient id" />
        <select className={`${box} bg-transparent`} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} required aria-label="User">
          <option value="">User…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email} ({u.role})</option>)}
        </select>
        <select className={`${box} bg-transparent`} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} aria-label="Access level">
          <option value="read">read</option><option value="write">write</option><option value="owner">owner</option>
        </select>
        <input className={box} placeholder="Purpose (required)" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} required aria-label="Purpose" />
        <button className={btn}>Grant</button>
        <button type="button" className={btn} disabled={!form.patient || !form.user} onClick={() => act(async () => { await api.delete(`/patients/${form.patient}/access/${form.user}`); await reload(); }, 'Access revoked (audited).')}>Revoke</button>
      </form>
    </GlassCard>
  );
}
