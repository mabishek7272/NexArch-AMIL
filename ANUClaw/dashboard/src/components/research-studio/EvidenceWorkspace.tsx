import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { GlassCard } from '../GlassCard';

/**
 * Evidence Workspace (M2) — search strategy, import, source library, duplicates review, source detail/verification,
 * excerpt editor, claims/support views, screening and the evidence matrix. Every status shown comes verbatim from the
 * API's own separate status columns (metadata_verification_status, fulltext_status, correction_status,
 * claim_support_status) — this component never collapses "resolved" into "verified" or "agreed" into "supported".
 * Human annotations, imported records, deterministic checks and (not yet existing) model assessments are labelled
 * distinctly wherever they appear together.
 */
const box = 'rounded-lg border px-2 py-1.5 text-xs bg-transparent';
const btn = 'rounded-md px-2.5 py-1 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const badge = (color: string): React.CSSProperties => ({ color, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px', fontSize: '0.65rem' });
const STATUS_TONE: Record<string, string> = { unknown: '#8a94a6', unverified: '#8a94a6', verified: '#10b981', mismatch: '#f43f5e', none: '#8a94a6', corrected: '#f59e0b', retracted: '#f43f5e', full_text: '#10b981', abstract_only: '#f59e0b', unavailable: '#f43f5e', unresolved: '#8a94a6', supported: '#10b981', contradicted: '#f43f5e' };
const tone = (s: string) => STATUS_TONE[s] ?? '#8a94a6';

