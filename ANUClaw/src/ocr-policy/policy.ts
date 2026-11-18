/**
 * OCR study-policy record (PURE: no I/O). One versioned record holds every OCR policy value that used to be scattered as engineering defaults (confidence threshold, review flags,
 * severity map, unit equivalence, annotation tolerance, sample-size placeholders, reference fields for confirmation/second-reader/acceptance/stopping/independent review).
 *
 *  - A REAL-STUDY policy starts with every field "unconfigured". A field can be configured only with a value AND a source-reference string (presence of a reference is NOT verification
 *    or approval). Nothing in this module chooses a value.
 *  - A SYNTHETIC-TEST policy is a separate, explicitly labelled record for synthetic tooling. Its values are test values ("SYNTHETIC TEST VALUE") and are never a clinical or statistical choice.
 *  - There is no "active" real policy in this build: activation needs an externally recorded authorization AND independent-review reference AND an approved-protocol gate that does not exist
 *    (`ACTIVATION_GATE_AVAILABLE = false`), so real-study registration, real-data acceptance and acceptance-style reports always fail closed.
 */
import * as crypto from 'crypto';

export const ACTIVATION_GATE_AVAILABLE = false;
export const SYNTHETIC_LABEL = 'SYNTHETIC TEST VALUE — not a clinical or statistical choice';
export type PolicyKind = 'synthetic_test' | 'real_study';
export const ERROR_TYPES = ['value', 'comparator', 'unit', 'refLow', 'refHigh', 'page', 'missed_item', 'extraction_failure', 'extraneous_candidate'] as const;
export const REVIEW_FLAGS = ['missing_unit', 'inequality_value', 'comma_decimal_ambiguous', 'missing_reference_interval', 'ocr_source', 'ocr_low_confidence', 'lab_flag_present'] as const;
export type ReviewFlag = typeof REVIEW_FLAGS[number];
export interface UnitEquivalence { caseFold: boolean; microSignToU: boolean; stripWhitespace: boolean; equivalentGroups: string[][] }
export interface Tol { abs: number; rel: number }
export interface AnnotationTolerance { default: Tol; perField?: Partial<Record<'valueNum' | 'refLow' | 'refHigh', Tol>> }

