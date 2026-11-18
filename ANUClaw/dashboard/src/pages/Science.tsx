import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';

/**
 * Public scientific data (AlphaFold DB, RCSB PDB, NCBI Datasets, GEO) — RESEARCH ONLY.
 * Flow: search or enter an accession → inspect metadata and classification → retrieve selected files → inspect provenance →
 * attach to a workspace → export a manifest. A successful download proves nothing about any model or clinical use.
 */
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const CLASS_COLOR: Record<string, string> = { experimental: '#10b981', predicted: '#f59e0b', author_supplied: '#60a5fa', curated_reference: '#a78bfa', metadata_only: '#8a94a6' };

function Badge({ c }: { c: string }) {
  return <span data-testid="classification" className="text-xs font-semibold rounded px-2 py-0.5 border" style={{ color: CLASS_COLOR[c] ?? '#8a94a6', borderColor: CLASS_COLOR[c] ?? '#8a94a6' }}>{c}</span>;
}

export default function Science() {
  const [cat, setCat] = useState<any>(null);
  const [provider, setProvider] = useState('alphafold');
  const [text, setText] = useState('');
  const [results, setResults] = useState<any[] | null>(null);
  const [rec, setRec] = useState<any>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [got, setGot] = useState<any>(null);
  const [source, setSource] = useState<any>(null);
  const [wss, setWss] = useState<any[]>([]);
  const [wsId, setWsId] = useState('');
  const [ws, setWs] = useState<any>(null);
  const [wsForm, setWsForm] = useState({ name: '', purpose: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };
  const loadWss = useCallback(async () => { setWss((await api.get<any>('/science/workspaces')).workspaces); }, []);
  const loadWs = useCallback(async (id: string) => { setWsId(id); setWs(id ? await api.get<any>(`/science/workspaces/${id}`) : null); }, []);
  useEffect(() => { api.get<any>('/science').then(setCat).catch(() => setCat(null)); void loadWss().catch(() => {}); }, [loadWss]);

  const info = cat?.providers?.find((p: any) => p.id === provider);
  const describe = (accession: string) => act(async () => {
    const d = await api.post<any>('/science/describe', { provider, accession }); setRec(d); setPicked([]); setGot(null);
  }, 'Record loaded.');
  const isAccession = info && new RegExp(info.accessionPattern, 'i').test(text.trim());

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Public scientific data</h1>
        <p className="text-sm" style={muted} data-testid="science-notice">{cat?.notice ?? 'Research-only reference data.'}</p>
      </header>
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h2 className="font-semibold">1 · Search or enter an accession</h2>
        <div className="flex flex-wrap gap-2 mt-2 items-end">
          <select className={box} value={provider} onChange={(e) => { setProvider(e.target.value); setRec(null); setResults(null); setGot(null); }} aria-label="Provider">
            {(cat?.providers ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name.split(' (')[0]}</option>)}
          </select>
          <input className={`${box} flex-1 min-w-[16rem]`} value={text} onChange={(e) => setText(e.target.value)} placeholder={info ? `Accession (e.g. ${info.accessionExample})${info.searchable ? ' or search text' : ''}` : ''} aria-label="Accession or search text" />
          <button className={btn} disabled={busy || !text.trim() || !isAccession} onClick={() => describe(text.trim())}>Inspect accession</button>
          <button className={btn} disabled={busy || !text.trim() || !info?.searchable} onClick={() => act(async () => { setResults((await api.post<any>('/science/search', { provider, query: text.trim() })).results); }, 'Search done.')}>Search</button>
        </div>
        {info && <p className="text-xs mt-2" style={muted}>{info.restrictions} Licence: {info.license}. {info.searchable ? 'Search text is sent to the public provider: never include patient identifiers.' : ''}</p>}
        {results && (
          <ul className="mt-3 text-sm space-y-1" data-testid="search-results">
            {results.length === 0 && <li style={muted}>No results.</li>}
            {results.map((r: any) => <li key={r.accession}><button className="underline" onClick={() => { setText(r.accession); void describe(r.accession); }}>{r.accession}</button> {r.title ?? r.organism ?? ''}</li>)}
          </ul>
        )}
      </GlassCard>

      {rec && (
        <GlassCard padding="md">
          <h2 className="font-semibold">2 · Record <span data-testid="record-accession">{rec.accession}</span> <Badge c={rec.classification} /></h2>
          <p className="text-sm">{rec.title}</p>
          <p className="text-xs mt-1" style={{ color: '#f59e0b' }} data-testid="classification-note">{rec.classificationNote}</p>
          <p className="text-xs" style={muted}>Version: {rec.sourceVersion} · Licence: {rec.license} · <a className="underline" href={rec.termsUrl} target="_blank" rel="noreferrer noopener">terms</a></p>
          <pre className="text-xs mt-2 whitespace-pre-wrap rounded p-2" style={{ background: 'rgba(127,127,127,.08)', maxHeight: 220, overflow: 'auto' }} data-testid="record-metadata">{JSON.stringify(rec.metadata, null, 2)}</pre>
          {rec.warnings?.length > 0 && <ul className="text-xs mt-1" style={{ color: '#f59e0b' }}>{rec.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
          {rec.refused?.length > 0 && <ul className="text-xs mt-1" style={{ color: '#f43f5e' }} data-testid="refused">{rec.refused.map((r: any) => <li key={r.key}>Not available: {r.reason}</li>)}</ul>}
          <h3 className="font-semibold mt-3 text-sm">3 · Files</h3>
          <ul className="text-sm space-y-1" data-testid="file-list">
            {rec.files.map((f: any) => (
              <li key={f.key}><label><input type="checkbox" checked={picked.includes(f.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, f.key] : picked.filter((k) => k !== f.key))} aria-label={`File ${f.key}`} /> {f.label} <Badge c={f.classification} /> <span className="text-xs" style={muted}>{f.format}</span></label></li>
            ))}
            {rec.files.length === 0 && <li style={muted}>No retrievable files.</li>}
          </ul>
          <button className={`${btn} mt-2`} disabled={busy || picked.length === 0} onClick={() => act(async () => { setGot(await api.post<any>('/science/retrieve', { provider, accession: rec.accession, files: picked })); }, 'Retrieved.')}>Retrieve selected files</button>
        </GlassCard>
      )}

      {got && (
        <GlassCard padding="md">
          <h2 className="font-semibold">4 · Provenance of what was stored</h2>
          {got.problems?.length > 0 && <ul className="text-xs" style={{ color: '#f43f5e' }} data-testid="problems">{got.problems.map((p: any) => <li key={p.key}>{p.key}: {p.code} — {p.message}</li>)}</ul>}
          <table className="w-full text-xs mt-2" data-testid="provenance-table"><thead><tr className="text-left" style={muted}><th>File</th><th>Class</th><th>Version</th><th>SHA-256</th><th>Bytes</th><th>Retrieved</th><th /></tr></thead>
            <tbody>{got.sources.map((s: any) => (
              <tr key={s.id}><td>{s.memberPath ?? s.format}</td><td><Badge c={s.classification} /></td><td>{s.sourceVersion}</td><td title={s.sha256}>{s.sha256.slice(0, 12)}…</td><td>{s.bytes}</td><td>{new Date(s.retrievedAt).toISOString()}</td>
                <td><button className="underline" onClick={() => act(async () => { setSource(await api.get<any>(`/science/sources/${s.id}`)); })}>inspect</button></td></tr>))}</tbody></table>
        </GlassCard>
      )}

      {source && (
        <GlassCard padding="md">
          <h2 className="font-semibold">Source detail · integrity <span data-testid="integrity" style={{ color: source.integrity === 'ok' ? '#10b981' : '#f43f5e' }}>{source.integrity}</span></h2>
          <p className="text-xs" style={muted}>{source.source.sourceUrl} · {source.source.license} · {source.source.attribution}</p>
          <p className="text-xs" style={{ color: '#f59e0b' }}>{source.source.classificationNote}</p>
          {source.derived.map((d: any, i: number) => (
            <div key={i}><p className="text-xs font-semibold mt-2">Derived summary ({d.parser}, {d.parserVersion}) — {d.status} <span style={muted}>(kept separately from the source file)</span></p>
              <pre className="text-xs whitespace-pre-wrap rounded p-2" style={{ background: 'rgba(127,127,127,.08)', maxHeight: 220, overflow: 'auto' }} data-testid="derived-summary">{JSON.stringify(d.summary, null, 2)}</pre></div>))}
          <div className="flex gap-2 mt-2 items-end flex-wrap">
            <select className={box} value={wsId} onChange={(e) => void loadWs(e.target.value)} aria-label="Workspace"><option value="">Workspace…</option>{wss.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.items} items</option>)}</select>
            <button className={btn} disabled={busy || !wsId} onClick={() => act(async () => { await api.post(`/science/workspaces/${wsId}/items`, { sourceId: source.source.id }); await loadWs(wsId); await loadWss(); }, 'Attached (pinned to this exact version).')}>Attach to workspace</button>
          </div>
        </GlassCard>
      )}

      <GlassCard padding="md">
        <h2 className="font-semibold">5 · Research workspaces</h2>
        <form className="flex flex-wrap gap-2 mt-2 items-end" onSubmit={(e) => { e.preventDefault(); void act(async () => { const w = await api.post<any>('/science/workspaces', wsForm); await loadWss(); await loadWs(w.id); setWsForm({ name: '', purpose: '' }); }, 'Workspace created.'); }}>
          <input className={box} placeholder="Name" value={wsForm.name} onChange={(e) => setWsForm({ ...wsForm, name: e.target.value })} required aria-label="Workspace name" />
          <input className={box} placeholder="Purpose (required)" value={wsForm.purpose} onChange={(e) => setWsForm({ ...wsForm, purpose: e.target.value })} required aria-label="Workspace purpose" />
          <button className={btn} disabled={busy}>Create workspace</button>
        </form>
        {ws && (
          <div className="mt-3" data-testid="workspace-detail">
            <p className="text-sm font-semibold">{ws.name} <span className="text-xs" style={muted}>— {ws.purpose}</span></p>
            <ul className="text-xs mt-1">{ws.items.map((i: any) => <li key={i.itemId}>{i.label} · {i.source.provider}:{i.source.accession} · v{i.source.sourceVersion} · <Badge c={i.source.classification} /> · {i.source.sha256.slice(0, 12)}…</li>)}{ws.items.length === 0 && <li style={muted}>No items yet.</li>}</ul>
            <a className={`${btn} inline-block mt-2`} data-testid="manifest-link" href={`/api/science/workspaces/${ws.id}/manifest`}>Export manifest (JSON)</a>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