export function EvidenceWorkspace({ projectId }: { projectId: string }) {
  const [sources, setSources] = useState<any[]>([]);
  const [links, setLinks] = useState<any[]>([]);
  const [excerpts, setExcerpts] = useState<any[]>([]);
  const [claims, setClaims] = useState<any[]>([]);
  const [claimLinks, setClaimLinks] = useState<Record<string, any[]>>({});
  const [matrix, setMatrix] = useState<any>(null);
  const [selSource, setSelSource] = useState<any>(null);
  const [importText, setImportText] = useState('');
  const [newSource, setNewSource] = useState<Record<string, string>>({});
  const [newClaim, setNewClaim] = useState('');
  const [excerptForm, setExcerptForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, l, e, c, m] = await Promise.all([
      api.get<any>(`/research-studio/projects/${projectId}/sources`),
      api.get<any>(`/research-studio/projects/${projectId}/source-links`),
      api.get<any>(`/research-studio/projects/${projectId}/excerpts`),
      api.get<any>(`/research-studio/projects/${projectId}/claims`),
      api.get<any>(`/research-studio/projects/${projectId}/evidence-matrix`),
    ]);
    setSources(s.sources ?? []); setLinks(l.links ?? []); setExcerpts(e.excerpts ?? []); setClaims(c.claims ?? []); setMatrix(m.matrix ?? null);
  }, [projectId]);
  useEffect(() => { void load().catch(() => {}); }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const [lastImport, setLastImport] = useState<any>(null);
  const doImport = () => act(async () => {
    const r = await api.post<any>(`/research-studio/projects/${projectId}/sources/import`, { text: importText });
    setLastImport(r); setImportText('');
  }, 'Bibliography import attempted — see the result below for exactly what was imported, skipped, or failed to parse.');

  const createSource = () => act(async () => {
    await api.post(`/research-studio/projects/${projectId}/sources`, { doi: newSource.doi || undefined, title: newSource.title, year: newSource.year ? Number(newSource.year) : undefined, venue: newSource.venue });
    setNewSource({});
  }, 'Source recorded.');

  const decideLink = (linkId: string, decision: 'confirmed' | 'rejected') => act(async () => { await api.post(`/research-studio/projects/${projectId}/source-links/${linkId}/decision`, { decision }); }, `Duplicate link ${decision}.`);

  const screen = (sourceId: string, decision: 'include' | 'exclude', exclusionReason?: string) => act(async () => { await api.post(`/research-studio/projects/${projectId}/sources/${sourceId}/screening`, { decision, exclusionReason }); }, `Screening recorded: ${decision}.`);

  const uploadArtifact = async (sourceId: string, file: File) => {
    setBusy(true); setMsg(null);
    try {
      const form = new FormData(); form.set('file', file);
      const res = await fetch(`/api/research-studio/projects/${projectId}/sources/${sourceId}/artifacts`, { method: 'POST', credentials: 'include', body: form });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      setMsg({ kind: 'ok', text: 'Artifact stored locally.' }); await load();
    } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const createExcerpt = (sourceId: string) => act(async () => {
    const locator: Record<string, unknown> = {}; if (excerptForm.page) locator.page = Number(excerptForm.page); if (excerptForm.section) locator.section = excerptForm.section;
    await api.post(`/research-studio/projects/${projectId}/sources/${sourceId}/excerpts`, { locator, text: excerptForm.text });
    setExcerptForm({});
  }, 'Excerpt recorded (human-supplied).');

  const createClaim = () => act(async () => { await api.post(`/research-studio/projects/${projectId}/claims`, { statement: newClaim }); setNewClaim(''); }, 'Claim recorded.');
  const loadClaimLinks = (claimId: string) => act(async () => { const r = await api.get<any>(`/research-studio/projects/${projectId}/claims/${claimId}/links`); setClaimLinks((x) => ({ ...x, [claimId]: r.links ?? [] })); }, 'Claim links loaded.');
  const linkEvidence = (claimId: string, excerptId: string, relation: 'supports' | 'contradicts' | 'unclear') => act(async () => { await api.post(`/research-studio/projects/${projectId}/claims/${claimId}/links`, { excerptId, relation, supportStatus: relation === 'supports' ? 'supported' : relation === 'contradicts' ? 'contradicted' : 'unresolved' }); await loadClaimLinks(claimId); }, 'Evidence linked to claim.');

  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  return (
    <div className="space-y-4">
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Import workflow (local)</h3>
        <p className="text-xs" style={muted}>Paste RIS or BibTeX text. Every record that fails to parse is reported below, never silently dropped.</p>
        <textarea className={`${box} w-full mt-2 h-24`} aria-label="bibliography-import-text" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="TY  - JOUR&#10;TI  - ...&#10;ER  - " />
        <button className={`${btn} mt-2`} disabled={busy || !importText.trim()} onClick={doImport}>Import</button>
        {lastImport && <p className="text-xs mt-1" style={muted}>Format {lastImport.format}: {lastImport.imported} imported, {lastImport.duplicatesSkipped} exact duplicate(s) skipped, {lastImport.parseFailures?.length ?? 0} parse failure(s).
          {!!lastImport.parseFailures?.length && <ul>{lastImport.parseFailures.map((f: any, i: number) => <li key={i}>— {f.reason}</li>)}</ul>}</p>}
      </GlassCard>

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Add a source manually</h3>
        <div className="grid grid-cols-4 gap-2 mt-2">
          <input className={box} placeholder="DOI (optional)" aria-label="new-source-doi" value={newSource.doi ?? ''} onChange={(e) => setNewSource((x) => ({ ...x, doi: e.target.value }))} />
          <input className={box} placeholder="Title" aria-label="new-source-title" value={newSource.title ?? ''} onChange={(e) => setNewSource((x) => ({ ...x, title: e.target.value }))} />
          <input className={box} placeholder="Year" aria-label="new-source-year" value={newSource.year ?? ''} onChange={(e) => setNewSource((x) => ({ ...x, year: e.target.value }))} />
          <input className={box} placeholder="Venue" aria-label="new-source-venue" value={newSource.venue ?? ''} onChange={(e) => setNewSource((x) => ({ ...x, venue: e.target.value }))} />
        </div>
        <button className={`${btn} mt-2`} disabled={busy || !newSource.title} onClick={createSource}>Add source</button>
      </GlassCard>

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Source library</h3>
        <table className="text-xs w-full mt-2" data-testid="evidence-sources"><thead><tr className="text-left"><th>Title</th><th>DOI</th><th>Metadata</th><th>Full text</th><th>Correction</th><th>Screening</th></tr></thead>
          <tbody>{sources.map((s) => (
            <tr key={s.id} className="align-top">
              <td><button className="underline" onClick={() => setSelSource(s)}>{s.title}</button></td>
              <td style={muted}>{s.doi ?? '—'}</td>
              <td><span style={badge(tone(s.metadata_verification_status))}>{s.metadata_verification_status}</span></td>
              <td><span style={badge(tone(s.fulltext_status))}>{s.fulltext_status}</span></td>
              <td><span style={badge(tone(s.correction_status))}>{s.correction_status}</span></td>
              <td>
                <button className={btn} disabled={busy} onClick={() => screen(s.id, 'include')}>Include</button>{' '}
                <button className={btn} disabled={busy} onClick={() => { const r = window.prompt('Exclusion reason (required):'); if (r) screen(s.id, 'exclude', r); }}>Exclude</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>

      {!!links.filter((l) => l.status === 'proposed').length && (
        <GlassCard padding="md">
          <h3 className="font-semibold text-sm">Duplicates review — proposed matches (never auto-merged)</h3>
          <table className="text-xs w-full mt-2" data-testid="evidence-duplicate-links"><thead><tr className="text-left"><th>A</th><th>B</th><th>Relation</th><th>Decision</th></tr></thead>
            <tbody>{links.filter((l) => l.status === 'proposed').map((l) => (
              <tr key={l.id}>
                <td>{sourcesById.get(l.source_id_a)?.title ?? l.source_id_a}</td>
                <td>{sourcesById.get(l.source_id_b)?.title ?? l.source_id_b}</td>
                <td>{l.relation}</td>
                <td><button className={btn} disabled={busy} onClick={() => decideLink(l.id, 'confirmed')}>Confirm</button>{' '}
                  <button className={btn} disabled={busy} onClick={() => decideLink(l.id, 'rejected')}>Reject</button></td>
              </tr>
            ))}</tbody>
          </table>
        </GlassCard>
      )}

      {selSource && (
        <GlassCard padding="md">
          <h3 className="font-semibold text-sm">Source detail — {selSource.title}</h3>
          <p className="text-xs" style={muted}>Upload a permitted local PDF/text artifact (stored locally; text is extracted automatically for PDFs).</p>
          <input type="file" aria-label="artifact-upload" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadArtifact(selSource.id, f); }} />
          <div className="mt-3">
            <h4 className="text-xs font-semibold">Add a human-supplied excerpt (exact locator required)</h4>
            <div className="flex gap-2 mt-1">
              <input className={box} placeholder="page" aria-label="excerpt-page" value={excerptForm.page ?? ''} onChange={(e) => setExcerptForm((x) => ({ ...x, page: e.target.value }))} style={{ width: 60 }} />
              <input className={box} placeholder="section (optional)" aria-label="excerpt-section" value={excerptForm.section ?? ''} onChange={(e) => setExcerptForm((x) => ({ ...x, section: e.target.value }))} />
            </div>
            <textarea className={`${box} w-full mt-1 h-16`} placeholder="Excerpt text" aria-label="excerpt-text" value={excerptForm.text ?? ''} onChange={(e) => setExcerptForm((x) => ({ ...x, text: e.target.value }))} />
            <button className={`${btn} mt-1`} disabled={busy || !excerptForm.text || !excerptForm.page} onClick={() => createExcerpt(selSource.id)}>Add excerpt</button>
          </div>
          <div className="mt-3">
            <h4 className="text-xs font-semibold">Excerpts for this source</h4>
            <ul className="text-xs" data-testid="evidence-excerpts">{excerpts.filter((e) => e.source_id === selSource.id).map((e) => (
              <li key={e.id} style={e.invalidated_at ? { color: '#f43f5e' } : undefined}>
                [{e.extracted_by}] p.{JSON.parse(e.locator_json).page ?? '—'}: {e.text.slice(0, 120)}{e.invalidated_at ? ` — INVALIDATED: ${e.invalidated_reason}` : ''}
              </li>
            ))}</ul>
          </div>
        </GlassCard>
      )}

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Claims and evidence support</h3>
        <div className="flex gap-2">
          <input className={box} placeholder="New claim statement" aria-label="new-claim" value={newClaim} onChange={(e) => setNewClaim(e.target.value)} style={{ flex: 1 }} />
          <button className={btn} disabled={busy || !newClaim.trim()} onClick={createClaim}>Add claim</button>
        </div>
        <ul className="text-xs mt-2" data-testid="evidence-claims">{claims.map((c) => (
          <li key={c.id} className="mb-2">
            <button className="underline" onClick={() => loadClaimLinks(c.id)}>{c.statement}</button>
            {claimLinks[c.id] && (
              <ul className="ml-4">
                {claimLinks[c.id].map((l: any) => (
                  <li key={l.id}><span style={badge(tone(l.claim_support_status))}>{l.claim_support_status}</span> ({l.relation}) — excerpt {l.excerpt_id.slice(0, 8)}</li>
                ))}
                <li>
                  {excerpts.filter((e) => !e.invalidated_at).slice(0, 5).map((e) => (
                    <span key={e.id} className="mr-1">
                      <button className={btn} onClick={() => linkEvidence(c.id, e.id, 'supports')}>+supports {e.id.slice(0, 6)}</button>
                      <button className={btn} onClick={() => linkEvidence(c.id, e.id, 'contradicts')}>+contradicts</button>
                    </span>
                  ))}
                </li>
              </ul>
            )}
          </li>
        ))}</ul>
      </GlassCard>

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Evidence matrix (deterministic; built by the Evidence Matrix Builder agent)</h3>
        {matrix ? (
          <table className="text-xs w-full mt-2" data-testid="evidence-matrix"><thead><tr className="text-left"><th>Claim</th><th>Status</th><th>Evidence</th></tr></thead>
            <tbody>{matrix.rows.map((r: any) => (
              <tr key={r.claimId}><td>{r.statement}</td><td><span style={badge(tone(r.overallStatus))}>{r.overallStatus}</span></td>
                <td>{r.evidence.map((e: any, i: number) => <div key={i} style={e.stale ? { color: '#f59e0b' } : undefined}>{e.relation} — {e.sourceTitle ?? e.sourceId}{e.stale ? ' (stale)' : ''}</div>)}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="text-xs" style={muted}>No evidence matrix has been built yet — run the evidence.build_matrix task (Advance now, for review/dissertation modes) to generate one.</p>}
      </GlassCard>
    </div>
  );
}
