/** Automatic review (interpretation engine, P4d). Pure: no database, no model. Synthetic data only. */
import { describe, expect, it } from 'vitest';
import { deterministicNarrative } from '../narrative/deterministic';
import { posture, vitals } from '../narrative/fixtures';
import type { Narrative } from '../narrative/types';
import { assembleLayers, type ReportLayerDoc } from './assemble';
import { automaticReview } from './review';

const GOV_SHA = 'b'.repeat(64);
function setup(f: ReturnType<typeof vitals> = vitals(), narrativeFlags: any[] = []) {
  const narratives = { clinical: deterministicNarrative('clinical', f.doc, f.gov), layman: deterministicNarrative('layman', f.doc, f.gov) } as Record<'clinical' | 'layman', Narrative>;
  const layers = assembleLayers({ doc: f.doc, gov: f.gov, narratives, narrativeFlags, governanceSha256: GOV_SHA, meta: { reportId: 'rpt_x', version: 1, narrativeMode: 'deterministic', modelRequested: null, modelReturned: null, promptVersions: { clinical: 'c', layman: 'l' } } });
  return { f, layers, narrativeFlags };
}
const review = (s: ReturnType<typeof setup>, layers = s.layers) => automaticReview(s.f.doc, s.f.gov, layers, GOV_SHA, s.narrativeFlags);
const clone = (l: Record<'clinical' | 'layman', ReportLayerDoc>) => JSON.parse(JSON.stringify(l)) as Record<'clinical' | 'layman', ReportLayerDoc>;
const failed = (r: ReturnType<typeof review>) => r.failedChecks;

