import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { GlassCard } from '../components/GlassCard';
import { EvidenceWorkspace } from '../components/research-studio/EvidenceWorkspace';
import { ConnectorStatus } from '../components/research-studio/ConnectorStatus';
import { ManuscriptWorkspace } from '../components/research-studio/ManuscriptWorkspace';
import { VisualsAndExport } from '../components/research-studio/VisualsAndExport';

/**
 * ANUClaw Research Studio — M1 foundation only: durable projects and task graphs, and ONE real agent (Research Planner).
 * No literature search, browser automation, writing, critique or export agent exists yet. A queued task of one of those
 * types has no agent and will not advance — this page shows that honestly ("no agent yet") rather than hiding it or
 * inventing progress. See docs/RESEARCH-STUDIO-PLAN.md for exactly what is and is not implemented.
 */
const NOTICE = 'M1-M6: durable task-graph engine, evidence graph, a local simulated browser harness (no real AI-provider automation), manuscript/thesis authoring (deterministic — no model-generated prose), real visuals (conceptual diagrams and data-derived charts from verified runs — never invented numbers), and real exports (Markdown/BibTeX/RIS/LaTeX-source/PDF/DOCX). Nothing here is a validated manuscript, a completed review, journal acceptance, or a clinical/academic approval. Every section, citation, figure and export reflects the CURRENT review state only and requires human confirmation before any external, academic or clinical use — see docs/RESEARCH-STUDIO-RELEASE-HANDOFF.md for the exact boundary of what is and is not production-ready.';
const box = 'rounded-lg border px-3 py-2 text-sm bg-transparent';
const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const STATUS_COLOR: Record<string, string> = {
  queued: '#8a94a6', running: '#3b82f6', awaiting_user: '#f59e0b', paused: '#f59e0b',
  retryable_failure: '#f59e0b', failed: '#f43f5e', cancelled: '#8a94a6', completed: '#10b981',
};

