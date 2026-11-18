/**
 * AIKosh data-governance policy (PURE: no I/O). Local, offline, synthetic-or-unknown-provenance data only; nothing here validates anything clinically.
 *
 * Default for every file: status "unknown — blocked from external processing". A file may be used for RAG, embeddings, model prompts, fine-tuning,
 * clinical evidence or any external provider ONLY with a human-recorded approval (provenance, licence, permitted uses, sensitivity) that a DIFFERENT
 * authorized person has approved and that still matches the file's current SHA-256. Local deterministic tests and local-only evaluation adapters never
 * need approval because they make no external call and produce no clinical claim.
 */
export const USES = ['local_deterministic_test', 'local_evaluation', 'rag', 'embeddings', 'model_prompt', 'fine_tuning', 'clinical_evidence', 'external_provider'] as const;
export type Use = typeof USES[number];
export const LOCAL_FREE_USES: Use[] = ['local_deterministic_test', 'local_evaluation'];
/** Uses that send content to, or train, something outside this process. `rag` is local indexing only; an external embedding of it is `embeddings`. */
export const EXTERNAL_USES: Use[] = ['embeddings', 'model_prompt', 'fine_tuning', 'external_provider'];
export const SENSITIVITIES = ['public_reference', 'deidentified', 'limited', 'identifiable', 'unknown'] as const;
export type Sensitivity = typeof SENSITIVITIES[number];
export const EXTERNAL_OK_SENSITIVITIES: Sensitivity[] = ['public_reference', 'deidentified'];

export interface FileIdentity { path: string; sha256: string; narrativeColumns: string[]; identifierColumns: string[] }
export interface ApprovalRecord {
  id: string; path: string; sha256: string; recordedBy: string; provenance: string; licenceName: string; licenceRef: string; licencePermitsUses: Use[];
  permittedUses: Use[]; sensitivity: Sensitivity; consentRef: string | null; deidentificationRef: string | null;
  externalProcessing: 'not_approved' | 'approved'; dpaRef: string | null; clinicalOwnerRef: string | null; datasetCardSha256: string | null; externalFieldsReleased: string[];
}
export interface Decision { decision: 'approve' | 'revoke'; decidedBy: string; decidedAt: number }
export interface UseCheck { allowed: boolean; reasons: string[]; status: string; blockedFields: string[] }

export function defaultStatus(): string { return 'unknown — blocked from external processing'; }

/** Validates a proposed approval record's content (completeness only; it cannot verify that the claims are true). */
export function validateApprovalContent(r: Partial<ApprovalRecord>): string[] {
  const p: string[] = []; const need = (k: keyof ApprovalRecord) => { const v = r[k]; if (typeof v !== 'string' || !v.trim()) p.push(`${k} is required`); };
  need('path'); need('provenance'); need('licenceName'); need('licenceRef');
  if (!/^[0-9a-f]{64}$/.test(r.sha256 ?? '')) p.push('sha256 must be the 64-hex hash of the file being approved');
  if (!Array.isArray(r.permittedUses) || !r.permittedUses.length || r.permittedUses.some((u) => !USES.includes(u as Use) || LOCAL_FREE_USES.includes(u as Use))) p.push(`permittedUses must list one or more of ${USES.filter((u) => !LOCAL_FREE_USES.includes(u)).join(', ')} (local deterministic tests and local evaluation need no approval)`);
  if (!Array.isArray(r.licencePermitsUses)) p.push('licencePermitsUses must list the uses the licence text permits');
  if (!SENSITIVITIES.includes(r.sensitivity as Sensitivity)) p.push(`sensitivity must be one of ${SENSITIVITIES.join(', ')}`);
  if (r.sensitivity === 'unknown') p.push('sensitivity "unknown" cannot be approved: a person must classify the data first');
  for (const u of (r.permittedUses ?? [])) { if (Array.isArray(r.licencePermitsUses) && !r.licencePermitsUses.includes(u)) p.push(`permitted use "${u}" is not covered by the recorded licence`); }
  if ((r.permittedUses ?? []).some((u) => EXTERNAL_USES.includes(u))) {
    if (r.externalProcessing !== 'approved') p.push('an external use needs externalProcessing = approved');
    if (!r.dpaRef?.trim()) p.push('an external use needs dpaRef (the signed data-processing agreement)');
    if (!EXTERNAL_OK_SENSITIVITIES.includes(r.sensitivity as Sensitivity)) p.push(`an external use is not allowed for sensitivity "${r.sensitivity}" (allowed: ${EXTERNAL_OK_SENSITIVITIES.join(', ')})`);
    if (r.sensitivity === 'deidentified' && (!r.deidentificationRef?.trim() || !r.consentRef?.trim())) p.push('deidentified data for an external use needs consentRef and deidentificationRef');
  }
  if ((r.permittedUses ?? []).includes('fine_tuning')) { if (!r.consentRef?.trim() || !r.deidentificationRef?.trim() || !r.datasetCardSha256 || !/^[0-9a-f]{64}$/.test(r.datasetCardSha256)) p.push('fine_tuning needs consentRef, deidentificationRef and datasetCardSha256 (hash of the completed dataset card and readiness checklist)'); }
  if ((r.permittedUses ?? []).includes('clinical_evidence') && !r.clinicalOwnerRef?.trim()) p.push('clinical_evidence needs clinicalOwnerRef (the accountable clinical owner)');
  return p;
}