export interface FieldDef { key: string; label: string; required: boolean; enforcedByCode: boolean; affects: string[]; note: string }
export const FIELD_DEFS: FieldDef[] = [
  { key: 'confidenceFlagThreshold', label: 'OCR confidence below which a candidate is flagged (0–1)', required: true, enforcedByCode: true, affects: ['src/documents/lab-parser.ts parseLabLines', 'src/validation/ocr-eval.ts evaluateOcr (uncertainty flag / silent errors)', 'src/validation/study/workspace.ts evaluate'], note: 'single value consumed by parser AND evaluation; a clinical/statistical decision, not an engineering default' },
  { key: 'enabledReviewFlags', label: 'Automatic review flags that are switched on', required: true, enforcedByCode: true, affects: ['src/documents/lab-parser.ts parseLabLines'], note: 'flags only change reviewer emphasis; every candidate still needs human confirmation' },
  { key: 'severityMap', label: 'Error type → severity label (descriptive)', required: true, enforcedByCode: true, affects: ['src/validation/study/workspace.ts evaluate (report errorTypes)', 'PUT /api/ocr-study/studies/:id/severity-map'], note: 'labels only; cannot accept a study' },
  { key: 'humanConfirmation', label: 'Human-confirmation requirement', required: true, enforcedByCode: true, affects: ['src/documents/workflow.ts createSnapshot (blocked while candidates are pending)'], note: 'the code enforces "every candidate decided"; the policy can declare it but cannot weaken it' },
  { key: 'secondReaderRule', label: 'Second-reader rule', required: true, enforcedByCode: true, affects: ['src/validation/study/workspace.ts buildTruth / checkSecondReader (mechanical: distinct assigned annotators and full case coverage only)'], note: 'none | all_values (every case completed by both distinct assigned annotators) | flagged_values (UNSUPPORTED: refused with second_reader_rule_unsupported). Quality is never interpreted and nothing is auto-accepted' },
  { key: 'unitEquivalence', label: 'Unit normalization / equivalence', required: true, enforcedByCode: true, affects: ['src/validation/ocr-eval.ts normUnit', 'src/aikosh/bench/loaders.ts normalizeUnit (benchmark)'], note: 'which unit spellings count as the same' },
  { key: 'annotationTolerance', label: 'Numeric annotation-agreement tolerance', required: true, enforcedByCode: true, affects: ['src/validation/study/agreement.ts compareAnnotators', 'src/validation/study/workspace.ts agreementReport / buildTruth'], note: 'how close two annotators must be to agree' },
  { key: 'minTruthItems', label: 'Structural minimum: truth items', required: true, enforcedByCode: true, affects: ['src/validation/ocr-eval.ts evaluateOcr (datasetAdequacy)'], note: 'sample-size placeholder from the statistician; a structural check only' },
  { key: 'minDocuments', label: 'Structural minimum: documents', required: true, enforcedByCode: true, affects: ['src/validation/ocr-eval.ts evaluateOcr (datasetAdequacy)'], note: 'sample-size placeholder from the statistician' },
  { key: 'calibrationBins', label: 'Calibration reliability-table bin count', required: true, enforcedByCode: true, affects: ['src/validation/study/workspace.ts evaluate (calibration)'], note: 'reporting configuration' },
  { key: 'acceptanceCriteriaRef', label: 'Reference to the acceptance criteria document', required: true, enforcedByCode: false, affects: ['(none: the software never evaluates acceptance)'], note: 'reference only; no acceptance function exists' },
  { key: 'stoppingRulesRef', label: 'Reference to the stopping-rules document', required: true, enforcedByCode: false, affects: ['(none: reference only)'], note: 'reference only' },
  { key: 'independentReviewRequirementsRef', label: 'Reference to independent-review requirements', required: true, enforcedByCode: false, affects: ['(none: reference only)'], note: 'reference only' },
];
export const FIELD_KEYS = FIELD_DEFS.map((f) => f.key);
export type FieldState = { status: 'unconfigured' } | { status: 'configured'; value: unknown; sourceRef: string; setBy: string; setAt: string };
export interface PolicyContent {
  policyId: string; version: number; kind: PolicyKind; fields: Record<string, FieldState>;
  clinicalLeadDecisionRef: string | null; independentReviewRef: string | null; prevSha256: string | null; createdBy: string; createdAt: string; note: string;
}
export interface Policy extends PolicyContent { sha256: string }
export const canonicalOf = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonicalOf).join(',')}]` : `{${Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalOf((v as Record<string, unknown>)[k])}`).join(',')}}`);
export const policyHash = (c: PolicyContent) => crypto.createHash('sha256').update(canonicalOf(c)).digest('hex');
export const seal = (c: PolicyContent): Policy => ({ ...c, sha256: policyHash(c) });
export class PolicyError extends Error { constructor(public readonly code: string, message: string, public readonly missing: string[] = []) { super(message); this.name = 'PolicyError'; } }

/** Effective state shown to users: a real policy is NEVER effective in this build. */
export function effectiveState(p: Policy | PolicyContent): string { return p.kind === 'synthetic_test' ? 'synthetic test policy — usable with synthetic data only' : `draft — not effective (activation gate unavailable${missingRequired(p).length ? `; ${missingRequired(p).length} required field(s) unconfigured` : ''})`; }
export function missingRequired(p: Pick<PolicyContent, 'fields'>): string[] { return FIELD_DEFS.filter((d) => d.required && p.fields[d.key]?.status !== 'configured').map((d) => d.key); }

