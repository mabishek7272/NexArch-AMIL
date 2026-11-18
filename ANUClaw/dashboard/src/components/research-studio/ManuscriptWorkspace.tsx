import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { GlassCard } from '../GlassCard';

/**
 * Manuscript/thesis workspace (M4). Shows the CURRENT content of every section/chapter (human-authored or an
 * honest deterministic-digest placeholder — never fabricated prose), lets the author request an editorial edit
 * (the author supplies their own rewritten text; this page never generates one), shows the preservation/tracked-
 * change report, and accept/reject it. Also journal/university guidelines and the compliance report — explicitly
 * labelled as NOT a journal acceptance or checklist certification.
 */
const box = 'rounded-lg border px-2 py-1.5 text-xs bg-transparent';
const btn = 'rounded-md px-2.5 py-1 text-xs font-semibold border disabled:opacity-40';
const muted = { color: 'var(--text-dim, #8a94a6)' };
const SOURCE_TONE: Record<string, string> = { human: '#10b981', deterministic_digest: '#f59e0b', editorial_proposal: '#3b82f6', model: '#f43f5e' };

export function ManuscriptWorkspace({ projectId }: { projectId: string }) {
  const [sections, setSections] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [editedText, setEditedText] = useState('');
  const [lastEdit, setLastEdit] = useState<any>(null);
  const [guideline, setGuideline] = useState<any>(null);
  const [complianceReport, setComplianceReport] = useState<any>(null);
  const [newGuideline, setNewGuideline] = useState({ journalOrUniversity: '', checklistLabel: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, g] = await Promise.all([
      api.get<any>(`/research-studio/projects/${projectId}/sections`),
      api.get<any>(`/research-studio/projects/${projectId}/guidelines`),
    ]);
    setSections(s.current ?? []);
    setGuideline(g.guidelines?.[g.guidelines.length - 1] ?? null);
  }, [projectId]);
  useEffect(() => { void load().catch(() => {}); }, [load]);

  const loadComments = useCallback(async (sectionId: string) => {
    const r = await api.get<any>(`/research-studio/projects/${projectId}/sections/${sectionId}`);
    setComments(r.comments ?? []);
  }, [projectId]);
  useEffect(() => { if (selected) void loadComments(selected.id).catch(() => {}); else setComments([]); }, [selected, loadComments]);

  const postComment = (sectionId: string) => act(async () => {
    await api.post(`/research-studio/projects/${projectId}/sections/${sectionId}/comments`, { body: newComment });
    setNewComment('');
    await loadComments(sectionId);
  }, 'Comment added.');

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: ok }); await load(); } catch (e: any) { setMsg({ kind: 'err', text: String(e?.message ?? e) }); } finally { setBusy(false); }
  };

  const requestEdit = (sectionId: string) => act(async () => {
    const r = await api.post<any>(`/research-studio/projects/${projectId}/sections/${sectionId}/editorial-edit`, { editedText });
    if (r.task.status === 'awaiting_user') { setLastEdit(null); throw new Error(r.task.result_json ? 'Already resolved' : 'Supply edited text (this agent never writes the edit itself).'); }
    setLastEdit(JSON.parse(r.task.result_json));
    setEditedText('');
  }, 'Editorial proposal recorded — review the preservation report below before deciding.');

  const decide = (sectionId: string, decision: 'accepted' | 'rejected') => act(async () => {
    const r = await api.post<any>(`/research-studio/projects/${projectId}/sections/${sectionId}/decision`, { decision, reason: decision === 'accepted' ? 'approved by author' : 'declined by author' });
    if (r.reauditTaskId) setMsg({ kind: 'ok', text: `Accepted — a citation re-audit (task ${r.reauditTaskId.slice(0, 8)}) was queued automatically.` });
    setLastEdit(null);
  }, decision === 'accepted' ? 'Accepted.' : 'Rejected.');

  const createGuideline = () => act(async () => {
    await api.post(`/research-studio/projects/${projectId}/guidelines`, { journalOrUniversity: newGuideline.journalOrUniversity, checklist: newGuideline.checklistLabel ? [{ id: 'c1', label: newGuideline.checklistLabel }] : [] });
    setNewGuideline({ journalOrUniversity: '', checklistLabel: '' });
  }, 'Guideline record created.');
  const confirmItem = (itemId: string) => act(async () => { await api.post(`/research-studio/projects/${projectId}/guidelines/checklist/${itemId}`, { confirmed: true }); }, 'Checklist item confirmed by you.');
  const runCompliance = () => act(async () => { const r = await api.post<any>(`/research-studio/projects/${projectId}/compliance-report`, {}); setComplianceReport(r.report); }, 'Compliance report built.');

  const checklist: any[] = guideline ? JSON.parse(guideline.checklist_json) : [];

  return (
    <div className="space-y-4">
      {msg && <p role="status" className="text-xs" style={{ color: msg.kind === 'ok' ? '#10b981' : '#f43f5e' }}>{msg.text}</p>}

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Manuscript / thesis sections</h3>
        <table className="text-xs w-full mt-2" data-testid="manuscript-sections"><thead><tr className="text-left"><th>Key</th><th>Kind</th><th>Source</th><th>Content</th></tr></thead>
          <tbody>{sections.filter((s) => s.kind !== 'outline').map((s) => (
            <tr key={s.id} className="align-top">
              <td><button className="underline" onClick={() => { setSelected(s); setLastEdit(null); }}>{s.section_key}</button></td>
              <td>{s.kind}</td>
              <td><span style={{ color: SOURCE_TONE[s.content_source] }}>{s.content_source}</span></td>
              <td style={{ maxWidth: 400 }}>{s.content_text.slice(0, 140)}{s.content_text.length > 140 ? '…' : ''}{s.invalidated_at ? <span style={{ color: '#f43f5e' }}> (invalidated)</span> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      </GlassCard>

      {selected && (
        <GlassCard padding="md">
          <h3 className="font-semibold text-sm">Editorial edit — {selected.section_key}</h3>
          <p className="text-xs" style={muted}>You supply your own rewritten text (informed by your own writing sample/style). This agent never generates prose and never optimises for AI-detector scores.</p>
          <p className="text-xs mt-1" style={{ whiteSpace: 'pre-wrap' }}><b>Current:</b> {selected.content_text}</p>
          <textarea className={`${box} w-full mt-2 h-20`} aria-label="editorial-edited-text" value={editedText} onChange={(e) => setEditedText(e.target.value)} placeholder="Your rewritten text" />
          <button className={`${btn} mt-1`} disabled={busy || !editedText.trim()} onClick={() => requestEdit(selected.id)}>Propose edit</button>
          {lastEdit && (
            <div className="mt-2 text-xs" data-testid="editorial-preservation-report">
              <p style={{ color: lastEdit.preservation.interpretationAlteringChange ? '#f43f5e' : '#10b981' }}>
                {lastEdit.preservation.interpretationAlteringChange ? 'Interpretation-altering change flagged:' : 'No interpretation-altering change detected.'}
              </p>
              {lastEdit.preservation.reasons.map((r: string, i: number) => <p key={i} style={muted}>— {r}</p>)}
              <p style={muted}>{lastEdit.disclosure}</p>
              <button className={`${btn} mt-1`} disabled={busy} onClick={() => decide(lastEdit.proposalSectionId, 'accepted')}>Accept edit</button>{' '}
              <button className={btn} disabled={busy} onClick={() => decide(lastEdit.proposalSectionId, 'rejected')}>Reject edit</button>
            </div>
          )}

          <h4 className="font-semibold text-xs mt-3">Reviewer comments</h4>
          <ul data-testid="section-comments" className="text-xs mt-1 space-y-1">
            {comments.length ? comments.map((c) => (
              <li key={c.id} style={muted}>{new Date(c.created_at).toLocaleString()} — {c.body}</li>
            )) : <li style={muted}>No comments yet.</li>}
          </ul>
          <div className="flex gap-2 mt-2">
            <input className={`${box} flex-1`} aria-label="new-comment" placeholder="Add a reviewer comment" value={newComment} onChange={(e) => setNewComment(e.target.value)} />
            <button className={btn} disabled={busy || !newComment.trim()} onClick={() => postComment(selected.id)}>Add comment</button>
          </div>
        </GlassCard>
      )}

      <GlassCard padding="md">
        <h3 className="font-semibold text-sm">Journal/university guidelines &amp; compliance report</h3>
        <p className="text-xs" style={muted} data-testid="compliance-notice">A compliance report is NOT a journal acceptance and NOT a certification that any checklist item was actually verified correct — only that a human explicitly confirmed it.</p>
        {!guideline ? (
          <div className="flex gap-2 mt-2">
            <input className={box} placeholder="Journal or university name" aria-label="guideline-name" value={newGuideline.journalOrUniversity} onChange={(e) => setNewGuideline((x) => ({ ...x, journalOrUniversity: e.target.value }))} />
            <input className={box} placeholder="One checklist item label (optional)" aria-label="guideline-checklist-item" value={newGuideline.checklistLabel} onChange={(e) => setNewGuideline((x) => ({ ...x, checklistLabel: e.target.value }))} />
            <button className={btn} disabled={busy || !newGuideline.journalOrUniversity.trim()} onClick={createGuideline}>Create guideline record</button>
          </div>
        ) : (
          <div className="mt-2 text-xs">
            <p><b>{guideline.journal_or_university}</b> (version {guideline.version})</p>
            <ul data-testid="guideline-checklist">{checklist.map((c) => (
              <li key={c.id}>{c.label} — <span style={{ color: c.confirmed ? '#10b981' : '#8a94a6' }}>{c.confirmed ? 'confirmed' : 'not confirmed'}</span>
                {!c.confirmed && <button className={`${btn} ml-1`} disabled={busy} onClick={() => confirmItem(c.id)}>Confirm</button>}</li>
            ))}</ul>
            <button className={`${btn} mt-2`} disabled={busy} onClick={runCompliance}>Build compliance report</button>
          </div>
        )}
        {complianceReport && (
          <div className="mt-2 text-xs" data-testid="compliance-report">
            <p style={muted}>{complianceReport.notice}</p>
            <ul>{complianceReport.wordCounts.map((w: any) => <li key={w.sectionKey}>{w.sectionKey}: {w.words} word(s){w.limit !== null ? ` / limit ${w.limit} — ${w.withinLimit ? 'within limit' : 'OVER LIMIT'}` : ''}</li>)}</ul>
            <p>Checklist fully confirmed: {complianceReport.checklistFullyConfirmed ? 'yes' : 'no'}</p>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