describe('automatic review', () => {
  it('a clean report passes every check and is ai_reviewed', () => {
    const r = review(setup());
    expect(r).toMatchObject({ ok: true, state: 'ai_reviewed', failedChecks: [], reviewer: { id: 'automatic-review' } });
    expect(r.checks.map((c) => c.id)).toEqual(['layers_bound_to_findings', 'layers_identical_findings', 'rows_match_source', 'positions_match_governance', 'all_flags_surfaced', 'advisory_matches_governance', 'narrative_guards_pass', 'layers_cover_flagged_findings', 'no_blocking_flags', 'no_review_flag_from_narrative']);
  });

  it('a report with no advisory trigger passes too (the advisory must be absent then)', () => {
    const s = setup(posture('signed')); expect(s.f.gov.referral).toBeNull();
    expect(review(s).state).toBe('ai_reviewed');
  });

  it('can only ever return ai_reviewed or awaiting_clinician: never a signature', () => {
    for (const s of [setup(), setup(posture('unsigned')), setup(posture('signed'))]) expect(['ai_reviewed', 'awaiting_clinician']).toContain(review(s).state);
  });

  it('a blocking flag routes to awaiting_clinician (the other checks may still pass)', () => {
    const r = review(setup(posture('unsigned')));
    expect(r).toMatchObject({ ok: false, state: 'awaiting_clinician' }); expect(failed(r)).toEqual(['no_blocking_flags']);
  });

  it('a review_required flag from the narrative stage routes to awaiting_clinician', () => {
    const r = review(setup(vitals(), [{ type: 'review_required', severity: 'attention', detail: 'x' }]));
    expect(r.state).toBe('awaiting_clinician'); expect(failed(r)).toEqual(['no_review_flag_from_narrative']);
  });

  describe('each check catches its own tampering', () => {
    const s = setup();
    it('layers_bound_to_findings: a layer from other findings', () => { const l = clone(s.layers); l.layman.traceability.findingsSha256 = 'c'.repeat(64); expect(failed(review(s, l))).toContain('layers_bound_to_findings'); });
    it('layers_bound_to_findings: a layer bound to another governance output', () => { const l = clone(s.layers); l.clinical.traceability.governanceSha256 = 'c'.repeat(64); expect(failed(review(s, l))).toContain('layers_bound_to_findings'); });
    it('layers_identical_findings: the layers disagree about a row', () => { const l = clone(s.layers); l.layman.findings[1].label = 'Something else'; expect(failed(review(s, l))).toContain('layers_identical_findings'); });
    it('rows_match_source: a changed value in BOTH layers', () => { const l = clone(s.layers); for (const k of ['clinical', 'layman'] as const) l[k].findings[1].value = 1; expect(failed(review(s, l))).toContain('rows_match_source'); });
    it('rows_match_source: a changed unit', () => { const l = clone(s.layers); for (const k of ['clinical', 'layman'] as const) l[k].findings[1].unit = 'kg'; expect(failed(review(s, l))).toContain('rows_match_source'); });
    it('rows_match_source: a dropped finding', () => { const l = clone(s.layers); for (const k of ['clinical', 'layman'] as const) l[k].findings.pop(); expect(failed(review(s, l))).toContain('rows_match_source'); });
    it('rows_match_source: an excluded finding that shows a value', () => {
      const x = setup(vitals((r) => { r.findings[0].excluded = { reason: 'poor_signal' }; })); const l = clone(x.layers);
      for (const k of ['clinical', 'layman'] as const) l[k].findings.find((r) => r.valueStatus === 'excluded')!.value = 99;
      expect(failed(review(x, l))).toContain('rows_match_source');
    });
    it('positions_match_governance: a flipped position in BOTH layers', () => { const l = clone(s.layers); for (const k of ['clinical', 'layman'] as const) { const r = l[k].findings.find((x) => x.position === 'above')!; r.position = 'within'; } expect(failed(review(s, l))).toContain('positions_match_governance'); });
    it('all_flags_surfaced: a hidden flag', () => { const l = clone(s.layers); for (const k of ['clinical', 'layman'] as const) l[k].flags.pop(); expect(failed(review(s, l))).toContain('all_flags_surfaced'); });
    it('all_flags_surfaced: a downgraded severity', () => { const x = setup(posture('unsigned')); const l = clone(x.layers); for (const k of ['clinical', 'layman'] as const) l[k].flags.forEach((f) => { f.severity = 'info'; }); expect(failed(review(x, l))).toContain('all_flags_surfaced'); });
    it('advisory_matches_governance: advisory removed', () => { const l = clone(s.layers); l.layman.referral = null; expect(failed(review(s, l))).toContain('advisory_matches_governance'); });
    it('advisory_matches_governance: advisory reworded', () => { const l = clone(s.layers); l.clinical.referral!.text = 'Probably fine.'; expect(failed(review(s, l))).toContain('advisory_matches_governance'); });
    it('advisory_matches_governance: an advisory where governance triggered none', () => { const x = setup(posture('signed')); const l = clone(x.layers); l.layman.referral = clone(s.layers).layman.referral; expect(failed(review(x, l))).toContain('advisory_matches_governance'); });
    it('narrative_guards_pass: a number that belongs to no finding', () => { const l = clone(s.layers); l.layman.sections[1].text += ' It was 7777 last week.'; expect(failed(review(s, l))).toContain('narrative_guards_pass'); });
    it('narrative_guards_pass: reassurance in a section', () => { const l = clone(s.layers); l.clinical.sections[0].text += ' Everything is fine and you are healthy.'; expect(failed(review(s, l))).toContain('narrative_guards_pass'); });
    it('narrative_guards_pass: a diagnosis', () => { const l = clone(s.layers); l.layman.limitations += ' You have hypertension.'; expect(failed(review(s, l))).toContain('narrative_guards_pass'); });
    it('layers_cover_flagged_findings: a flagged finding no longer cited by one layer', () => {
      const l = clone(s.layers); const keys = s.f.gov.positions.filter((p) => p.position === 'above').map((p) => p.findingKey);
      l.layman.sections = l.layman.sections.filter((sec) => !sec.findingRefs.some((r) => keys.includes(r)));
      expect(failed(review(s, l))).toContain('layers_cover_flagged_findings');
    });
  });
});
