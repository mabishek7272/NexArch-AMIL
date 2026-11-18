import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/** Research workspace: governed datasets, registered analyses, reproducible runs. Research-only; clinical claims prohibited. */
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };

export default function Research() {
  const [info, setInfo] = useState<any>(null);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [analysis, setAnalysis] = useState('descriptive');
  const [params, setParams] = useState('{}');
  const [ack, setAck] = useState(false);
  const [run, setRun] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attest, setAttest] = useState({ deidentified: false, authorised: false, statement: '' });

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };
  const load = useCallback(async () => { setDatasets((await api.get<any>('/research/datasets')).datasets); }, []);
  useEffect(() => { api.get<any>('/research').then(setInfo).catch(() => setInfo(null)); void load().catch(() => {}); }, [load]);

  async function upload(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const formEl = ev.currentTarget;
    const fd = new FormData(formEl);
    const file = fd.get('file') as File;
    const header = (await file.text()).split(/\r?\n/)[0].split(',').map((h) => h.trim());
    const dict: Record<string, string> = {};
    for (const h of header) dict[h] = (fd.get(`dict:${h}`) as string) || '';
    fd.append('dictionary', JSON.stringify(dict));
    fd.append('attestation', JSON.stringify(attest));
    await act(async () => {
      const r = await fetch('/api/research/datasets', { method: 'POST', credentials: 'include', body: fd });
      const body = await r.json(); if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      await load(); setDatasetId(body.datasetId);
    }, 'Dataset registered.');
  }
  const [header, setHeader] = useState<string[]>([]);
  const gated = info?.analyses?.find((a: any) => a.id === analysis)?.gated;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Research workspace</h1>
        <p className="text-sm" style={muted} data-testid="research-purpose">{info?.purpose ?? 'Loading…'}</p>
      </header>
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h2 className="font-semibold">Register a dataset (de-identified or synthetic CSV)</h2>
        <form className="space-y-2 mt-2" onSubmit={upload}>
          <input type="file" name="file" accept=".csv,text/csv" required aria-label="CSV file" onChange={async (e) => { const f = e.target.files?.[0]; setHeader(f ? (await f.text()).split(/\r?\n/)[0].split(',').map((h) => h.trim()) : []); }} />
          <div className="flex flex-wrap gap-2">
            <input name="name" className={box} placeholder="Name" required aria-label="Dataset name" />
            <input name="purpose" className={box} placeholder="Purpose of use (required)" required aria-label="Purpose" />
          </div>
          {header.length > 0 && <div className="grid grid-cols-2 gap-2">{header.map((h) => <input key={h} name={`dict:${h}`} className={box} placeholder={`Describe column "${h}"`} required aria-label={`Dictionary ${h}`} />)}</div>}
          <label className="text-xs block"><input type="checkbox" checked={attest.deidentified} onChange={(e) => setAttest({ ...attest, deidentified: e.target.checked })} /> The data is de-identified or synthetic</label>
          <label className="text-xs block"><input type="checkbox" checked={attest.authorised} onChange={(e) => setAttest({ ...attest, authorised: e.target.checked })} /> I am authorised to analyse it</label>
          <input className={`${box} w-full`} placeholder="Attestation statement (≥ 10 chars)" value={attest.statement} onChange={(e) => setAttest({ ...attest, statement: e.target.value })} aria-label="Attestation statement" />
          <button className={btn} disabled={busy}>Register dataset</button>
        </form>
      </GlassCard>

      <GlassCard padding="md">
        <h2 className="font-semibold">Run a registered analysis</h2>
        <div className="flex flex-wrap gap-2 mt-2">
          <select className={box} value={datasetId} onChange={(e) => setDatasetId(e.target.value)} aria-label="Dataset"><option value="">Dataset…</option>{datasets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.n_rows} rows</option>)}</select>
          <select className={box} value={analysis} onChange={(e) => setAnalysis(e.target.value)} aria-label="Analysis">{(info?.analyses ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.id}{a.gated ? ' (gated)' : ''}</option>)}</select>
        </div>
        <textarea className={`${box} w-full mt-2 font-mono`} rows={3} value={params} onChange={(e) => setParams(e.target.value)} aria-label="Parameters JSON" />
        {gated && <label className="text-xs block mt-1" style={{ color: '#f59e0b' }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="ack-research-only" /> I acknowledge this analysis is research-only: outputs are unvalidated and may not support clinical claims.</label>}
        <button className={`${btn} mt-2`} disabled={busy || !datasetId} onClick={() => act(async () => {
          let p: unknown; try { p = JSON.parse(params); } catch { throw new Error('Parameters must be valid JSON.'); }
          setRun(await api.post(`/research/datasets/${datasetId}/runs`, { analysis, params: p, acknowledgeResearchOnly: ack }));
        }, 'Run recorded.')}>Run</button>
      </GlassCard>

      {run && (
        <GlassCard padding="md">
          <p role="status" className="text-xs font-semibold" style={{ color: '#f59e0b' }} data-testid="research-label">{run.output?.validation?.status} · clinical claims: {run.output?.validation?.clinicalClaims} · class: {run.output?.class}</p>
          <p className="text-xs" style={muted}>Run {run.runId} · output sha256 {String(run.outputSha256).slice(0, 16)}…</p>
          {run.output?.warnings?.length > 0 && <ul className="text-xs mt-1" style={{ color: '#f59e0b' }}>{run.output.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
          <pre className="text-xs mt-2 whitespace-pre-wrap rounded p-2" style={{ background: 'rgba(127,127,127,.08)', maxHeight: 360, overflow: 'auto' }} data-testid="run-output">{JSON.stringify(run.output?.results, null, 2)}</pre>
          <p className="text-xs mt-2" style={muted}>Not assessed: {(run.output?.notAssessed ?? []).join('; ')}</p>
          <div className="flex gap-2 mt-2">
            <button className={btn} disabled={busy} onClick={() => act(async () => { const r = await api.post<any>(`/research/runs/${run.runId}/rerun`, {}); setMsg({ kind: r.reproduced ? 'ok' : 'err', text: r.reproduced ? 'Re-run reproduced the identical output hash.' : 'Re-run did NOT reproduce the output.' }); })}>Re-run (reproducibility)</button>
            <a className={btn} href={`/api/research/runs/${run.runId}/artifact.json`}>Download artifact</a>
          </div>
        </GlassCard>
      )}
    </div>
  );
}
