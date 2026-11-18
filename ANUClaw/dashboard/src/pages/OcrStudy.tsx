import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';
import OcrPolicyPanel from './OcrPolicyPanel';

/**
 * OCR validation-study workspaces. STUDY TOOLING ONLY: synthetic data does not establish OCR accuracy, clinical validation or release approval.
 * The server decides everything: this page never sends a user, tenant, role or lock state — it shows what the server derived, and each section appears
 * only if the signed-in user's study role permits it (the server enforces it again). There is no "accept study" action anywhere, by design.
 */
const NOTICE = 'Study tooling only — synthetic data does not establish OCR accuracy, clinical validation or release approval.';
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const SYNTH_ATTESTATION = { declaration: 'synthetic', attestorName: 'n/a — synthetic content authored for tool testing', attestorRole: 'not a person', method: 'all content authored synthetically; no real person or report involved', reviewedSampleSize: 0, attestedAt: new Date().toISOString(), attestationRef: 'synthetic sample (OCR study page)', residualRiskNote: 'none: no real data' };
const SYNTH_SOURCES = ['SYNTHETIC FIXTURE 1\nSodium 140 mmol/L 135-145\nPotassium 4.7 mmol/L 3.5-5.1\n', 'SYNTHETIC FIXTURE 2\nGlucose 5.2 mmol/L 3.9-5.6\nCRP <5 mg/L 0-5\n', 'SYNTHETIC FIXTURE 3\nCreatinine 88 umol/L 60-110\n'].map((t) => ({ contentBase64: btoa(t), pages: 1, mediaType: 'text/plain' }));

type Perms = Record<string, string[]>;
const enc = encodeURIComponent;