export default function ResearchStudio() {
  const [projects, setProjects] = useState<any[]>([]);
  const [modes, setModes] = useState<string[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [graph, setGraph] = useState<any[]>([]);
  const [events, setEvents] = useState<{ events: any[]; chain: any } | null>(null);
  const [f, setF] = useState<Record<string, string>>({ mode: 'research_protocol', title: '', topic: '', question: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  const loadProjects = useCallback(async () => {
    const info = await api.get<any>('/research-studio');
    setModes(info.modes ?? []);
    const { projects: ps } = await api.get<any>('/research-studio/projects');
    setProjects(ps ?? []);
  }, []);
  useEffect(() => { void loadProjects().catch(() => setProjects([])); }, [loadProjects]);

  const openProject = useCallback(async (id: string) => {
    const { project, graph: g } = await api.get<any>(`/research-studio/projects/${id}`);
    setSel(project); setGraph(g ?? []); setEvents(null);
  }, []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const createProject = () => act(async () => {
    const brief: Record<string, unknown> = { topic: f.topic, question: f.question };
    if (f.hasData) brief.hasData = f.hasData === 'true';
    if (f.searchMethod) brief.searchMethod = f.searchMethod;
    if (f.screeningMethod) brief.screeningMethod = f.screeningMethod;
    if (f.institution) brief.institution = f.institution;
    if (f.chapterOutline) brief.chapterOutline = f.chapterOutline.split(',').map((s) => s.trim()).filter(Boolean);
    if (f.dataPermissionsStatement) brief.dataPermissions = { authorized: f.dataPermissionsAuthorized === 'true', statement: f.dataPermissionsStatement };
    const res = await api.post<any>('/research-studio/projects', { mode: f.mode, title: f.title, brief });
    await loadProjects(); setSel(res.project); setGraph(res.graph ?? []);
  }, 'Project created; the Research Planner ran and produced the initial task graph.');

  const [refreshKey, setRefreshKey] = useState(0);
  const advance = (id: string) => act(async () => {
    const res = await api.post<any>(`/research-studio/projects/${id}/advance`, { maxSteps: 50 });
    setGraph(res.graph ?? []); setRefreshKey((k) => k + 1); // remounts EvidenceWorkspace/ManuscriptWorkspace so their own fetched state (sources, sections, …) is not left stale after tasks just ran
  }, 'Advanced as far as currently-implemented agents allow.');

  const loadEvents = (id: string) => act(async () => { setEvents(await api.get<any>(`/research-studio/projects/${id}/events`)); }, 'Event chain verified.');

  const ACTION_PAST: Record<'pause' | 'resume' | 'cancel', string> = { pause: 'paused', resume: 'resumed', cancel: 'cancelled' };
  const taskAction = (taskId: string, action: 'pause' | 'resume' | 'cancel') => act(async () => {
    await api.post(`/research-studio/tasks/${taskId}/${action}`, action === 'cancel' ? { reason: 'cancelled from dashboard' } : {});
    if (sel) await openProject(sel.id);
  }, `Task ${ACTION_PAST[action]}.`);

  const unimplementedCount = graph.filter((t) => !t.agentAvailable).length;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Research Studio</h1>
        <p role="note" data-testid="research-studio-notice" className="text-sm font-semibold" style={{ color: '#f59e0b' }}>{NOTICE}</p>
      </header>
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <ConnectorStatus />

      <GlassCard padding="md">
        <h2 className="font-semibold">New project</h2>
        <div className="grid grid-cols-2 gap-2 mt-2 max-w-3xl">
          <select className={box} aria-label="mode" value={f.mode} onChange={(e) => set('mode', e.target.value)}>
            {modes.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input className={box} placeholder="Project title" aria-label="title" value={f.title} onChange={(e) => set('title', e.target.value)} />
          <input className={box} placeholder="Topic" aria-label="topic" value={f.topic} onChange={(e) => set('topic', e.target.value)} />
          <input className={box} placeholder="Research question" aria-label="question" value={f.question} onChange={(e) => set('question', e.target.value)} />
          {['narrative_review', 'systematic_review', 'scoping_review'].includes(f.mode) && (
            <input className={box} placeholder="Actual search method (required)" aria-label="searchMethod" value={f.searchMethod ?? ''} onChange={(e) => set('searchMethod', e.target.value)} />
          )}
          {['systematic_review', 'scoping_review'].includes(f.mode) && (
            <input className={box} placeholder="Screening method (required)" aria-label="screeningMethod" value={f.screeningMethod ?? ''} onChange={(e) => set('screeningMethod', e.target.value)} />
          )}
          {f.mode === 'original_research' && (
            <select className={box} aria-label="hasData" value={f.hasData ?? ''} onChange={(e) => set('hasData', e.target.value)}>
              <option value="">Has actual data/results? (required)</option>
              <option value="true">Yes — data exists</option>
              <option value="false">No — not yet (results-drafting will be withheld)</option>
            </select>
          )}
          {f.mode === 'case_report' && (
            <>
              <select className={box} aria-label="dataPermissionsAuthorized" value={f.dataPermissionsAuthorized ?? ''} onChange={(e) => set('dataPermissionsAuthorized', e.target.value)}>
                <option value="">Data permissions authorised?</option><option value="true">Yes</option><option value="false">No</option>
              </select>
              <input className={box} placeholder="Data-permissions statement (required)" aria-label="dataPermissionsStatement" value={f.dataPermissionsStatement ?? ''} onChange={(e) => set('dataPermissionsStatement', e.target.value)} />
            </>
          )}
          {f.mode === 'dissertation' && (
            <>
              <input className={box} placeholder="Institution (required)" aria-label="institution" value={f.institution ?? ''} onChange={(e) => set('institution', e.target.value)} />
              <input className={box} placeholder="Chapter outline, comma-separated (required)" aria-label="chapterOutline" value={f.chapterOutline ?? ''} onChange={(e) => set('chapterOutline', e.target.value)} />
            </>
          )}
        </div>
        <button className={`${btn} mt-3`} disabled={busy || !f.title || !f.topic || !f.question} onClick={createProject}>Create project</button>
      </GlassCard>

      <GlassCard padding="md">
        <h2 className="font-semibold">Projects</h2>
        <table className="text-xs w-full mt-2" data-testid="research-studio-projects"><thead><tr className="text-left"><th>Title</th><th>Mode</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{projects.map((p) => (
            <tr key={p.id} className="align-top"><td><button className="underline" onClick={() => openProject(p.id)}>{p.title}</button></td>
              <td>{p.mode}</td><td>{p.status}</td><td>{new Date(p.created_at).toLocaleString()}</td></tr>
          ))}</tbody>
        </table>
      </GlassCard>

      {sel && (
        <GlassCard padding="md">
          <h2 className="font-semibold">{sel.title} — task graph</h2>
          <p className="text-xs" style={muted}>{unimplementedCount} of {graph.length} task(s) have no registered agent yet and will stay queued until that agent is built — this is reported honestly, not hidden.</p>
          <div className="flex gap-2 my-2">
            <button className={btn} disabled={busy} onClick={() => advance(sel.id)}>Advance now</button>
            <button className={btn} disabled={busy} onClick={() => loadEvents(sel.id)}>Verify event chain</button>
          </div>
          <table className="text-xs w-full" data-testid="research-studio-graph"><thead><tr className="text-left"><th>Type</th><th>Status</th><th>Agent</th><th>Depends on</th><th>Actions</th></tr></thead>
            <tbody>{graph.map((t) => (
              <tr key={t.id} className="align-top">
                <td>{t.type}</td>
                <td style={{ color: STATUS_COLOR[t.status] ?? undefined }}>{t.status}{t.invalidated_at ? ' (invalidated)' : ''}</td>
                <td>{t.agentAvailable ? 'available' : <span style={{ color: '#f59e0b' }}>no agent yet</span>}</td>
                <td>{(JSON.parse(t.depends_on_json) as string[]).length}</td>
                <td className="flex gap-1">
                  {['queued', 'running', 'retryable_failure', 'awaiting_user'].includes(t.status) && <button className={btn} disabled={busy} onClick={() => taskAction(t.id, 'pause')}>Pause</button>}
                  {t.status === 'paused' && <button className={btn} disabled={busy} onClick={() => taskAction(t.id, 'resume')}>Resume</button>}
                  {!['failed', 'cancelled', 'completed'].includes(t.status) && <button className={btn} disabled={busy} onClick={() => taskAction(t.id, 'cancel')}>Cancel</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {events && (
            <div className="mt-3">
              <p className="text-xs" style={{ color: events.chain.ok ? '#10b981' : '#f43f5e' }}>Event chain: {events.chain.ok ? `verified, ${events.chain.entries} entries` : `TAMPERED at seq ${events.chain.brokenAtSeq}`}</p>
              <ul className="text-xs" style={muted}>{events.events.slice(-10).map((e: any) => <li key={e.id}>#{e.seq} {e.event}</li>)}</ul>
            </div>
          )}
        </GlassCard>
      )}
      {sel && <EvidenceWorkspace key={`ev-${sel.id}-${refreshKey}`} projectId={sel.id} />}
      {sel && <ManuscriptWorkspace key={`ms-${sel.id}-${refreshKey}`} projectId={sel.id} />}
      {sel && <VisualsAndExport key={`ve-${sel.id}-${refreshKey}`} projectId={sel.id} />}
      <p className="text-xs" style={muted} data-testid="research-studio-notice-footer">{NOTICE}</p>
    </div>
  );
}
