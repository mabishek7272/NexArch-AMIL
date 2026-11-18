import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Upload, Plus, Check, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, WorkspaceBar, NotAvailableYet, Drawer, useNarrow, SR_ONLY } from '../ui';

const TASK_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'neutral'> = {
  completed: 'green', running: 'blue', awaiting_user: 'amber', paused: 'amber',
  retryable_failure: 'amber', failed: 'red', cancelled: 'neutral', queued: 'neutral',
};

/**
 * Research Studio — screens 02 (full) and 04 (responsive/collapsed). Below 1180px the provenance
 * inspector becomes an overlay Drawer instead of a fixed right column, matching screen 04's
 * "icon rail, collapsed stage rail, inspector as drawer" note. Stage rail shows the REAL task graph
 * (task type + real status) rather than the mockup's fixed "9 numbered stages" — this project's graph
 * is a DAG of typed tasks, not a fixed linear 9-step sequence, so that's the honest substitution.
 */
export default function ResearchStudioPage() {
  const [params] = useSearchParams();
  const [projects, setProjects] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [graph, setGraph] = useState<any[]>([]);
  const [sources, setSources] = useState<any[] | null>(null);
  const [claimRows, setClaimRows] = useState<Array<{ claimId: string; statement: string; overallStatus: string }> | null>(null);
  const [activeSource, setActiveSource] = useState<any>(null);
  const [sourceDetail, setSourceDetail] = useState<any>(null);
  const narrow = useNarrow(1180);
  /** The row that opened the provenance drawer, so closing it can return focus there. */
  const drawerTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    api.get<any>('/research-studio/projects').then((r) => {
      const ps = r.projects ?? [];
      setProjects(ps);
      const wanted = params.get('project');
      setSel(ps.find((p: any) => p.id === wanted) ?? ps[0] ?? null);
    }).catch(() => setProjects([]));
  }, [params]);

  useEffect(() => {
    if (!sel?.id) return;
    api.get<any>(`/research-studio/projects/${sel.id}`).then((r) => setGraph(r.graph ?? [])).catch(() => setGraph([]));
    api.get<any>(`/research-studio/projects/${sel.id}/sources`).then((r) => setSources(r.sources ?? [])).catch(() => setSources(null));
    api.get<any>(`/research-studio/projects/${sel.id}/evidence-matrix`).then((r) => setClaimRows(r.matrix?.rows ?? null)).catch(() => setClaimRows(null));
  }, [sel?.id]);

  function openSource(s: any, triggerEl?: HTMLElement) {
    if (triggerEl) drawerTriggerRef.current = triggerEl;
    setActiveSource(s);
    setSourceDetail(null);
    if (!sel?.id) return;
    Promise.all([
      api.get<any>(`/research-studio/projects/${sel.id}/sources/${s.id}`),
      api.get<any>(`/research-studio/projects/${sel.id}/excerpts?sourceId=${s.id}`),
    ]).then(([detail, ex]) => setSourceDetail({ ...detail, excerpts: ex.excerpts ?? [] })).catch(() => setSourceDetail(null));
  }

  const unsupported = claimRows?.filter((r) => r.overallStatus !== 'supported').length ?? null;

  if (!sel) {
    return (
      <div style={{ padding: 20 }}>
        {projects === null ? (
          <NotAvailableYet title="Loading projects…" description="Fetching your research projects." />
        ) : (
          <NotAvailableYet
            title="No project selected"
            description="Create a project in Research Studio to see its sources and claims here."
            action={<a href="/research-studio" className="nx-btn">Create a project</a>}
          />
        )}
      </div>
    );
  }

  const inspector = (
    <ProvenanceInspector source={activeSource} detail={sourceDetail} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <WorkspaceBar
        badges={[
          { label: 'PROGRAMME', value: <span style={{ font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>{sel.title}</span> },
          { label: 'EVIDENCE', value: unsupported == null ? <span style={{ color: 'var(--nx-text-dim)' }}>—</span> : <Badge tone={unsupported > 0 ? 'red' : 'green'}>{unsupported} UNSUPPORTED</Badge> },
          { label: 'TASKS', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{graph.filter((t) => t.status === 'completed').length}/{graph.length} done</span> },
        ]}
      />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ width: 206, flex: 'none', background: 'var(--nx-panel)', borderRight: '1px solid var(--nx-border)', overflowY: 'auto' }}>
          <div style={{ padding: '13px 15px 12px', borderBottom: '1px solid var(--nx-hairline)' }}>
            <span className="nx-label">TASK GRAPH</span>
          </div>
          <div style={{ padding: 8 }}>
            {graph.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', borderRadius: 5 }}>
                {t.status === 'completed'
                  ? <Check size={12} strokeWidth={2.2} color="var(--nx-green)" />
                  : !t.agentAvailable
                    ? <Lock size={11} strokeWidth={1.8} color="var(--nx-text-dim)" />
                    : <span style={{ width: 6, height: 6, borderRadius: '50%', background: { blue: 'var(--nx-blue)', amber: 'var(--nx-amber)', red: 'var(--nx-red)', neutral: 'var(--nx-text-dim)', green: 'var(--nx-green)' }[TASK_TONE[t.status] ?? 'neutral'] }} />}
                <span style={{ flex: 1, font: '400 12px Inter,sans-serif', color: t.status === 'completed' ? 'var(--nx-text-muted)' : 'var(--nx-text-soft)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.type}</span>
              </div>
            ))}
            {graph.length === 0 && <div style={{ padding: '7px 9px', font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>No tasks yet.</div>}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '16px 18px 0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
            <h1 style={{ margin: 0, font: '600 19px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>Sources, excerpts &amp; claim provenance</h1>
            <div style={{ display: 'flex', gap: 9, flex: 'none' }}>
              <Button icon={<Upload size={13} strokeWidth={1.7} />}>Import RIS / BibTeX</Button>
              <Button variant="primary" icon={<Plus size={13} strokeWidth={2} />}>Add source</Button>
            </div>
          </div>

          <div className="nx-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="nx-panel" style={{ overflow: 'hidden' }}>
              <table className="nx-table">
                <thead><tr><th style={{ width: '40%' }}>Source</th><th style={{ width: '16%' }}>Identifier</th><th style={{ width: '14%' }}>Metadata</th><th style={{ width: '14%' }}>Full text</th><th style={{ width: '16%' }}>Correction</th></tr></thead>
                <tbody>
                  {(sources ?? []).map((s) => (
                    <tr
                      key={s.id}
                      tabIndex={0}
                      role="button"
                      onClick={(e) => openSource(s, e.currentTarget)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSource(s, e.currentTarget); }
                      }}
                      style={{ cursor: 'pointer', background: activeSource?.id === s.id ? 'var(--nx-panel-alt)' : undefined }}
                    >
                      <td style={{ color: 'var(--nx-text)', boxShadow: activeSource?.id === s.id ? 'inset 2px 0 0 var(--nx-gold)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {/* Visually-hidden context prefix, not an aria-label override — keeps this row's
                            accessible name computed from its own visible content (title + badge text),
                            which is what WCAG 2.5.3 Label in Name / axe's label-content-name-mismatch require. */}
                        <span style={SR_ONLY}>Inspect provenance for </span>
                        {s.title}
                      </td>
                      <td className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-muted)' }}>{s.doi ?? s.pmid ?? '—'}</td>
                      <td><Badge tone={s.metadata_verification_status === 'verified' ? 'green' : s.metadata_verification_status === 'mismatch' ? 'red' : 'neutral'}>{s.metadata_verification_status?.toUpperCase() ?? 'UNVERIFIED'}</Badge></td>
                      <td><Badge tone={s.fulltext_status === 'full_text' ? 'green' : s.fulltext_status === 'abstract' ? 'amber' : 'red'}>{s.fulltext_status?.toUpperCase() ?? 'UNAVAIL'}</Badge></td>
                      <td><Badge tone={s.correction_status === 'retracted' ? 'red' : s.correction_status === 'corrected' ? 'amber' : 'neutral'}>{s.correction_status?.toUpperCase() ?? 'NONE'}</Badge></td>
                    </tr>
                  ))}
                  {sources?.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--nx-text-muted)' }}>No sources imported yet.</td></tr>}
                </tbody>
              </table>
            </div>

            <div className="nx-panel" style={{ overflow: 'hidden' }}>
              <div className="nx-panel-head">
                <span>Claims</span>
                <span className="nx-mono" style={{ fontSize: 10, color: 'var(--nx-text-dim)' }}>{claimRows ? `${claimRows.length} total` : 'MATRIX NOT BUILT'}</span>
              </div>
              <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {claimRows === null && <div style={{ font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>Evidence matrix hasn't been built for this project yet.</div>}
                {claimRows?.map((c) => (
                  <div key={c.claimId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 11px', border: '1px solid var(--nx-border)', borderRadius: 5, background: 'var(--nx-panel-row)' }}>
                    <Badge tone={c.overallStatus === 'supported' ? 'green' : c.overallStatus === 'contradicted' ? 'red' : 'amber'}>{c.overallStatus.toUpperCase()}</Badge>
                    <span style={{ flex: 1, font: '400 12px/1.45 Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{c.statement}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {!narrow && (
          <aside style={{ width: 324, flex: 'none', background: 'var(--nx-panel)', borderLeft: '1px solid var(--nx-border)', overflowY: 'auto' }}>
            {inspector}
          </aside>
        )}
      </div>

      {narrow && (
        <Drawer
          open={!!activeSource}
          onClose={() => setActiveSource(null)}
          title="Provenance"
          returnFocusRef={drawerTriggerRef}
        >
          {inspector}
        </Drawer>
      )}
    </div>
  );
}

function ProvenanceInspector({ source, detail }: { source: any; detail: any }) {
  if (!source) {
    return (
      <div style={{ padding: '14px 16px' }}>
        <NotAvailableYet title="Nothing selected yet" description="Select a source to see its identifier, verification status and import record." />
      </div>
    );
  }
  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ font: '600 13px/1.4 Inter,sans-serif', color: 'var(--nx-text)' }}>{source.title}</div>
      <div style={{ marginTop: 5, font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{source.venue ?? '—'} · {source.year ?? '—'}</div>
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <Row label="DOI" value={source.doi ?? '—'} />
        <Row label="Resolver" value={<Badge tone={source.metadata_verification_status === 'verified' ? 'green' : 'neutral'}>{(source.metadata_verification_status ?? 'unverified').toUpperCase()}</Badge>} />
        <Row label="Fulltext" value={(source.fulltext_status ?? 'unavailable').toUpperCase()} />
        <Row label="SHA-256" value={source.content_hash ? `${source.content_hash.slice(0, 6)}…${source.content_hash.slice(-4)}` : '—'} />
      </div>
      {detail?.artifacts?.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 13, borderTop: '1px solid var(--nx-hairline)' }}>
          <div className="nx-label">ARTIFACTS</div>
          {detail.artifacts.map((a: any) => (
            <div key={a.id} style={{ marginTop: 9, font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{a.kind} · {(a.size_bytes / 1024).toFixed(0)} KB</div>
          ))}
        </div>
      )}
      {detail?.excerpts?.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 13, borderTop: '1px solid var(--nx-hairline)' }}>
          <div className="nx-label">EXCERPTS</div>
          {detail.excerpts.map((e: any) => (
            <p key={e.id} style={{ margin: '9px 0 0', padding: '11px 13px', borderLeft: '2px solid var(--nx-gold)', background: 'var(--nx-panel-alt)', font: '400 12.5px/1.65 Inter,sans-serif', color: e.invalidated_at ? 'var(--nx-text-muted)' : 'var(--nx-text)' }}>
              {e.text}
              {e.invalidated_at && <div style={{ marginTop: 6 }}><Badge tone="amber">STALE · {e.invalidated_reason ?? 'invalidated'}</Badge></div>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{label}</span>
      <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{value}</span>
    </div>
  );
}
