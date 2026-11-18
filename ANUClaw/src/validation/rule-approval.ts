/**
 * Clinical rule approval DOSSIER checker (plan §15 phase 3/5, docs/CLINICAL-CONTENT-RELEASE.md).
 *
 * It checks that a dossier is COMPLETE and INTERNALLY CONSISTENT and runs its boundary cases against the rule's evaluator.
 * It can never approve anything: approval is a named human's signed record. Its strongest possible output is
 * `complete_awaiting_human_decision`, or `signed_record_asserted_unverified` when the dossier carries a signature block —
 * the software cannot verify that person's identity or authority.
 */
import { requireSchema } from './common';

export type BoundaryKind = 'below_lower' | 'at_lower' | 'inside' | 'at_upper' | 'above_upper' | 'missing_input' | 'unit_mismatch' | 'outside_population' | 'implausible_value';
export interface BoundaryCase { id: string; kind: BoundaryKind; input: Record<string, unknown>; expected: string; rationale: string }
export interface RuleDossier {
  schema: 'anuclaw-rule-approval/v1';
  rule: { id: string; version: string; title: string; category: 'clinical' };
  intendedUse: string;
  population: { included: string[]; excluded: string[] };
  source: { citation: string; version: string; license: string; url?: string };
  thresholds: Array<{ name: string; lower?: number; upper?: number; unit: string; lowerInclusive?: boolean; upperInclusive?: boolean }>;
  inputs: Array<{ name: string; unit: string }>;
  boundaryCases: BoundaryCase[];
  evaluationPlan: { documentRef: string; acceptanceTargets: Record<string, number>; resultsRef?: string };
  reviewer: { name: string; role: string; credentialRef: string; independentOfAuthor: boolean; conflictOfInterestStatement: string } | null;
  signature: { statement: string; signedAt: string; recordRef: string } | null;
  changeControl: { previousVersion: string | null; changeSummary: string };
}
export interface Issue { severity: 'error' | 'warning'; code: string; message: string }
export interface BoundaryResult { id: string; kind: BoundaryKind; expected: string; actual: string | null; pass: boolean; note?: string }
export interface DossierReport {
  schema: 'anuclaw-rule-approval-report/v1'; ruleId: string; ruleVersion: string;
  status: 'incomplete' | 'complete_awaiting_human_decision' | 'signed_record_asserted_unverified';
  issues: Issue[]; boundaryResults: BoundaryResult[]; coverage: { required: BoundaryKind[]; present: BoundaryKind[]; missing: BoundaryKind[] };
  registerEntryDraft: Record<string, unknown> | null;
  statement: string;
}
export type RuleEvaluator = (input: Record<string, unknown>) => string;

const REQUIRED_KINDS: BoundaryKind[] = ['below_lower', 'at_lower', 'inside', 'at_upper', 'above_upper', 'missing_input', 'unit_mismatch'];
const PLACEHOLDER = /^(tbd|todo|n\/a|none|unknown|-|\?+|xxx+|lorem.*|placeholder.*|example.*)$/i;
const blank = (s: unknown) => typeof s !== 'string' || !s.trim() || PLACEHOLDER.test(s.trim());
const ISO_DAY = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