/** Validates one field value (shape only; never judges clinical suitability). Returns problems. */
export function validateFieldValue(key: string, v: unknown): string[] {
  const num = (x: unknown, lo: number, hi: number, int = false) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi && (!int || Number.isInteger(x));
  switch (key) {
    case 'confidenceFlagThreshold': return num(v, 0, 1) ? [] : ['must be a number between 0 and 1'];
    case 'enabledReviewFlags': return Array.isArray(v) && v.every((f) => REVIEW_FLAGS.includes(f as ReviewFlag)) && new Set(v).size === v.length ? [] : [`must be a list of distinct flags from: ${REVIEW_FLAGS.join(', ')}`];
    case 'severityMap': { const o = v as Record<string, unknown>; if (!o || typeof o !== 'object' || Array.isArray(o)) return ['must be an object']; const p: string[] = []; for (const t of ERROR_TYPES) if (typeof o[t] !== 'string' || !/^[A-Za-z0-9 _-]{1,40}$/.test(o[t] as string)) p.push(`${t} needs a label of 1–40 plain characters`); for (const k of Object.keys(o)) if (!(ERROR_TYPES as readonly string[]).includes(k)) p.push(`unknown error type ${k}`); return p; }
    case 'humanConfirmation': return v === 'every_candidate_confirmed' ? [] : ['the only supported value is every_candidate_confirmed (the code cannot enforce less)'];
    case 'secondReaderRule': return ['none', 'flagged_values', 'all_values'].includes(v as string) ? [] : ['must be none, flagged_values or all_values'];
    case 'unitEquivalence': { const u = v as UnitEquivalence; return u && typeof u.caseFold === 'boolean' && typeof u.microSignToU === 'boolean' && typeof u.stripWhitespace === 'boolean' && Array.isArray(u.equivalentGroups) && u.equivalentGroups.every((g) => Array.isArray(g) && g.length >= 2 && g.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 30)) ? [] : ['must be {caseFold, microSignToU, stripWhitespace, equivalentGroups: string[][] (each ≥2 units)}']; }
    case 'annotationTolerance': { const t = v as AnnotationTolerance; const ok = (x: Tol | undefined) => !!x && num(x.abs, 0, 1e6) && num(x.rel, 0, 1); return t && ok(t.default) && Object.values(t.perField ?? {}).every(ok) ? [] : ['must be {default:{abs,rel≥0,rel≤1}, perField?}']; }
    case 'minTruthItems': case 'minDocuments': return num(v, 1, 1e7, true) ? [] : ['must be a positive integer'];
    case 'calibrationBins': return num(v, 1, 50, true) ? [] : ['must be an integer 1–50'];
    case 'acceptanceCriteriaRef': case 'stoppingRulesRef': case 'independentReviewRequirementsRef': return typeof v === 'string' && v.trim().length > 0 && v.length <= 300 ? [] : ['must be a non-empty reference string (≤300 chars)'];
    default: return [`unknown field ${key}`];
  }
}

