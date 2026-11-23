/** Deterministic governance (P4a): positions, flags, referral triggers, routing. Pure; synthetic data only. */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../../cds/hashing';
import { BEAIVE_GOVERNANCE, beaiveAdapter } from '../adapters/beaive';
import type { NormalizedFinding, NormalizedFlag } from '../adapters/types';
import { validateGovernance } from '../contracts/validate';
import { ADVISORY } from '../reports/advisory';
import { EMPTY_CONTEXT, FindingsDoc, GovernanceContext, computePosition, governFindings } from './index';

const NOW = Date.parse('2026-08-21T09:00:00Z');
const CAPTURED = '2026-08-20T08:31:00Z';
const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));

function docOf(findings: NormalizedFinding[], flags: NormalizedFlag[] = [], capturedAt = CAPTURED): FindingsDoc {
  return {
    schemaVersion: 'normalized-findings/v1', jobId: 'job_x', tenantId: 't', skillId: 's', subjectRef: 'r', capturedAt, findings, flags,
    provenance: { adapter: { id: 'a', version: '1' }, sourceModel: {}, ruleset: { id: 'i', version: '1' }, originalPayloadSha256: 'a'.repeat(64) },
    findingsSha256: contentHash({ findings, flags }),
  };
}
const f = (key: string, value: number | string | null, extra: Partial<NormalizedFinding> = {}): NormalizedFinding =>
  ({ findingKey: key, sourceKey: key, label: key, valueStatus: value === null ? 'missing' : 'stated', value, ...extra });
const ref = (r: Partial<NonNullable<NormalizedFinding['reference']>>) => ({ origin: 'tenant_supplied' as const, ...r });
const pos = (x: NormalizedFinding) => computePosition(x);

describe('positions', () => {
  const range = ref({ lower: 60, upper: 100, lowerInclusive: true, upperInclusive: true });
  it('classifies a point against inclusive bounds', () => {
    expect(pos(f('k', 80, { reference: range })).position).toBe('within');
    expect(pos(f('k', 107, { reference: range }))).toMatchObject({ position: 'above', basis: 'numeric_reference' });
    expect(pos(f('k', 59, { reference: range })).position).toBe('below');
    expect(pos(f('k', 60, { reference: range })).position).toBe('within');
    expect(pos(f('k', 100, { reference: range })).position).toBe('within');
  });
  it('honours stated exclusivity on a bound', () => {
    expect(pos(f('k', 129, { reference: ref({ upper: 129, upperInclusive: false }) })).position).toBe('above');
    expect(pos(f('k', 95, { reference: ref({ lower: 95, lowerInclusive: false }) })).position).toBe('below');
    expect(pos(f('k', 96, { reference: ref({ lower: 95, lowerInclusive: false }) })).position).toBe('within');
  });
  it('is indeterminate on a bound whose inclusivity the source did not state', () => {
    expect(pos(f('k', 100, { reference: ref({ lower: 60, upper: 100 }) }))).toMatchObject({ position: 'indeterminate', basis: 'boundary_inclusivity_unstated' });
    expect(pos(f('k', 60, { reference: ref({ lower: 60, upper: 100 }) })).position).toBe('indeterminate');
    expect(pos(f('k', 80, { reference: ref({ lower: 60, upper: 100 }) })).position).toBe('within'); // unstated inclusivity does not matter away from the bound
  });
  it('handles one-sided references', () => {
    expect(pos(f('k', 5, { reference: ref({ lower: 6, lowerInclusive: false }) })).position).toBe('below');
    expect(pos(f('k', 6.89, { reference: ref({ upper: 5.7, upperInclusive: false }) })).position).toBe('above');
  });
  it('uses the uncertainty interval: straddling a bound is indeterminate, wholly outside is not', () => {
    expect(pos(f('k', 98, { reference: range, uncertainty: { plusMinus: 5 } }))).toMatchObject({ position: 'indeterminate', basis: 'uncertainty_straddles_bound' });
    expect(pos(f('k', 120, { reference: range, uncertainty: { plusMinus: 5 } }))).toMatchObject({ position: 'above', basis: 'numeric_reference' });
    expect(pos(f('k', 80, { reference: range, uncertainty: { plusMinus: 5 } })).position).toBe('within');
    expect(pos(f('k', 80, { reference: range, uncertainty: { interval: [50, 90] } })).position).toBe('indeterminate');
    expect(pos(f('k', 105, { reference: range, uncertainty: { interval: [101, 110] } })).position).toBe('above');
  });
  it('never calls a value normal or abnormal against a draft, text-only or absent reference', () => {
    expect(pos(f('k', 5, { reference: ref({ lower: 0, upper: 1, status: 'draft' }) }))).toMatchObject({ position: 'no_reference', basis: 'draft_reference' });
    expect(pos(f('k', 14.4, { reference: ref({ text: 'M:14-18, F:12-16' }) }))).toMatchObject({ position: 'no_reference', basis: 'text_only_reference' });
    expect(pos(f('k', 1.2, { reference: ref({ value: 0, kind: 'geometric' } as any) }))).toMatchObject({ position: 'no_reference', basis: 'text_only_reference' });
    expect(pos(f('k', 5))).toMatchObject({ position: 'no_reference', basis: 'no_reference' });
  });
  it('marks missing, excluded and non-numeric values not applicable', () => {
    expect(pos(f('k', null, { reference: range }))).toMatchObject({ position: 'not_applicable', basis: 'missing_value' });
    expect(pos(f('k', 5, { reference: range, excluded: { reason: 'x' } }))).toMatchObject({ position: 'not_applicable', basis: 'excluded' });
    expect(pos(f('k', 'High', { reference: range }))).toMatchObject({ position: 'not_applicable', basis: 'non_numeric_value' });
  });
});