export default function OcrStudy() {
  const [overview, setOverview] = useState<any>(null);
  const [study, setStudy] = useState<any>(null);
  const [dsId, setDsId] = useState('');
  const [data, setData] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); return r; } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };
  const loadOverview = useCallback(async () => { setOverview(await api.get<any>('/ocr-study')); }, []);
  const loadStudy = useCallback(async (id: string) => { setStudy(id ? await api.get<any>(`/ocr-study/studies/${id}`) : null); setDsId(''); setData({}); }, []);
  useEffect(() => { void loadOverview().catch(() => setOverview(null)); }, [loadOverview]);

  const perms: Perms = overview?.permissions ?? {};
  const role: string = study?.myRole ?? '';
  const can = (p: string) => !!role && (perms[p] ?? []).includes(role);
  const base = study ? `/ocr-study/studies/${study.id}` : '';
  const ds = study?.datasets?.find((d: any) => d.datasetId === dsId);
  const dsBase = `${base}/datasets/${dsId}`;
  const put = (k: string, v: unknown) => setData((d) => ({ ...d, [k]: v }));
  const parse = (k: string) => JSON.parse(f[k] ?? 'null');
  const reauthOn: boolean = !!overview?.security?.reauth?.required;
  const reauthBody = (): Record<string, string> => (reauthOn && f.reauth ? { reauthPassword: f.reauth } : {});

  const refreshDs = async () => { if (!dsId) return; for (const [perm, key, path] of [['view_manifest', 'manifest', '/manifest'], ['view_manifest', 'unlocks', '/unlock-requests'], ['list_cases', 'cases', '/cases'], ['own_annotations', 'mine', '/my-annotations'], ['agreement_summary', 'agreement', '/agreement'], ['review_queue', 'queue', '/queue']] as const) {
    if (can(perm)) { try { put(key, await api.get<any>(`${dsBase}${path}`)); } catch { put(key, null); } } }
    if (can('evaluate') && can('view_policy')) { try { put('stamp', (await api.get<any>(`/ocr-study/studies/${study.id}/policy?kind=synthetic_test`)).stamp); } catch { put('stamp', null); } } };
  useEffect(() => { void refreshDs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dsId, role]);
  const run = (fn: () => Promise<unknown>, ok: string) => act(async () => { await fn(); await loadStudy(study.id).then(() => undefined); setDsId(dsId); await refreshDs(); }, ok);

  const downloadReport = (runId: string) => act(async () => {
    const r = await fetch(`/api${dsBase}/evaluations/${enc(runId)}/export`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reauthBody()) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ocr-study-report-${runId}.json`; a.click(); setMsg({ kind: 'ok', text: `Exported; sha256 ${r.headers.get('X-Report-SHA256')}` });
  });

  const lockState = data.manifest?.lockState;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">OCR study workspaces</h1>
        <p role="note" data-testid="study-notice" className="text-sm font-semibold" style={{ color: '#f59e0b' }}>{NOTICE}</p>
        <p className="text-xs" style={muted}>Identity, tenant, study role and lock state come from the server. Annotators see only their own work; adjudicators see disagreements without annotator identities; nobody can mark a study accepted here.</p>
      </header>
      {reauthOn && study && (<GlassCard padding="md"><p className="text-xs" style={muted}>Sensitive actions (unlock authorization, member changes, severity labels, export) need a fresh sign-in or your password (re-authentication; this is not MFA). The password is sent only with the action and is never stored or logged.</p>
        <input type="password" autoComplete="current-password" className={box} placeholder="Password for sensitive actions" aria-label="Re-authentication password" value={f.reauth ?? ''} onChange={(e) => set('reauth', e.target.value)} /></GlassCard>)}
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h2 className="font-semibold">Storage</h2>
        {overview?.storage?.ready
          ? <p className="text-xs" style={muted} data-testid="storage-ready">Synthetic local adapter ready — {overview.storage.limitations.join('; ')}.</p>
          : <div data-testid="storage-unavailable" className="text-xs" style={{ color: '#f43f5e' }}><p>Study storage is NOT available (fails closed). Nothing can be created or read.</p><ul className="list-disc ml-5">{(overview?.storage?.reasons ?? ['status unavailable']).map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
      </GlassCard>

      {overview?.storage?.ready && (
        <GlassCard padding="md">
          <h2 className="font-semibold">Studies</h2>
          <div className="flex flex-wrap gap-2 mt-2 items-end">
            <input className={box} placeholder="Study name" aria-label="Study name" value={f.sname ?? ''} onChange={(e) => set('sname', e.target.value)} />
            <input className={box} placeholder="Purpose" aria-label="Study purpose" value={f.spurpose ?? ''} onChange={(e) => set('spurpose', e.target.value)} />
            <button className={btn} disabled={busy || !f.sname || !f.spurpose} onClick={() => act(async () => { const r: any = await api.post('/ocr-study/studies', { name: f.sname, purpose: f.spurpose }); await loadOverview(); await loadStudy(r.id); }, 'Study created; you are its study owner.')}>Create study</button>
          </div>
          <ul className="mt-3 space-y-1 text-sm">{(overview.studies ?? []).map((s: any) => <li key={s.id}><button className="underline" onClick={() => void loadStudy(s.id)} data-testid={`study-${s.id}`}>{s.name}</button> <span className="text-xs" style={muted}>— my role: {s.myRole}</span></li>)}</ul>
        </GlassCard>
      )}

      {study && (
        <GlassCard padding="md">
          <h2 className="font-semibold" data-testid="study-title">{study.name} <span className="text-xs" style={muted}>(my role: {study.myRole})</span></h2>
          <p className="text-xs" style={muted}>{study.purpose}</p>
          <h3 className="font-semibold mt-3 text-sm">Members</h3>
          <ul className="text-xs">{study.members.map((m: any) => <li key={m.userId}>{m.email ?? m.userId} — {m.studyRole}</li>)}</ul>
          {can('view_members') && (<div className="mt-2" data-testid="member-admin"><button className={btn} disabled={busy} onClick={() => act(async () => put('members', await api.get(`${base}/members`)))}>Manage members (status and history)</button>
            {data.members && (<div className="mt-2"><p className="text-xs font-semibold" style={{ color: '#f59e0b' }} data-testid="member-warning">{data.members.warning}</p>
              <input className={`${box} w-full my-1`} placeholder="Reason (required; only its hash and length are logged)" aria-label="Member change reason" value={f.mreason ?? ''} onChange={(e) => set('mreason', e.target.value)} />
              <ul className="text-xs space-y-1">{data.members.members.map((m: any) => { const two = data.members.twoPersonRoles.includes(m.studyRole); const mb = `${base}/members/${m.userId}`; const refresh = async () => { put('members', await api.get(`${base}/members`)); await loadStudy(study.id); };
                const pending = data.members.pendingActions.filter((a: any) => a.targetUserId === m.userId);
                return (<li key={m.userId}>{m.email ?? m.userId} — {m.studyRole} — <b>{m.status}</b>
                  {can('manage_members') && m.status === 'active' && !two && (<><button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/suspend`, { reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Member suspended; access revoked immediately.')}>Suspend</button><button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/remove`, { reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Member removed; history preserved.')}>Remove</button></>)}
                  {can('manage_members') && m.status === 'active' && two && pending.length === 0 && (<><button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/requests`, { action: 'suspend', reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Request created; a different study owner or clinical lead must approve.')}>Request suspension</button><button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/requests`, { action: 'remove', reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Request created; a different study owner or clinical lead must approve.')}>Request removal</button></>)}
                  {can('manage_members') && m.status === 'suspended' && (<button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/reinstate`, { reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Member reinstated.')}>Reinstate</button>)}
                  {pending.map((a: any) => (<span key={a.actionId} className="ml-2">[{a.action} {a.status} — requested by {a.requestedBy}]
                    {can('approve_member_action') && a.status === 'requested' && <button className={`${btn} ml-1`} disabled={busy || !f.mreason} onClick={() => act(async () => { await api.post(`${mb}/requests/${a.actionId}/approve`, { reason: f.mreason, ...reauthBody() }); await refresh(); }, 'Approved.')}>Approve</button>}
                    {can('manage_members') && a.status === 'approved' && <button className={`${btn} ml-1`} disabled={busy} onClick={() => act(async () => { await api.post(`${mb}/requests/${a.actionId}/execute`, reauthBody()); await refresh(); }, 'Executed; access revoked immediately.')}>Execute</button>}</span>))}
                </li>); })}</ul></div>)}</div>)}
          {can('manage_members') && (
            <div className="flex flex-wrap gap-2 mt-2 items-end">
              <input className={box} placeholder="Member email" aria-label="Member email" value={f.memail ?? ''} onChange={(e) => set('memail', e.target.value)} />
              <select className={box} aria-label="Study role" value={f.mrole ?? 'annotator'} onChange={(e) => set('mrole', e.target.value)}>{(overview?.roles ?? []).map((r: string) => <option key={r}>{r}</option>)}</select>
              <button className={btn} disabled={busy || !f.memail} onClick={() => run(() => api.post(`${base}/members`, { memberEmail: f.memail, studyRole: f.mrole ?? 'annotator' }), 'Member added (one role per user).')}>Add member</button>
            </div>)}
          {can('configure_severity') && (
            <div className="mt-3"><h3 className="font-semibold text-sm">Severity labels (descriptive; cannot accept a study)</h3>
              <textarea className={`${box} w-full font-mono`} rows={3} aria-label="Severity map JSON" placeholder='{"unit":"label","value":"label"}' value={f.sev ?? JSON.stringify(study.severityMap)} onChange={(e) => set('sev', e.target.value)} />
              <button className={btn} disabled={busy} onClick={() => run(() => api.put(`${base}/severity-map`, { map: parse('sev'), ...reauthBody() }), 'Severity labels saved.')}>Save labels</button></div>)}

          <h3 className="font-semibold mt-4 text-sm">Datasets</h3>
          <ul className="text-sm">{study.datasets.map((d: any) => <li key={d.datasetId}><button className="underline" onClick={() => { setDsId(d.datasetId); setData({}); }} data-testid={`dataset-${d.datasetId}`}>{d.name}</button> <span className="text-xs" style={muted}>— {d.split}, {d.provenanceKind}{d.assignedToMe ? ' — assigned to me' : ''}</span></li>)}</ul>
          {can('register_dataset') && (
            <div className="mt-2 space-y-2"><div className="flex flex-wrap gap-2 items-end">
              <input className={box} placeholder="Dataset name" aria-label="Dataset name" value={f.dname ?? ''} onChange={(e) => set('dname', e.target.value)} />
              <select className={box} aria-label="Split" value={f.dsplit ?? 'development'} onChange={(e) => set('dsplit', e.target.value)}><option>development</option><option>locked_validation</option><option>external_validation</option></select>
              <input className={box} placeholder="Annotator 1 email" aria-label="Annotator 1 email" value={f.a1 ?? ''} onChange={(e) => set('a1', e.target.value)} />
              <input className={box} placeholder="Annotator 2 email" aria-label="Annotator 2 email" value={f.a2 ?? ''} onChange={(e) => set('a2', e.target.value)} />
              <button className={btn} disabled={busy || !f.dname || !f.a1 || !f.a2} onClick={() => run(() => api.post(`${base}/datasets`, { name: f.dname, studyRef: 'SYNTHETIC-STUDY', provenanceKind: 'synthetic_fixture', split: f.dsplit ?? 'development', origin: 'synthetic sample', annotatorEmails: [f.a1, f.a2], sources: SYNTH_SOURCES }), 'Synthetic dataset registered (3 tiny synthetic documents).')}>Register synthetic sample dataset</button></div>
              <p className="text-xs" style={muted}>Only synthetic datasets are accepted: the available storage adapter has no encryption at rest, retention or access control.</p></div>)}
        </GlassCard>
      )}

      {study && ds && (
        <GlassCard padding="md">
          <h2 className="font-semibold" data-testid="dataset-title">Dataset: {ds.name} <span className="text-xs" style={muted}>({ds.split})</span></h2>
          {lockState && <p className="text-sm" data-testid="lock-state">Lock state (server-derived): <b>{lockState}</b>{data.manifest?.everUnlocked ? ' — this dataset has been unlocked before' : ''}</p>}
          {data.manifest && <p className="text-xs break-all" style={muted}>manifest sha256 {data.manifest.manifest.manifestSha256} · cases {data.manifest.manifest.cases.length} · annotation versions {data.manifest.manifest.annotations.length} · truth {data.manifest.manifest.truth ? `v${data.manifest.manifest.truth.version}` : 'not built'}</p>}

          {can('attest') && (<div className="mt-3"><h3 className="font-semibold text-sm">De-identification attestation</h3><p className="text-xs" style={muted}>A human-supplied record: it is recorded and hashed; this software cannot verify it.</p>
            <textarea className={`${box} w-full font-mono`} rows={4} aria-label="Attestation JSON" value={f.att ?? JSON.stringify(SYNTH_ATTESTATION, null, 1)} onChange={(e) => set('att', e.target.value)} />
            <div className="flex gap-2 mt-1"><button className={btn} disabled={busy} onClick={() => run(() => api.post(`${dsBase}/attestation`, { record: f.att ? parse('att') : SYNTH_ATTESTATION }), 'Attestation recorded.')}>Record attestation</button>
              <button className={btn} disabled={busy} onClick={() => run(() => api.post(`${dsBase}/manifest`, {}), 'Manifest generated.')}>Generate manifest</button></div></div>)}

          {can('verify') && (<div className="mt-3"><h3 className="font-semibold text-sm">Verify</h3>
            <p className="text-xs" style={muted}>A locked dataset is verified against a lock digest you supply from OUTSIDE this system. Anyone with write access to the study directory could rewrite the manifest and its hashes; only a digest recorded elsewhere (e.g. in the signed preregistration) gives independent custody.</p>
            <div className="flex gap-2 items-end"><input className={`${box} w-96 font-mono`} placeholder="expected lock digest (64 hex)" aria-label="Expected lock digest" value={f.digest ?? ''} onChange={(e) => set('digest', e.target.value)} />
              <button className={btn} disabled={busy} onClick={() => act(async () => put('verify', await api.post(`${dsBase}/verify`, f.digest ? { expectedLockDigest: f.digest } : {})), 'Verification ran.')}>Verify</button></div>
            {data.verify && <p className="text-xs mt-1" data-testid="verify-result" style={{ color: data.verify.ok ? '#10b981' : '#f43f5e' }}>{data.verify.ok ? 'Integrity checks passed' : `FAILED: ${data.verify.problems.join('; ')}`}</p>}</div>)}

          {can('list_cases') && data.cases && (<div className="mt-3"><h3 className="font-semibold text-sm">Cases ({data.cases.cases.length})</h3>
            <ul className="text-xs">{data.cases.cases.map((c: any) => <li key={c.caseId}>{c.caseId} — {c.pages} page(s), {c.mediaType}{' '}<a className="underline" href={`/api${dsBase}/cases/${c.caseId}/source`} download>download source</a></li>)}</ul></div>)}
          {can('import_annotations') && (<div className="mt-3"><h3 className="font-semibold text-sm">My annotations</h3><p className="text-xs" style={muted}>Each upload becomes a new immutable version attributed to you; you cannot see the other annotator's work. {data.mine ? `You have ${data.mine.versions.length} version(s).` : ''}</p>
            <textarea className={`${box} w-full font-mono`} rows={5} aria-label="Annotation file JSON" placeholder='{"schema":"anuclaw-ocr-annotator-file/v1","completedCaseIds":[…],"items":[…]}' value={f.ann ?? ''} onChange={(e) => set('ann', e.target.value)} />
            <button className={btn} disabled={busy || !f.ann} onClick={() => run(() => api.post(`${dsBase}/annotations`, { file: parse('ann') }), 'Annotation version imported.')}>Import annotations</button></div>)}

          {can('agreement_summary') && data.agreement && (<div className="mt-3"><h3 className="font-semibold text-sm">Agreement (aggregate only)</h3>
            <p className="text-xs" style={muted}>{data.agreement.summary.note}</p><table className="text-xs"><tbody>{data.agreement.summary.fields.map((x: any) => <tr key={x.field}><td className="pr-3">{x.field}</td><td>{x.agree}/{x.n}</td><td className="pl-3">{x.cohenKappa == null ? '—' : `κ ${x.cohenKappa.toFixed(2)}`}</td></tr>)}</tbody></table>
            <p className="text-xs" style={muted}>queue: {data.agreement.queue.open} open, {data.agreement.queue.resolved} resolved (item-level content is for adjudicators only)</p></div>)}

          {can('review_queue') && data.queue && (<div className="mt-3"><h3 className="font-semibold text-sm">Disagreement review ({data.queue.queue.filter((q: any) => q.status === 'open').length} open)</h3><p className="text-xs" style={muted}>{data.queue.blind}. Adjudication preserves both original annotations and never edits them.</p>
            <input className={`${box} w-full mb-2`} placeholder="Reason (required)" aria-label="Adjudication reason" value={f.reason ?? ''} onChange={(e) => set('reason', e.target.value)} />
            <table className="text-xs"><tbody>{data.queue.queue.map((q: any) => <tr key={q.id}><td className="pr-2">{q.caseId}</td><td className="pr-2">{q.field}</td><td className="pr-2">A: {JSON.stringify(q.A)}</td><td className="pr-2">B: {JSON.stringify(q.B)}</td><td>{q.status === 'open'
              ? (['A', 'B', 'ambiguous'] as const).map((s) => <button key={s} className={`${btn} mr-1`} disabled={busy || !f.reason} onClick={() => run(() => api.post(`${dsBase}/adjudications`, { queueId: q.id, source: s, reason: f.reason }), 'Adjudication recorded.')}>{s}</button>) : 'resolved'}</td></tr>)}</tbody></table></div>)}

          {(can('build_truth') || can('lock')) && (<div className="flex flex-wrap gap-2 mt-3">
            {can('build_truth') && <button className={btn} disabled={busy} onClick={() => run(() => api.post(`${dsBase}/truth`, {}), 'Adjudicated truth built.')}>Build adjudicated truth</button>}
            {can('lock') && <button className={btn} disabled={busy} onClick={() => act(async () => { const r: any = await api.post(`${dsBase}/lock`, {}); put('lockResult', r); await refreshDs(); }, 'Dataset locked.')}>Lock dataset</button>}</div>)}
          {data.lockResult && <p className="text-xs break-all" data-testid="lock-result" style={{ color: '#f59e0b' }}>Lock digest {data.lockResult.lockDigest} — RECORD THIS OUTSIDE this system now (e.g. in the signed preregistration). {data.lockResult.custody}</p>}

          {(can('request_unlock') || can('authorize_unlock') || can('execute_unlock')) && data.unlocks && (<div className="mt-3"><h3 className="font-semibold text-sm">Unlock (two different people; single-use)</h3>
            {can('request_unlock') && lockState === 'locked' && (<div className="flex gap-2 items-end"><input className={`${box} w-96`} placeholder="Reason for unlocking" aria-label="Unlock reason" value={f.ureason ?? ''} onChange={(e) => set('ureason', e.target.value)} /><button className={btn} disabled={busy || !f.ureason} onClick={() => run(() => api.post(`${dsBase}/unlock-requests`, { reason: f.ureason }), 'Unlock requested; a different user must authorize it.')}>Request unlock</button></div>)}
            <ul className="text-xs mt-2">{data.unlocks.requests.map((u: any) => <li key={u.requestId}>{u.requestId} — {u.status}{u.authorizedBy ? ` (authorized by ${u.authorizedBy})` : ''}{' '}
              {can('authorize_unlock') && u.status === 'requested' && <button className={btn} disabled={busy || !f.uref || !f.ucred || !f.urole || !f.ureason2} onClick={() => run(() => api.post(`${dsBase}/unlock-requests/${u.requestId}/authorize`, { reason: f.ureason2, protocolDeviationRef: f.uref, credentialRef: f.ucred, roleClaim: f.urole, ...reauthBody() }), 'Authorization recorded (single use).')}>Authorize</button>}
              {can('execute_unlock') && u.status === 'authorized' && <button className={btn} disabled={busy} onClick={() => run(() => api.post(`${dsBase}/unlock-requests/${u.requestId}/execute`, reauthBody()), 'Unlocked. The dataset is permanently marked as reopened.')}>Execute unlock</button>}</li>)}</ul>
            {can('authorize_unlock') && (<div className="grid grid-cols-2 gap-2 mt-1 max-w-xl"><input className={box} placeholder="Reason" aria-label="Authorization reason" value={f.ureason2 ?? ''} onChange={(e) => set('ureason2', e.target.value)} /><input className={box} placeholder="Protocol deviation ref" aria-label="Protocol deviation reference" value={f.uref ?? ''} onChange={(e) => set('uref', e.target.value)} /><input className={box} placeholder="Your credential reference" aria-label="Credential reference" value={f.ucred ?? ''} onChange={(e) => set('ucred', e.target.value)} /><input className={box} placeholder="Your role (as you state it)" aria-label="Role claim" value={f.urole ?? ''} onChange={(e) => set('urole', e.target.value)} /></div>)}</div>)}

          {can('evaluate') && (<div className="mt-3"><h3 className="font-semibold text-sm">Evaluation</h3><p className="text-xs" style={muted}>Development runs are allowed only on the development split. Locked runs need the dataset locked and the externally recorded lock digest. No acceptance decision is made.</p>
            <div className="flex flex-wrap gap-2 items-end"><input className={box} placeholder="Run id" aria-label="Run id" value={f.runId ?? ''} onChange={(e) => set('runId', e.target.value)} /><select className={box} aria-label="Mode" value={f.mode ?? 'development'} onChange={(e) => set('mode', e.target.value)}><option>development</option><option>locked</option></select>
              <input className={`${box} w-96 font-mono`} placeholder="expected lock digest (locked mode)" aria-label="Expected lock digest for evaluation" value={f.edigest ?? ''} onChange={(e) => set('edigest', e.target.value)} /></div>
            {data.stamp && <p className="text-xs break-all" style={muted} data-testid="policy-stamp">Policy stamp the extraction results must carry (synthetic test policy; locked runs refuse results without the matching stamp): {JSON.stringify(data.stamp)}</p>}
            <textarea className={`${box} w-full font-mono mt-1`} rows={4} aria-label="Extraction results JSON" placeholder='{"schema":"anuclaw-ocr-extraction/v1",…}' value={f.res ?? ''} onChange={(e) => set('res', e.target.value)} />
            <button className={btn} disabled={busy || !f.runId || !f.res} onClick={() => act(async () => { const r: any = await api.post(`${dsBase}/evaluations`, { runId: f.runId, mode: f.mode ?? 'development', results: parse('res'), ...((f.mode ?? 'development') === 'locked' ? { expectedLockDigest: f.edigest } : {}) }); put('lastReport', r); await refreshDs(); }, 'Evaluation recorded.')}>Run evaluation</button></div>)}
          {data.lastReport && <p className="text-xs break-all" data-testid="report-hash" style={muted}>report sha256 {data.lastReport.reportSha256} · silent errors {data.lastReport.report.silentErrors.length} · {data.lastReport.report.clinicalAcceptance.status}</p>}
          {can('export_report') && data.manifest?.manifest?.outputs?.length > 0 && (<div className="mt-2 text-xs"><b>Reports:</b> {data.manifest.manifest.outputs.map((o: any) => <button key={o.runId} className={`${btn} ml-2`} disabled={busy} onClick={() => void downloadReport(o.runId)}>Export {o.runId} ({o.mode})</button>)}</div>)}
        </GlassCard>
      )}

      {study && can('view_policy') && <OcrPolicyPanel studyId={study.id} can={can} reauth={reauthBody} />}
      {study && can('view_audit') && (
        <GlassCard padding="md"><h2 className="font-semibold">Audit</h2><p className="text-xs" style={muted}>Identifiers, hashes and counts only — never document or annotation content.</p>
          <button className={btn} disabled={busy} onClick={() => act(async () => put('audit', await api.get(`${base}/audit`)))}>Load audit events</button>
          {data.audit && <><p className="text-xs" style={muted}>file-store chain: {data.audit.fileStoreChain.ok ? `ok (${data.audit.fileStoreChain.entries} entries)` : 'BROKEN'}</p><table className="text-xs" data-testid="audit-table"><tbody>{data.audit.events.slice(0, 100).map((e: any, i: number) => <tr key={i}><td className="pr-2">{new Date(e.ts).toISOString()}</td><td className="pr-2">{e.action}</td><td className="pr-2">{e.actor}</td><td>{JSON.stringify(e.meta)}</td></tr>)}</tbody></table></>}</GlassCard>)}
      <p className="text-xs" style={muted} data-testid="study-notice-footer">{NOTICE}</p>
    </div>
  );
}