const unconfigured = (): Record<string, FieldState> => Object.fromEntries(FIELD_KEYS.map((k) => [k, { status: 'unconfigured' as const }]));
export function blankRealPolicy(policyId: string, createdBy: string, now = new Date().toISOString()): Policy {
  return seal({ policyId, version: 1, kind: 'real_study', fields: unconfigured(), clinicalLeadDecisionRef: null, independentReviewRef: null, prevSha256: null, createdBy, createdAt: now, note: 'Every field is unconfigured until a human supplies it with a source reference. Not effective.' });
}
/** SYNTHETIC test values. They exist only so synthetic tooling can run; each carries the synthetic label and none is a recommendation. */
export const SYNTHETIC_VALUES: Record<string, unknown> = {
  confidenceFlagThreshold: 0.85, enabledReviewFlags: [...REVIEW_FLAGS], severityMap: Object.fromEntries(ERROR_TYPES.map((t) => [t, 'unassigned'])), humanConfirmation: 'every_candidate_confirmed', secondReaderRule: 'none',
  unitEquivalence: { caseFold: true, microSignToU: true, stripWhitespace: true, equivalentGroups: [] } satisfies UnitEquivalence, annotationTolerance: { default: { abs: 0, rel: 0 } } satisfies AnnotationTolerance, minTruthItems: 300, minDocuments: 30, calibrationBins: 10,
  acceptanceCriteriaRef: 'SYNTHETIC — none', stoppingRulesRef: 'SYNTHETIC — none', independentReviewRequirementsRef: 'SYNTHETIC — none',
};
export function syntheticPolicy(policyId = 'synthetic-test-policy', createdBy = 'system', now = '2026-11-18T00:00:00.000Z'): Policy {
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, { status: 'configured' as const, value: SYNTHETIC_VALUES[k], sourceRef: SYNTHETIC_LABEL, setBy: createdBy, setAt: now }]));
  return seal({ policyId, version: 1, kind: 'synthetic_test', fields, clinicalLeadDecisionRef: null, independentReviewRef: null, prevSha256: null, createdBy, createdAt: now, note: `${SYNTHETIC_LABEL}. For synthetic tooling only; never usable with real data.` });
}
export const SYNTHETIC_TEST_POLICY = syntheticPolicy();

/** Everything a consumer needs, resolved from ONE policy version. */
export interface OcrPolicyView {
  id: string; version: number; sha256: string; kind: PolicyKind; overridden: boolean;
  secondReaderRule: string; confidenceFlagThreshold: number; enabledReviewFlags: ReviewFlag[]; severityMap: Record<string, string>; unitEquivalence: UnitEquivalence; annotationTolerance: AnnotationTolerance; minTruthItems: number; minDocuments: number; calibrationBins: number;
}
export function viewOf(p: Policy): OcrPolicyView {
  const miss = missingRequired(p); if (miss.length) throw new PolicyError('policy_unconfigured', `Required policy fields are unconfigured: ${miss.join(', ')}.`, miss);
  const v = (k: string) => (p.fields[k] as { value: unknown }).value;
  return { id: p.policyId, version: p.version, sha256: p.sha256, kind: p.kind, overridden: false, secondReaderRule: v('secondReaderRule') as string, confidenceFlagThreshold: v('confidenceFlagThreshold') as number, enabledReviewFlags: v('enabledReviewFlags') as ReviewFlag[], severityMap: v('severityMap') as Record<string, string>, unitEquivalence: v('unitEquivalence') as UnitEquivalence,
    annotationTolerance: v('annotationTolerance') as AnnotationTolerance, minTruthItems: v('minTruthItems') as number, minDocuments: v('minDocuments') as number, calibrationBins: v('calibrationBins') as number };
}
export const SYNTHETIC_VIEW: OcrPolicyView = viewOf(SYNTHETIC_TEST_POLICY);
/** TEST HELPER: derive a view with some values replaced; the result is marked `overridden` and keeps the base identity, so reports show it. Only synthetic views may be overridden. */
export function withOverrides(base: OcrPolicyView, o: Partial<Pick<OcrPolicyView, 'secondReaderRule' | 'confidenceFlagThreshold' | 'minTruthItems' | 'minDocuments' | 'enabledReviewFlags' | 'severityMap' | 'unitEquivalence' | 'annotationTolerance' | 'calibrationBins'>>): OcrPolicyView {
  if (base.kind !== 'synthetic_test') throw new PolicyError('override_refused', 'only a synthetic test policy may be overridden');
  return { ...base, ...o, overridden: true };
}
export const stampOf = (v: OcrPolicyView) => ({ policyId: v.id, version: v.version, sha256: v.sha256, kind: v.kind, overridden: v.overridden });