describe('governing the beAIve example', () => {
  const run = beaiveAdapter.run({ ...example, subject: { externalRef: 'r', demographics: example.subject.demographics } });
  const doc = docOf(run.findings, run.flags);
  const g = governFindings(doc, BEAIVE_GOVERNANCE, NOW);
  const p = (k: string) => g.positions.find((x) => x.findingKey === k)!.position;

  it('computes positions only where the source gave a usable reference', () => {
    expect(p('bp_systolic_mmhg')).toBe('above'); expect(p('bp_diastolic_mmhg')).toBe('above'); expect(p('heart_rate_bpm')).toBe('above');
    expect(p('breathing_rate_per_min')).toBe('within'); expect(p('spo2_percent')).toBe('within'); expect(p('stress_index')).toBe('within');
    expect(p('wellness_score')).toBe('below'); expect(p('hba1c_percent')).toBe('above');
    expect(p('hemoglobin_g_dl')).toBe('no_reference'); // sex-dependent range unresolved without sexAtBirth
    expect(p('bp')).toBe('not_applicable'); // "154/94" as a string
    expect(p('unmapped.pnn_missing_example')).toBe('not_applicable');
  });
  it('keeps the adapter flags and adds one out_of_source_range flag per out-of-range finding', () => {
    expect(g.flags.slice(0, doc.flags.length)).toEqual(doc.flags);
    const oor = g.flags.filter((x) => x.type === 'out_of_source_range').flatMap((x) => x.findingKeys!);
    expect(oor.sort()).toEqual(['bp_diastolic_mmhg', 'bp_systolic_mmhg', 'hba1c_percent', 'heart_rate_bpm', 'wellness_score']);
  });
  it('triggers the referral advisory (risk indicators flagged high; high-risk values out of range) with static text ids', () => {
    expect(g.referral).toMatchObject({ level: 'see_clinician_soon', textId: ADVISORY.id, textVersion: ADVISORY.version });
    const codes = g.referral!.reasons.map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['risk_indicator_flagged', 'high_risk_outside_reference', 'under_research_high', 'multiple_attention_on_high_risk']));
    expect(g.referral!.reasons.find((r) => r.code === 'risk_indicator_flagged')!.findingKeys).toEqual(['bp_risk_category', 'hba1c_risk_category', 'fasting_glucose_risk_category']);
    expect(g.advisory).toEqual({ id: ADVISORY.id, version: ADVISORY.version, status: ADVISORY.status });
  });
  it('does not block: no blocking flag, so it is eligible for the automatic AI review, with a queue follow-up', () => {
    expect(g.route).toEqual({ state: 'eligible_for_ai_review', reasons: [], followUp: true });
  });
  it('validates against governance/v1, is deterministic, and binds to the findings hash', () => {
    expect(validateGovernance(g)).toEqual({ ok: true });
    expect(contentHash(governFindings(doc, BEAIVE_GOVERNANCE, NOW))).toBe(contentHash(g));
    expect(g.findingsSha256).toBe(doc.findingsSha256);
    expect(g.evaluatedAt).toBe('2026-08-21T09:00:00.000Z');
  });
});

