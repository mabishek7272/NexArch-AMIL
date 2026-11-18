import React, { useEffect, useState } from 'react';
import { Microscope, Play, Folders, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, NotAvailableYet, WorkspaceBar, SR_ONLY } from '../ui';

/**
 * Overview — screen 01. Project portfolio, evidence-integrity split and sources/excerpts/claims
 * counts are real (research-studio API). Next-critical-actions, computational runs, review queue,
 * provider health and the audit log are NOT backed by any existing endpoint — see the backend
 * gap table in docs/NAV-REDESIGN-ROUTE-MAP.md — so they render an honest "not available yet" card
 * instead of the mockup's illustrative numbers.
 */
export default function Overview() {
  const [projects, setProjects] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any>(null);
  const [claimCount, setClaimCount] = useState<number | null>(null);
  const [sources, setSources] = useState<any[] | null>(null);
  const [excerpts, setExcerpts] = useState<any[] | null>(null);
  /** From /evidence-matrix — null until the evidence.build_matrix task has actually run for this project. */
  const [matrix, setMatrix] = useState<{ rows: Array<{ overallStatus: string; evidence: Array<{ stale: boolean }> }> } | null | undefined>(undefined);

  useEffect(() => {
    api.get<any>('/research-studio/projects').then((r) => {
      const ps = r.projects ?? [];
      setProjects(ps);
      if (ps[0]) setSel(ps[0]);
    }).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!sel?.id) return;
    api.get<any>(`/research-studio/projects/${sel.id}/claims`).then((r) => setClaimCount((r.claims ?? []).length)).catch(() => setClaimCount(null));
    api.get<any>(`/research-studio/projects/${sel.id}/sources`).then((r) => setSources(r.sources ?? [])).catch(() => setSources(null));
    api.get<any>(`/research-studio/projects/${sel.id}/excerpts`).then((r) => setExcerpts(r.excerpts ?? [])).catch(() => setExcerpts(null));
    api.get<any>(`/research-studio/projects/${sel.id}/evidence-matrix`).then((r) => setMatrix(r.matrix)).catch(() => setMatrix(null));
  }, [sel?.id]);

  // Real statuses from evidence-matrix-builder.ts are 'supported' | 'contradicted' | 'unresolved' | 'unknown' —
  // never 'unsupported'/'stale' directly. "Stale" (mockup's term) = not supported AND has at least one evidence
  // entry whose excerpt was invalidated by a later correction; everything else non-supported is bucketed as
  // unsupported. This is a real-data-grounded relabeling, not a fabricated status.
  const rows = matrix?.rows ?? [];
  const supported = matrix ? rows.filter((r) => r.overallStatus === 'supported').length : null;
  const stale = matrix ? rows.filter((r) => r.overallStatus !== 'supported' && r.evidence.some((e) => e.stale)).length : null;
  const unsupported = matrix ? rows.length - (supported ?? 0) - (stale ?? 0) : null;

  return (
    <div>
      {/* Visually-hidden — the page's "Current programme" hero below is a styled heading-like
          element but only renders once a project is selected; this gives the page a real,
          always-present h1 without visually duplicating that hero. */}
      <h1 style={SR_ONLY}>Overview</h1>
      <WorkspaceBar
        badges={[
          { label: 'PROGRAMME', value: <span style={{ font: '600 13px Inter,sans-serif', color: 'var(--nx-text)' }}>{sel?.title ?? '—'}</span> },
          { label: 'MODE', value: <span className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-soft)' }}>{sel?.mode ?? '—'}</span> },
          { label: 'EVIDENCE', value: unsupported == null ? <span style={{ color: 'var(--nx-text-dim)' }}>—</span> : <Badge tone={unsupported > 0 ? 'red' : 'green'}>{unsupported} UNSUPPORTED</Badge> },
        ]}
      />

      <div style={{ padding: '18px 20px' }}>
        {projects === null && <div style={{ color: 'var(--nx-text-muted)', font: '400 12.5px Inter,sans-serif' }}>Loading projects…</div>}
        {projects?.length === 0 && (
          <NotAvailableYet
            title="No research projects yet"
            description="Create a project to see its sources, claims and evidence here."
            action={<a href="/research-studio" className="nx-btn">Create a project</a>}
          />
        )}

        {sel && (
          <div className="nx-panel" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 26 }}>
            <div style={{ minWidth: 0 }}>
              <div className="nx-label">Current programme</div>
              <div style={{ marginTop: 7, font: '600 19px/1.2 Inter,sans-serif', color: 'var(--nx-text)' }}>{sel.title}</div>
              <div style={{ marginTop: 6, font: '400 12.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>
                {sel.mode} · created {sel.created_at ? new Date(sel.created_at).toLocaleDateString() : '—'}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingLeft: 26, borderLeft: '1px solid var(--nx-border)', display: 'flex', gap: 18 }}>
              <Count label="Sources" value={sources?.length} />
              <Count label="Excerpts" value={excerpts?.length} />
              <Count label="Claims" value={claimCount} />
            </div>
            <div style={{ flex: 'none', display: 'flex', gap: 9 }}>
              <a href="/research-studio" className="nx-btn"><Play size={13} strokeWidth={1.7} />Open Research Studio (classic)</a>
              <a href={`/nexarch/research-studio?project=${sel.id}`} className="nx-btn nx-btn-primary"><Microscope size={13} strokeWidth={1.8} />Open Research Studio</a>
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 388px', gap: 16, marginTop: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div className="nx-panel" style={{ overflow: 'hidden' }}>
              <div className="nx-panel-head">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Folders size={14} strokeWidth={1.7} color="var(--nx-gold)" />Project portfolio</span>
                <span className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-dim)' }}>{projects?.length ?? 0} TOTAL</span>
              </div>
              <table className="nx-table">
                <thead><tr><th style={{ width: '40%' }}>Project</th><th style={{ width: '22%' }}>Mode</th><th style={{ width: '38%' }}>Updated</th></tr></thead>
                <tbody>
                  {(projects ?? []).map((p) => (
                    <tr key={p.id} onClick={() => setSel(p)} style={{ cursor: 'pointer', background: p.id === sel?.id ? 'var(--nx-panel-alt)' : undefined }}>
                      <td style={{ color: 'var(--nx-text)', boxShadow: p.id === sel?.id ? 'inset 2px 0 0 var(--nx-gold)' : undefined }}>{p.title}</td>
                      <td className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-muted)' }}>{p.mode}</td>
                      <td className="nx-mono" style={{ fontSize: 11, color: 'var(--nx-text-muted)' }}>{p.updated_at ? new Date(p.updated_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <NotAvailableYet
              title="Action list isn't ready yet"
              description="We can't yet combine unsupported claims, review items and stale sources into one ranked list."
              action={<a href="/nexarch/research-studio" className="nx-btn">Review in Research Studio</a>}
              technicalDetail="No endpoint aggregates unsupported claims, review-queue items, and stale excerpts into a single ranked list yet. See docs/NAV-REDESIGN-ROUTE-MAP.md's Bioinformatics gap table — same missing-aggregation-route pattern applies here."
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div className="nx-panel" style={{ overflow: 'hidden' }}>
              <div className="nx-panel-head"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><ShieldCheck size={14} strokeWidth={1.7} color="var(--nx-green)" />Evidence integrity</span><span className="nx-mono" style={{ fontSize: 10.5, color: 'var(--nx-text-dim)' }}>{rows.length} CLAIMS</span></div>
              <div style={{ padding: '14px 16px' }}>
                {matrix && rows.length > 0 ? (
                  <>
                    <div style={{ display: 'flex', height: 7, borderRadius: 3, overflow: 'hidden', background: 'var(--nx-active)' }}>
                      <span style={{ width: `${(supported! / rows.length) * 100}%`, background: 'var(--nx-green)' }} />
                      <span style={{ width: `${(stale! / rows.length) * 100}%`, background: 'var(--nx-amber)' }} />
                      <span style={{ width: `${(unsupported! / rows.length) * 100}%`, background: 'var(--nx-red)' }} />
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <Legend color="var(--nx-green)" label="Supported by verified excerpt" value={supported} />
                      <Legend color="var(--nx-amber)" label="Stale — source corrected since link" value={stale} />
                      <Legend color="var(--nx-red)" label="Unsupported / unresolved" value={unsupported} />
                    </div>
                    <div style={{ marginTop: 13, paddingTop: 11, borderTop: '1px solid var(--nx-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>Export gate</span>
                      <Badge tone={unsupported! > 0 ? 'red' : 'green'}>{unsupported! > 0 ? 'BLOCKED' : 'READY'}</Badge>
                    </div>
                  </>
                ) : matrix === null ? (
                  <div style={{ font: '400 12px/1.5 Inter,sans-serif', color: 'var(--nx-text-muted)' }}>
                    Evidence matrix not built yet for this project — run the "Build evidence matrix" step in Research Studio (classic) first. Showing nothing here rather than a guess.
                  </div>
                ) : <div style={{ font: '400 12px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>{sel ? 'Loading…' : 'Select a project.'}</div>}
              </div>
            </div>

            <NotAvailableYet
              title="Run status isn't shown here yet"
              description="Pipeline and research runs each report their own status; this view doesn't combine them yet."
              action={<a href="/pipelines" className="nx-btn">View pipeline runs</a>}
              technicalDetail="No cross-subsystem job/run feed exists yet — pipelines and research runs each have their own status endpoint, but nothing aggregates them."
            />
            <NotAvailableYet
              title="Review queue isn't shown here yet"
              description="Screening decisions and editorial proposals are tracked per project, not combined across projects yet."
              action={<a href="/research-studio" className="nx-btn">Open Research Studio</a>}
              technicalDetail="Screening decisions and editorial proposals exist per-project; no cross-project review-queue endpoint exists yet."
            />
            <NotAvailableYet
              title="Provider health isn't shown here yet"
              description="Only connection profiles report status today; a named-provider health check isn't available."
              action={<a href="/nexarch/connections" className="nx-btn">View connections</a>}
              technicalDetail="Only per-profile connector status exists (AI Connections page); there is no named-provider health-check endpoint."
            />
            <NotAvailableYet
              title="A combined audit log isn't available here yet"
              description="Each project keeps its own verified history; there's no single feed across all projects yet."
              technicalDetail="Per-project event chains exist (Verify event chain, in Research Studio); no unified, hash-chain-verified global feed is exposed to the dashboard yet."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <span style={{ font: '400 11.5px Inter,sans-serif', color: 'var(--nx-text-muted)' }}>
      {label} <span className="nx-mono" style={{ fontSize: 11.5, color: 'var(--nx-text)' }}>{value ?? '—'}</span>
    </span>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number | null | undefined }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: color }} />
      <span style={{ flex: 1, font: '400 12px Inter,sans-serif', color: 'var(--nx-text-soft)' }}>{label}</span>
      <span className="nx-mono" style={{ fontSize: 11.5, color: 'var(--nx-text)' }}>{value ?? 0}</span>
    </div>
  );
}