/**
 * The single decision function. `latest` is the most recent decision for the approval record (or null). Every failure adds a reason; nothing is "allowed" by default.
 * `fields` are the columns the caller intends to use; narrative and identifier-like columns are blocked from external uses unless the approval names them in externalFieldsReleased.
 */
export function evaluateUse(file: FileIdentity, currentSha256: string, use: Use, approval: ApprovalRecord | null, latest: Decision | null, fields: string[] = []): UseCheck {
  if (LOCAL_FREE_USES.includes(use)) { if (currentSha256 !== file.sha256) return { allowed: false, status: 'integrity_failure', reasons: ['the file no longer matches its registered SHA-256 (tampered, replaced or corrupted)'], blockedFields: [] }; return { allowed: true, status: 'local_only', reasons: [], blockedFields: [] }; }
  const reasons: string[] = [];
  if (!approval) reasons.push('no approval record exists (status: unknown — blocked from external processing)');
  else {
    if (approval.path !== file.path) reasons.push('the approval record is for a different file');
    if (approval.sha256 !== currentSha256) reasons.push('the file changed since the approval was recorded (SHA-256 mismatch): the approval does not apply to these bytes');
    if (!latest || latest.decision !== 'approve') reasons.push(latest?.decision === 'revoke' ? 'the approval was revoked' : 'the approval has not been approved by a second person');
    else if (latest.decidedBy === approval.recordedBy) reasons.push('the approver must be a different person from the person who recorded the approval');
    if (!approval.permittedUses.includes(use)) reasons.push(`"${use}" is not among the permitted uses (${approval.permittedUses.join(', ') || 'none'})`);
    const content = validateApprovalContent(approval); if (content.length) reasons.push(`the approval record is incomplete: ${content.join('; ')}`);
    if (EXTERNAL_USES.includes(use) && approval.externalProcessing !== 'approved') reasons.push('external processing is not approved');
    if (EXTERNAL_USES.includes(use) && !EXTERNAL_OK_SENSITIVITIES.includes(approval.sensitivity)) reasons.push(`external use is blocked for sensitivity "${approval.sensitivity}"`);
  }
  const restricted = new Set([...file.narrativeColumns, ...file.identifierColumns]); const released = new Set(approval?.externalFieldsReleased ?? []);
  const blockedFields = EXTERNAL_USES.includes(use) ? fields.filter((f) => restricted.has(f) && !released.has(f)) : [];
  if (blockedFields.length) reasons.push(`narrative / identifier-like fields are blocked from external processing unless the approval releases them explicitly: ${blockedFields.join(', ')}`);
  return { allowed: reasons.length === 0, reasons, blockedFields, status: reasons.length === 0 ? 'approved_for_use' : approval ? 'approval_not_applicable' : defaultStatus() };
}