describe('flags', () => {
  const gv = (findings: NormalizedFinding[], over: Partial<GovernanceContext> = {}, flags: NormalizedFlag[] = [], capturedAt = CAPTURED) =>
    governFindings(docOf(findings, flags, capturedAt), { ...EMPTY_CONTEXT, ...over }, NOW);
  const of = (g: ReturnType<typeof gv>, type: string) => g.flags.filter((x) => x.type === type);

  it('an impossible value is a BLOCKING implausible_value flag (value untouched), routes to a clinician and triggers the advisory', () => {
    const g = gv([f('heart_rate_bpm', 400, { unit: 'bpm' })], { plausibleRanges: { heart_rate_bpm: [20, 250] } });
    expect(of(g, 'implausible_value')).toEqual([expect.objectContaining({ severity: 'blocking', findingKeys: ['heart_rate_bpm'] })]);
    expect(JSON.stringify(g)).not.toContain('400'); // the flag text does not echo the value
    expect(g.route).toEqual({ state: 'awaiting_clinician', reasons: ['implausible_value'], followUp: true });
    expect(g.referral!.reasons.map((r) => r.code)).toEqual(['blocking_flag']);
  });
  it('a plausible value raises nothing; a missing or excluded value is not checked', () => {
    expect(of(gv([f('heart_rate_bpm', 72)], { plausibleRanges: { heart_rate_bpm: [20, 250] } }), 'implausible_value')).toHaveLength(0);
    expect(of(gv([f('heart_rate_bpm', null)], { plausibleRanges: { heart_rate_bpm: [20, 250] } }), 'implausible_value')).toHaveLength(0);
    expect(of(gv([f('heart_rate_bpm', 999, { excluded: { reason: 'x' } })], { plausibleRanges: { heart_rate_bpm: [20, 250] } }), 'implausible_value')).toHaveLength(0);
  });
  it('a different stated unit is blocking; the same unit in other spelling, or no unit, is not', () => {
    const ctx = { expectedUnits: { heart_rate_bpm: 'bpm' } };
    expect(of(gv([f('heart_rate_bpm', 80, { unit: 'bps' })], ctx), 'unit_mismatch')).toHaveLength(1);
    expect(gv([f('heart_rate_bpm', 80, { unit: 'bps' })], ctx).route.state).toBe('awaiting_clinician');
    expect(of(gv([f('heart_rate_bpm', 80, { unit: ' BPM ' })], ctx), 'unit_mismatch')).toHaveLength(0);
    expect(of(gv([f('heart_rate_bpm', 80)], ctx), 'unit_mismatch')).toHaveLength(0);
  });
  it('flags a contradiction when the source flag disagrees with its own range (both directions), and not when they agree', () => {
    const r = ref({ lower: 60, upper: 100, lowerInclusive: true, upperInclusive: true });
    expect(of(gv([f('a', 107, { reference: r, sourceFlag: 'normal' })]), 'contradiction')).toHaveLength(1);
    expect(of(gv([f('a', 80, { reference: r, sourceFlag: 'high' })]), 'contradiction')).toHaveLength(1);
    expect(of(gv([f('a', 50, { reference: r, sourceFlag: 'high' })]), 'contradiction')).toHaveLength(1);
    expect(of(gv([f('a', 80, { reference: r, sourceFlag: 'low' })]), 'contradiction')).toHaveLength(1);
    expect(of(gv([f('a', 107, { reference: r, sourceFlag: 'high' })]), 'contradiction')).toHaveLength(0);
    expect(of(gv([f('a', 80, { reference: r, sourceFlag: 'normal' })]), 'contradiction')).toHaveLength(0);
    expect(of(gv([f('a', 107, { sourceFlag: 'normal' })]), 'contradiction')).toHaveLength(0); // no reference: nothing to contradict
    expect(of(gv([f('a', 107, { reference: { ...r, status: 'draft' }, sourceFlag: 'normal' })]), 'contradiction')).toHaveLength(0); // never against a draft
  });
  it('flags low source confidence', () => {
    expect(of(gv([f('a', 1, { confidence: 0.2 })]), 'low_confidence')).toHaveLength(1);
    expect(of(gv([f('a', 1, { confidence: 0.5 })]), 'low_confidence')).toHaveLength(0);
    expect(of(gv([f('a', 1)]), 'low_confidence')).toHaveLength(0);
  });
  it('flags a stale, future or unreadable capture time', () => {
    expect(of(gv([f('a', 1)], {}, [], '2026-06-01T00:00:00Z'), 'stale_capture')).toHaveLength(1);
    expect(of(gv([f('a', 1)], {}, [], '2026-08-20T00:00:00Z'), 'stale_capture')).toHaveLength(0);
    expect(of(gv([f('a', 1)], {}, [], '2026-09-01T00:00:00Z'), 'review_required').map((x) => x.detail)).toEqual(['The capture time is in the future.']);
    expect(of(gv([f('a', 1)], {}, [], 'not a time'), 'review_required')).toHaveLength(1);
  });
  it('skips excluded findings entirely', () => {
    const g = gv([f('a', 999, { excluded: { reason: 'x' }, confidence: 0.1, sourceFlag: 'normal', reference: ref({ upper: 1, upperInclusive: true }) })], { plausibleRanges: { a: [0, 10] } });
    expect(g.flags).toHaveLength(0);
  });
});

