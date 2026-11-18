/**
 * Policy readiness report (PURE). Lists what is missing before a real-study policy could even be REVIEWED for activation, and links each item to the document that owns the decision.
 * `eligibleForActivation` is ALWAYS false: completing every item changes nothing because the approved-protocol gate does not exist. No recommendation, threshold or value is produced.
 */
import { ACTIVATION_GATE_AVAILABLE, FIELD_DEFS, Policy, missingRequired } from './policy';

export interface Link { label: string; path: string }
export interface ReadinessItem { category: 'missing_field' | 'missing_source_reference' | 'missing_external_decision_reference' | 'missing_independent_review_reference' | 'missing_review_record' | 'infrastructure_gate'; id: string; description: string; links: Link[] }
const W = (anchor: string): Link => ({ label: `Clinician worksheet ${anchor}`, path: 'docs/CLINICAL-LEAD-WORKSHEET.md' });
const P = (sec: string): Link => ({ label: `OCR protocol packet ${sec}`, path: 'docs/OCR-PROTOCOL-REVIEW-PACKET.md' });
const G = (d: string): Link => ({ label: `Governance decision ${d}`, path: 'docs/GOVERNANCE-DECISION-PACK.md' });
export const FIELD_LINKS: Record<string, Link[]> = {
  confidenceFlagThreshold: [W('CL-04'), P('§5, §15'), G('D20')], enabledReviewFlags: [W('CL-04'), P('§5')], severityMap: [W('CL-03'), P('§4')], humanConfirmation: [W('CL-04'), P('§5')], secondReaderRule: [W('CL-04'), P('§5, §7')],
  unitEquivalence: [W('CL-04'), P('§6')], annotationTolerance: [W('CL-09'), P('§7, §10')], minTruthItems: [W('CL-09'), P('§8, §10')], minDocuments: [W('CL-09'), P('§3, §10')], calibrationBins: [W('CL-09'), P('§10')],
  acceptanceCriteriaRef: [W('CL-09'), P('§8')], stoppingRulesRef: [W('CL-09'), P('§8')], independentReviewRequirementsRef: [W('CL-09'), P('§10')],
};
export const INFRA_GATES: Array<{ id: string; description: string; links: Link[] }> = [
  { id: 'approved_protocol_gate', description: 'The approved-protocol gate that would be required to activate a real-study policy does not exist in this build (ACTIVATION_GATE_AVAILABLE = false).', links: [G('D20'), { label: 'OCR study policy §3', path: 'docs/OCR-STUDY-POLICY.md' }] },
  { id: 'external_authorization_record', description: 'An externally recorded human authorization reference is required and cannot be verified by this software.', links: [G('D20'), W('CL-09')] },
  { id: 'production_storage', description: 'Production object storage (StudyObjectStore) is not implemented; the synthetic adapter refuses real data.', links: [G('D17'), { label: 'Threat model §6', path: 'docs/OCR-STUDY-THREAT-MODEL.md' }] },
  { id: 'identity_mfa', description: 'SSO/MFA for study users does not exist; password re-entry is not a second factor.', links: [G('D17'), { label: 'Threat model AC-6', path: 'docs/OCR-STUDY-THREAT-MODEL.md' }] },
  { id: 'penetration_test', description: 'No independent penetration test or authorization review has been done.', links: [{ label: 'Production readiness plan §4', path: 'docs/PRODUCTION-READINESS-PLAN.md' }] },
  { id: 'ethics_data_agreements', description: 'Ethics approval, data-use agreements, DPAs and a verified de-identification process are not on file.', links: [G('D09, D10'), P('§9')] },
];
export interface ReviewState { submitted: boolean; decision: 'reviewed' | 'changes_requested' | null; policySha256: string | null; externalDecisionRef: string | null; externalSignatureRef: string | null }
export function readinessReport(p: Policy, review: ReviewState) {
  const items: ReadinessItem[] = [];
  for (const k of missingRequired(p)) items.push({ category: 'missing_field', id: k, description: `Field "${k}" is unconfigured.`, links: FIELD_LINKS[k] ?? [] });
  for (const d of FIELD_DEFS) { const f = p.fields[d.key]; if (f?.status === 'configured' && !f.sourceRef.trim()) items.push({ category: 'missing_source_reference', id: d.key, description: `Field "${d.key}" has no source reference.`, links: FIELD_LINKS[d.key] ?? [] }); }
  if (!p.clinicalLeadDecisionRef?.trim()) items.push({ category: 'missing_external_decision_reference', id: 'clinicalLeadDecisionRef', description: 'No external clinical-lead decision reference is recorded on the policy.', links: [W('CL-01…CL-09'), G('D20')] });
  if (!p.independentReviewRef?.trim()) items.push({ category: 'missing_independent_review_reference', id: 'independentReviewRef', description: 'No independent-review reference is recorded on the policy.', links: [P('§10'), G('D20')] });
  const current = review.submitted && review.policySha256 === p.sha256;
  if (!current || review.decision !== 'reviewed') items.push({ category: 'missing_review_record', id: 'two_person_review', description: !review.submitted ? 'This policy version has not been submitted for two-person review.' : review.decision === 'changes_requested' ? 'The reviewer requested changes for this version.' : 'No recorded review for this exact policy version.', links: [{ label: 'OCR study policy §7', path: 'docs/OCR-STUDY-POLICY.md' }] });
  else { if (!review.externalDecisionRef?.trim()) items.push({ category: 'missing_external_decision_reference', id: 'review.externalDecisionRef', description: 'The review carries no external decision reference.', links: [G('D20')] }); if (!review.externalSignatureRef?.trim()) items.push({ category: 'missing_external_decision_reference', id: 'review.externalSignatureRef', description: 'The review carries no external signature reference.', links: [G('D20')] }); }
  for (const g of INFRA_GATES) items.push({ category: 'infrastructure_gate', id: g.id, description: g.description, links: g.links });
  return { schema: 'anuclaw-ocr-policy-readiness/v1', eligibleForActivation: false as const, banner: 'NOT ELIGIBLE FOR ACTIVATION — regardless of completion. DRAFT ONLY — REAL-STUDY ACTIVATION BLOCKED.', activationGateAvailable: ACTIVATION_GATE_AVAILABLE,
    statement: 'References are recorded, not verified. A recorded review is not an approval. This report makes no clinical recommendation and selects no value.', policy: { id: p.policyId, version: p.version, sha256: p.sha256, kind: p.kind }, counts: { total: items.length, byCategory: items.reduce<Record<string, number>>((a, i) => { a[i.category] = (a[i.category] ?? 0) + 1; return a; }, {}) }, items };
}