export function checkRuleDossier(d: RuleDossier, evaluator?: RuleEvaluator): DossierReport {
  requireSchema(d, 'anuclaw-rule-approval/v1', 'dossier');
  const issues: Issue[] = []; const err = (code: string, message: string) => issues.push({ severity: 'error', code, message }); const warn = (code: string, message: string) => issues.push({ severity: 'warning', code, message });

  if (blank(d.rule?.id) || blank(d.rule?.version) || blank(d.rule?.title)) err('rule_identity', 'rule id, version and title are required');
  if (d.rule?.category !== 'clinical') err('rule_category', 'only clinical rules go through approval');
  if (!/^\d+\.\d+\.\d+$/.test(d.rule?.version ?? '')) err('rule_version', 'version must be semantic (x.y.z)');
  if (blank(d.intendedUse) || (d.intendedUse ?? '').length < 30) err('intended_use', 'intended use must be a specific statement (≥ 30 characters)');
  if (!d.population?.included?.length || d.population.included.some(blank)) err('population', 'the intended population must be stated (age range, setting, context)');
  if (!Array.isArray(d.population?.excluded) || !d.population.excluded.length) err('exclusions', 'explicit exclusions are required (use ["none stated — justified: …"] only with a written justification)');
  if (blank(d.source?.citation) || blank(d.source?.version) || blank(d.source?.license)) err('source', 'source citation, version and licence are required');
  if (!d.thresholds?.length) err('thresholds', 'at least one threshold is required');
  for (const t of d.thresholds ?? []) {
    if (t.lower === undefined && t.upper === undefined) err('threshold_bounds', `threshold ${t.name}: a lower or upper bound is required`);
    if (t.lower !== undefined && t.upper !== undefined && !(t.lower < t.upper)) err('threshold_order', `threshold ${t.name}: lower must be below upper`);
    if (blank(t.unit)) err('threshold_unit', `threshold ${t.name}: unit is required`);
  }
  if (!d.inputs?.length) err('inputs', 'inputs (name and unit) must be declared');

  // boundary coverage
  const required: BoundaryKind[] = [...REQUIRED_KINDS, ...(d.population?.excluded?.length ? (['outside_population'] as BoundaryKind[]) : [])];
  const present = [...new Set((d.boundaryCases ?? []).map((c) => c.kind))];
  const missing = required.filter((k) => !present.includes(k));
  if (missing.length) err('boundary_coverage', `missing boundary case kinds: ${missing.join(', ')}`);
  const ids = new Set<string>();
  for (const c of d.boundaryCases ?? []) { if (ids.has(c.id)) err('case_id', `duplicate boundary case id ${c.id}`); ids.add(c.id); if (blank(c.expected) || blank(c.rationale)) err('case_fields', `case ${c.id}: expected result and rationale are required`); }

  // executable boundary check
  const boundaryResults: BoundaryResult[] = [];
  if (evaluator) {
    for (const c of d.boundaryCases ?? []) {
      let actual: string | null = null; let note: string | undefined;
      try { actual = evaluator(c.input); } catch (e) { note = `evaluator threw: ${(e as Error).message}`; }
      const pass = actual === c.expected; boundaryResults.push({ id: c.id, kind: c.kind, expected: c.expected, actual, pass, ...(note ? { note } : {}) });
      if (!pass) err('boundary_mismatch', `case ${c.id} (${c.kind}): expected "${c.expected}", rule returned ${actual === null ? 'an error' : `"${actual}"`}`);
    }
  } else warn('not_executed', 'no evaluator supplied: boundary cases were NOT executed against the rule');

  if (blank(d.evaluationPlan?.documentRef) || !d.evaluationPlan?.acceptanceTargets || !Object.keys(d.evaluationPlan.acceptanceTargets).length) err('evaluation_plan', 'a pre-specified evaluation plan with numeric acceptance targets is required');
  if (blank(d.evaluationPlan?.resultsRef)) warn('evaluation_results', 'no evaluation results reference yet (plan §16.2 requires locked evaluation results)');
  if (blank(d.changeControl?.changeSummary)) err('change_control', 'change summary is required');
  if (d.changeControl?.previousVersion && d.changeControl.previousVersion === d.rule?.version) err('change_control', 'previousVersion must differ from the version under review');

  if (!d.reviewer) err('reviewer', 'a named reviewer is required');
  else {
    if (blank(d.reviewer.name) || blank(d.reviewer.role) || blank(d.reviewer.credentialRef)) err('reviewer_identity', 'reviewer name, role and credential reference are required');
    if (d.reviewer.independentOfAuthor !== true) err('reviewer_independence', 'the reviewer must be independent of the rule author');
    if (blank(d.reviewer.conflictOfInterestStatement)) err('reviewer_coi', 'a conflict-of-interest statement is required');
  }
  if (d.signature) {
    if (!d.reviewer) err('signature_without_reviewer', 'a signature block needs a reviewer');
    if (blank(d.signature.statement) || blank(d.signature.recordRef) || !ISO_DAY.test(d.signature.signedAt ?? '')) err('signature_fields', 'signature needs statement, recordRef and an ISO signedAt');
    else if (Date.parse(d.signature.signedAt) > Date.now() + 5 * 60_000) err('signature_future', 'signedAt is in the future');
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const status: DossierReport['status'] = errors ? 'incomplete' : d.signature ? 'signed_record_asserted_unverified' : 'complete_awaiting_human_decision';
  const draft = !errors && d.signature && d.reviewer ? {
    ruleId: d.rule.id, ruleVersion: d.rule.version, approverName: d.reviewer.name, approverRole: d.reviewer.role, licenseOrCredentialRef: d.reviewer.credentialRef,
    approvedAt: d.signature.signedAt.slice(0, 10), evidence: `${d.source.citation} (${d.source.version}); evaluation: ${d.evaluationPlan.resultsRef ?? 'see plan'}`,
    population: d.population.included.join('; '), intendedUse: d.intendedUse, recordRef: d.signature.recordRef,
  } : null;
  return {
    schema: 'anuclaw-rule-approval-report/v1', ruleId: d.rule?.id, ruleVersion: d.rule?.version, status, issues, boundaryResults,
    coverage: { required, present, missing }, registerEntryDraft: draft,
    statement: 'This report checks completeness and runs boundary cases. It does NOT approve the rule, verify the reviewer, or establish clinical validity. A register entry may be added only by a pull request that attaches the reviewer\'s own signed record.',
  };
}