describe('referral triggers (each in isolation, with a negative case)', () => {
  const ctx: GovernanceContext = { riskIndicatorKeys: ['risk_k'], highRiskKeys: ['hr_k', 'sp_k'], plausibleRanges: { odd: [0, 10] }, expectedUnits: {} };
  const gv = (findings: NormalizedFinding[], flags: NormalizedFlag[] = []) => governFindings(docOf(findings, flags), ctx, NOW);
  const codes = (g: ReturnType<typeof gv>) => g.referral?.reasons.map((r) => r.code) ?? [];
  const r = ref({ lower: 60, upper: 100, lowerInclusive: true, upperInclusive: true });

  it('(a) a risk-category indicator flagged high or review by the source', () => {
    expect(codes(gv([f('risk_k', 'High', { sourceFlag: 'high' })]))).toEqual(['risk_indicator_flagged']);
    expect(codes(gv([f('risk_k', 'Check', { sourceFlag: 'review' })]))).toEqual(['risk_indicator_flagged']);
    expect(gv([f('risk_k', 'Normal', { sourceFlag: 'normal' })]).referral).toBeNull();
    expect(gv([f('other_k', 'High', { sourceFlag: 'high' })]).referral).toBeNull(); // not a declared risk indicator
  });
  it('(b) a high-risk finding outside the reference the source supplied', () => {
    expect(codes(gv([f('hr_k', 107, { reference: r })]))).toEqual(['high_risk_outside_reference']);
    expect(codes(gv([f('hr_k', 40, { reference: r })]))).toEqual(['high_risk_outside_reference']);
    expect(gv([f('hr_k', 80, { reference: r })]).referral).toBeNull();
    expect(gv([f('plain_k', 107, { reference: r })]).referral).toBeNull(); // out of range but not a high-risk finding
    expect(gv([f('hr_k', 107, { reference: { ...r, status: 'draft' } })]).referral).toBeNull(); // never against a draft
  });
  it('(c) any blocking flag, from the adapter or from governance', () => {
    expect(codes(gv([f('odd', 99)]))).toEqual(['blocking_flag']); // governance: implausible
    expect(codes(gv([f('x', 1)], [{ type: 'unverified_source', severity: 'blocking', detail: 'd' }]))).toEqual(['blocking_flag']);
    expect(gv([f('x', 1)], [{ type: 'missing_data', severity: 'attention', findingKeys: ['x'], detail: 'd' }]).referral).toBeNull();
  });
  it('(d) two or more attention flags on high-risk indicators', () => {
    const two = gv([f('sp_k', 97, { reference: r, sourceFlag: 'low', confidence: 0.2 })]); // contradiction + low_confidence, value within
    expect(codes(two)).toEqual(['multiple_attention_on_high_risk']);
    expect(gv([f('sp_k', 80, { reference: r, confidence: 0.2 })]).referral).toBeNull(); // only one attention flag
    expect(gv([f('plain_k', 97, { reference: r, sourceFlag: 'low', confidence: 0.2 })]).referral).toBeNull(); // not on a high-risk indicator
  });
  it('(e) an under-research estimate the source itself flags high', () => {
    expect(codes(gv([f('exp_k', 'High', { underResearch: true, sourceFlag: 'high' })]))).toEqual(['under_research_high']);
    expect(gv([f('exp_k', 'High', { underResearch: true, sourceFlag: 'normal' })]).referral).toBeNull();
    expect(gv([f('exp_k', 'High', { underResearch: false, sourceFlag: 'high' })]).referral).toBeNull();
  });
  it('excluded findings never trigger the advisory', () => {
    expect(gv([f('risk_k', 'High', { sourceFlag: 'high', excluded: { reason: 'x' } })]).referral).toBeNull();
    expect(gv([f('hr_k', 107, { reference: r, excluded: { reason: 'x' } })]).referral).toBeNull();
  });
  it('lists every trigger that applies, and names the static text by id and version only', () => {
    const g = gv([f('risk_k', 'High', { sourceFlag: 'high' }), f('hr_k', 107, { reference: r })]);
    expect(codes(g)).toEqual(['risk_indicator_flagged', 'high_risk_outside_reference']);
    expect(g.referral).toMatchObject({ level: 'see_clinician_soon', textId: 'referral-advisory', textVersion: ADVISORY.version });
    expect(JSON.stringify(g)).not.toContain(ADVISORY.layman); // the wording is inserted by the report assembler, never carried here
  });
  it('no trigger: no referral, no advisory, eligible for AI review, and no follow-up when there is nothing to attend to', () => {
    const g = gv([f('plain_k', 80, { reference: r })]);
    expect(g.referral).toBeNull(); expect(g.advisory).toBeNull();
    expect(g.route).toEqual({ state: 'eligible_for_ai_review', reasons: [], followUp: false });
  });
});

describe('routing', () => {
  it('only a blocking flag holds the report for a clinician', () => {
    const attention: NormalizedFlag = { type: 'missing_data', severity: 'attention', detail: 'd' };
    const blocking: NormalizedFlag = { type: 'symptom_reported', severity: 'blocking', detail: 'd' };
    expect(governFindings(docOf([f('a', 1)], [attention]), EMPTY_CONTEXT, NOW).route).toEqual({ state: 'eligible_for_ai_review', reasons: [], followUp: true });
    expect(governFindings(docOf([f('a', 1)], [blocking]), EMPTY_CONTEXT, NOW).route).toEqual({ state: 'awaiting_clinician', reasons: ['symptom_reported'], followUp: true });
  });
});
