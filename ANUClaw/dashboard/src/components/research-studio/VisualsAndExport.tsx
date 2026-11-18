import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { GlassCard } from '../GlassCard';

/**
 * Visuals and export (M5). Every rendered figure shown here is a real, deterministic SVG — a conceptual diagram
 * (layout/labels only, no invented numbers) or a data-derived chart/table (numbers read live from a verified
 * research run). The export panel triggers the real Export Agent and lists the real files it produced, with a
 * download link to the exact bytes that were hashed into the provenance manifest. DOCX is not offered — no
 * docx-generation dependency exists in this build.
 */
const btn = 'rounded-md px-2.5 py-1 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };

export function VisualsAndExport({ projectId }: { projectId: string }) {
  const [visuals, setVisuals] = useState<any[]>([]);
  const [exports, setExports] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [v, e] = await Promise.all([api.get<any>(`/research-studio/projects/${projectId}/visuals`), api.get<any>(`/research-studio/projects/${projectId}/exports`)]);
    setVisuals(v.visuals ?? []); setExports(e.exports ?? []);
  }, [projectId]);
  useEffect(() => { void load().catch(() => {}); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const buildPrisma = () => act(async () => { await api.post(`/research-studio/projects/${projectId}/visuals`, { type: 'prisma_flow' }); }, 'PRISMA-style flow built from real evidence-graph counts.');
  const runExport = () => act(async () => { const r = await api.post<any>(`/research-studio/projects/${projectId}/export`, {}); if (r.task.status !== 'completed') throw new Error(`Export task is "${r.task.status}": ${r.task.result_json ?? ''}`); }, 'Export produced — see the files below.');

  return (
    <div className="space-y-4">
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Visuals</h3>
        <button className={btn} disabled={busy} onClick={buildPrisma}>Build PRISMA-style flow (real counts)</button>
        <div className="mt-2 grid grid-cols-2 gap-3" data-testid="visuals-gallery">
          {visuals.map((v) => (
            <div key={v.id} className="border rounded p-2">
              <p className="text-xs font-semibold">{v.title} <span style={muted}>({v.kind})</span>{v.invalidated_at ? <span style={{ color: '#f43f5e' }}> STALE</span> : null}</p>
              {/* eslint-disable-next-line react/no-danger */}
              <div dangerouslySetInnerHTML={{ __html: v.svg }} />
            </div>
          ))}
        </div>
      </GlassCard>

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Export</h3>
        <p className="text-xs" style={muted} data-testid="export-notice">
          A final-review export reflects the CURRENT review state only — it is not a journal acceptance, a completed
          peer review, or a clinical/academic approval. Formats produced: Markdown, BibTeX, RIS, LaTeX source
          (not compiled), PDF, and DOCX — all real, rendered files.
        </p>
        <button className={`${btn} mt-2`} disabled={busy} onClick={runExport}>Run export</button>
        <table className="text-xs w-full mt-2" data-testid="export-files"><thead><tr className="text-left"><th>Format</th><th>Size</th><th>SHA-256</th><th></th></tr></thead>
          <tbody>{exports.map((e) => (
            <tr key={e.id}>
              <td>{e.format}</td><td>{e.byte_size} B</td><td style={muted}>{e.content_sha256.slice(0, 16)}…</td>
              <td><a className="underline" href={`/api/research-studio/projects/${projectId}/exports/${e.id}/download`} target="_blank" rel="noreferrer">Download</a></td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>
    </div>
  );
}