export type Purpose = 'synthetic_tooling' | 'real_registration' | 'real_data_acceptance' | 'locked_evaluation' | 'acceptance_report';
/** The single gate. Real data and acceptance-style outputs fail closed in this build; synthetic data needs the synthetic policy. */
export function assertPolicyAllows(p: Policy, a: { purpose: Purpose; data: 'synthetic' | 'real' }): void {
  if (a.purpose === 'acceptance_report') throw new PolicyError('acceptance_report_not_available', 'No acceptance-style report exists or can be produced: acceptance is a human decision recorded outside this software.');
  if (a.data === 'real' || a.purpose === 'real_registration' || a.purpose === 'real_data_acceptance') {
    const miss = missingRequired(p);
    if (p.kind !== 'real_study') throw new PolicyError('synthetic_policy_with_real_data', 'The synthetic test policy can never be used with real data.', miss);
    throw new PolicyError('policy_not_active', `A real-study policy is not active${miss.length ? ` (required fields unconfigured: ${miss.join(', ')})` : ''}; activation needs an externally recorded authorization, an independent-review reference and an approved-protocol gate that does not exist in this build.`, miss);
  }
  if (p.kind !== 'synthetic_test') throw new PolicyError('policy_kind_mismatch', 'Synthetic data must use the synthetic test policy.');
  const miss = missingRequired(p); if (miss.length) throw new PolicyError('policy_unconfigured', `Required policy fields are unconfigured: ${miss.join(', ')}.`, miss);
}
/** Activation can be requested but never succeeds in this build. Refusal reasons are returned so they can be audited. */
export function requestActivation(p: Policy, refs: { authorizationRef?: string; independentReviewRef?: string }): never {
  const reasons: string[] = []; if (p.kind !== 'real_study') reasons.push('only a real-study policy can be activated'); const miss = missingRequired(p); if (miss.length) reasons.push(`unconfigured fields: ${miss.join(', ')}`);
  if (!refs.authorizationRef?.trim()) reasons.push('an externally recorded human authorization reference is required'); if (!refs.independentReviewRef?.trim()) reasons.push('an independent-review reference is required');
  reasons.push('the approved-protocol gate does not exist in this build (activation is blocked unconditionally)');
  throw new PolicyError('activation_blocked', `Activation refused: ${reasons.join('; ')}. A reference field is not verification or approval.`, miss);
}

// ── comparison / audit report ────────────────────────────────────────────────
export const AUDIT_STATEMENT = 'Presence of a source-reference field is NOT verification or approval of the source or of the value. This report makes no clinical recommendation and selects no threshold.';
export function policyAuditReport(p: Policy, runsUsing: Array<{ runId: string; mode: string; policyVersion: number | null; policySha256: string | null }> = []) {
  return { schema: 'anuclaw-ocr-policy-audit/v1', statement: AUDIT_STATEMENT, policy: { id: p.policyId, version: p.version, kind: p.kind, sha256: p.sha256, effectiveState: effectiveState(p), clinicalLeadDecisionRef: p.clinicalLeadDecisionRef, independentReviewRef: p.independentReviewRef, activationGateAvailable: ACTIVATION_GATE_AVAILABLE },
    requiredFieldsUnconfigured: missingRequired(p),
    fields: FIELD_DEFS.map((d) => { const s = p.fields[d.key]; return { key: d.key, label: d.label, required: d.required, status: s?.status ?? 'unconfigured', sourceReferencePresent: s?.status === 'configured' ? s.sourceRef.trim().length > 0 : false, sourceReferenceIsVerification: false,
      value: s?.status === 'configured' && p.kind === 'synthetic_test' ? s.value : s?.status === 'configured' ? 'configured (value in record)' : null, enforcedByCode: d.enforcedByCode, affectedCodePaths: d.affects, note: d.note }; }),
    runs: runsUsing.map((r) => ({ ...r, usesThisPolicyVersion: r.policySha256 === p.sha256 })) };
}
