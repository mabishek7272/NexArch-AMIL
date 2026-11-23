/** Narrative guards (P4b). Pure; synthetic data only. */
import { describe, expect, it } from 'vitest';
import { checkNarrative, layersAgree, mustCite, readingGrade, shapeNarrative } from './guards';
import type { GuardResult, Narrative, NarrativeInput, NarrativeInputFinding } from './types';

const f = (key: string, label: string, value: NarrativeInputFinding['value'], position: string, extra: Partial<NarrativeInputFinding> = {}): NarrativeInputFinding =>
  ({ key, label, value, position, positionBasis: position === 'no_reference' ? 'no_reference' : 'numeric_reference', ...extra });
const HR = f('heart_rate_bpm', 'Heart Rate', 107, 'above', { unit: 'bpm', reference: { text: '60-100', lower: 60, upper: 100, suppliedBy: 'beAIve' } });
const RR = f('breathing_rate', 'Breathing Rate', 16, 'within', { unit: 'breaths/min', reference: { text: '12-20', lower: 12, upper: 20, suppliedBy: 'beAIve' } });
const A1C = f('hba1c_percent', 'Hemoglobin A1c', 6.89, 'above', { unit: '%', reference: { text: '<5.7', upper: 5.7, suppliedBy: 'beAIve' } });
const NOREF = f('hemoglobin_g_dl', 'Hemoglobin', 14.4, 'no_reference', { unit: 'g/dL' });
const input = (findings: NarrativeInputFinding[], flags: NarrativeInput['flags'] = [], over: Partial<NarrativeInput> = {}): NarrativeInput =>
  ({ layer: 'clinical', application: 'beAIve', findings, flags, referralNoticeAdded: false, ...over });
const sec = (id: string, text: string, refs: string[] = [], statusLabel: 'source_finding' | 'interpretation' | 'limitation' = 'source_finding') => ({ id, text, findingRefs: refs, statusLabel });
const narrative = (sections: Narrative['sections'], over: Partial<Narrative> = {}): Narrative => ({
  sections: [sec('overview', 'This explains results reported by the app.', [], 'interpretation'), ...sections],
  nextSteps: ['Talk with a doctor or another qualified health professional about these results.'],
  limitations: 'This is an estimate and is not a diagnosis.', ...over,
});
const codes = (r: GuardResult) => r.problems.filter((p) => p.severity === 'hard').map((p) => p.code);
const IN = input([HR, RR, A1C, NOREF]);
const GOOD = narrative([
  sec('f_hr', 'Heart Rate is 107 bpm. The range supplied by beAIve is 60-100, and the result is above that range.', ['heart_rate_bpm']),
  sec('f_a1c', 'Hemoglobin A1c is 6.89 %. The range supplied by beAIve is <5.7, and the result is above it.', ['hba1c_percent']),
  sec('f_rr', 'Breathing Rate is 16 breaths/min, within the range supplied by beAIve of 12-20.', ['breathing_rate']),
]);

describe('a faithful narrative', () => {
  it('passes every guard', () => { expect(checkNarrative('clinical', GOOD, IN)).toMatchObject({ ok: true, problems: [] }); });
  it('digits inside a finding label (A1c) and reference text are the finding\'s own numbers', () => {
    expect(codes(checkNarrative('clinical', GOOD, IN))).toEqual([]);
  });
  it('a value with no reference may be described without a comparison', () => {
    expect(checkNarrative('clinical', narrative([...GOOD.sections.slice(1), sec('f_hb', 'Hemoglobin is 14.4 g/dL. The source supplied no usable range, so no comparison is made.', ['hemoglobin_g_dl'])]), IN).ok).toBe(true);
  });
});

describe('shape', () => {
  const bad = (raw: unknown) => shapeNarrative(raw).problems[0]?.code;
  it('accepts a well-formed narrative and refuses malformed ones', () => {
    expect(shapeNarrative(GOOD).value).not.toBeNull();
    expect(bad(null)).toBe('shape_not_object'); expect(bad([])).toBe('shape_not_object'); expect(bad('x')).toBe('shape_not_object');
    expect(bad({ ...GOOD, extra: 1 })).toBe('shape_unknown_field');
    expect(bad({ ...GOOD, sections: [] })).toBe('shape_sections');
    expect(bad({ ...GOOD, nextSteps: 'x' })).toBe('shape_next_steps');
    expect(bad({ ...GOOD, nextSteps: [''] })).toBe('shape_next_steps');
    expect(bad({ ...GOOD, limitations: '' })).toBe('shape_limitations');
    expect(bad({ ...GOOD, sections: [{ ...GOOD.sections[0], extra: 1 }] })).toBe('shape_unknown_field');
    expect(bad({ ...GOOD, sections: [{ ...GOOD.sections[0], id: 'Bad Id' }] })).toBe('shape_section_id');
    expect(bad({ ...GOOD, sections: [GOOD.sections[0], GOOD.sections[0]] })).toBe('shape_section_id');
    expect(bad({ ...GOOD, sections: [{ ...GOOD.sections[0], text: 'x'.repeat(1300) }] })).toBe('shape_section_text');
    expect(bad({ ...GOOD, sections: [{ ...GOOD.sections[0], findingRefs: 'x' }] })).toBe('shape_refs');
    expect(bad({ ...GOOD, sections: [{ ...GOOD.sections[0], statusLabel: 'diagnosis' }] })).toBe('shape_status_label');
  });
});

describe('numbers: a model cannot invent a value or a range', () => {
  const only = (s: ReturnType<typeof sec>) => checkNarrative('clinical', narrative([s, ...GOOD.sections.slice(1).filter((x) => x.id !== s.id), ]), IN);
  it('rejects a number that is in no finding', () => {
    expect(codes(only(sec('f_hr', 'Heart Rate is 112 bpm, above the supplied range of 60-100.', ['heart_rate_bpm'])))).toContain('number_not_in_cited_findings');
  });
  it('rejects a range the finding did not supply (here: the source never gave 55-95)', () => {
    expect(codes(only(sec('f_hr', 'Heart Rate is 107 bpm. A usual range is 55-95, and the result is above it.', ['heart_rate_bpm'])))).toContain('number_not_in_cited_findings');
  });
  it('rejects another finding\'s range attached to this finding (12-20 belongs to breathing rate)', () => {
    expect(codes(only(sec('f_hr', 'Heart Rate is 107 bpm, above the supplied range of 12-20.', ['heart_rate_bpm'])))).toContain('number_not_in_cited_findings');
  });
  it('allows another finding\'s number only when that finding is cited too', () => {
    expect(codes(only(sec('f_both', 'Heart Rate is 107 bpm and Breathing Rate is 16 breaths/min; heart rate is above its supplied range of 60-100 and breathing is within 12-20.', ['heart_rate_bpm', 'breathing_rate'])))).toEqual([]);
  });
  it('rejects numbers in the overview, next steps and limitations, however harmless they look', () => {
    expect(codes(checkNarrative('clinical', narrative([...GOOD.sections.slice(1)], { sections: [sec('overview', 'This covers 3 results.', [], 'interpretation'), ...GOOD.sections.slice(1)] }), IN))).toContain('number_not_in_cited_findings');
    expect(codes(checkNarrative('clinical', narrative(GOOD.sections.slice(1), { nextSteps: ['Repeat the scan in 2 weeks.'] }), IN))).toContain('number_in_next_steps');
    expect(codes(checkNarrative('clinical', narrative(GOOD.sections.slice(1), { limitations: 'About 95 percent of scans are accurate.' }), IN))).toContain('number_in_limitations');
  });
  it('compares numbers by value, not spelling', () => {
    expect(codes(only(sec('f_a1c', 'Hemoglobin A1c is 6.890 %, above the supplied <5.70.', ['hba1c_percent'])))).toEqual([]);
  });
});

describe('citations and coverage', () => {
  it('rejects an unknown or missing citation', () => {
    expect(codes(checkNarrative('clinical', narrative([...GOOD.sections.slice(1), sec('f_x', 'Something about a value.', ['made_up_key'])]), IN))).toContain('unknown_citation');
    expect(codes(checkNarrative('clinical', narrative([...GOOD.sections.slice(1), sec('f_y', 'A statement about the results without a citation.', [])]), IN))).toContain('missing_citation');
  });
  it('plain context sections may cite nothing, if they have no numbers', () => {
    expect(checkNarrative('clinical', narrative([...GOOD.sections.slice(1), sec('data_quality', 'Some values were not reported by the source.', [], 'limitation')]), IN).ok).toBe(true);
  });
  it('every out-of-range, flagged or source-flagged finding must be cited', () => {
    const noHr = narrative(GOOD.sections.slice(2));
    expect(codes(checkNarrative('clinical', noHr, IN))).toContain('flagged_finding_not_cited');
    const flagged = input([RR], [{ type: 'low_confidence', severity: 'attention', findingKeys: ['breathing_rate'] }]);
    expect(mustCite(flagged)).toEqual(['breathing_rate']);
    expect(codes(checkNarrative('clinical', narrative([sec('f_x', 'Breathing Rate is 16 breaths/min.', ['breathing_rate'])]), input([RR, HR])))).toContain('flagged_finding_not_cited');
    const srcFlag = input([f('risk', 'Risk', 'High', 'not_applicable', { sourceFlag: 'high' })]);
    expect(mustCite(srcFlag)).toEqual(['risk']);
    expect(mustCite(input([RR], [{ type: 'under_research', severity: 'info', findingKeys: ['breathing_rate'] }]))).toEqual([]); // info flags do not force coverage
  });
});

describe('direction must match the governed position', () => {
  const one = (finding: NarrativeInputFinding, text: string) => codes(checkNarrative('clinical', narrative([sec('f_1', text, [finding.key])]), input([finding])));
  it('an out-of-range finding is not described as within or normal', () => {
    expect(one(HR, 'Heart Rate is 107 bpm, within the range supplied by beAIve of 60-100.')).toContain('direction_contradicts_position');
    expect(one(HR, 'Heart Rate is 107 bpm and is in range of 60-100.')).toContain('direction_contradicts_position');
  });
  it('an in-range finding is not described as above, below or outside', () => {
    expect(one(RR, 'Breathing Rate is 16 breaths/min, above the supplied range of 12-20.')).toContain('direction_contradicts_position');
    expect(one(RR, 'Breathing Rate is 16 breaths/min, outside the supplied range of 12-20.')).toContain('direction_contradicts_position');
  });
  it('an above finding is not described as below, and vice versa', () => {
    expect(one(HR, 'Heart Rate is 107 bpm, below the supplied range of 60-100.')).toContain('direction_contradicts_position');
    const low = f('spo2', 'Oxygen', 90, 'below', { unit: '%', reference: { text: '>95', lower: 95, suppliedBy: 'beAIve' } });
    expect(one(low, 'Oxygen is 90 %, above the supplied >95.')).toContain('direction_contradicts_position');
    expect(one(low, 'Oxygen is 90 %, below the supplied >95.')).toEqual([]);
  });
  it('does not misread the source\'s own label as the model\'s wording', () => {
    const lab = f('x', 'Above Average Index', 107, 'within', { reference: { text: '60-100', lower: 60, upper: 200, suppliedBy: 'beAIve' } });
    expect(one(lab, 'Above Average Index is 107, within the supplied range of 60-100.')).toEqual([]);
  });
});

describe('wording: no diagnosis, no reassurance, no treatment advice', () => {
  const wording = (text: string) => codes(checkNarrative('clinical', narrative(GOOD.sections.slice(1), { limitations: text }), IN));
  it.each([
    ['You have diabetes.', 'banned_phrase'], ['This suggests diabetes.', 'diagnostic_wording'], ['The reading points to hypertension.', 'diagnostic_wording'],
    ['This is a sign of heart disease.', 'diagnostic_wording'], ['Scoliosis is likely.', 'diagnostic_wording'], ['This confirms a diagnosis.', 'diagnostic_wording'],
    ['You are healthy.', 'banned_phrase'], ['Your results look healthy.', 'reassurance'], ['There is nothing to worry about.', 'banned_phrase'], ['All clear.', 'banned_phrase'],
    ['This is reassuring.', 'reassurance'], ['The result is normal.', 'reassurance'], ['It is perfectly safe.', 'reassurance'], ['Good news overall.', 'banned_phrase'],
    ['There is no need to see a doctor.', 'banned_phrase'], ['You do not need to see a doctor.', 'banned_phrase'],
    ['You should start a new treatment.', 'treatment_wording'], ['Take your medication earlier.', 'treatment_wording'], ['Increase your dose.', 'treatment_wording'], ['Physiotherapy would help.', 'treatment_wording'],
    ['This has been confirmed.', 'unattributed_confirmation'], ['The result is cleared.', 'unattributed_confirmation'],
    // a negation that reverses into reassurance (the real model wrote the first one, and an earlier version of this guard let it through)
    ['A result outside the range does not on its own mean anything is wrong.', 'reassurance'], ['This does not indicate a problem.', 'reassurance'], ["That doesn't suggest anything serious.", 'reassurance'],
    ['It is not a sign that something is wrong, so there is no reason to act.', 'reassurance'],
    // "non-diagnostic" is safe, but a bare diagnostic word still is not
    ['The finding is diagnostic of a condition.', 'diagnostic_wording'],
  ])('rejects "%s"', (text, code) => { expect(wording(text)).toContain(code); });
  it.each([
    'This does not support a diagnosis.', 'This is not a diagnosis.', 'A value outside the range is not by itself a diagnosis of anything.',
    'Any flagged value should be confirmed with a clinician.', 'This should be confirmed with validated measurements.', 'The result has been confirmed by a laboratory.',
    'Do not start, stop or change any medicine because of this report.', 'Do not change your medication based on this alone.', 'These results cannot say whether you are healthy.',
    'This is not reassuring or alarming.', 'Safety information is added separately.', 'Never rely on this to decide about treatment.',
    'The source marks this value normal, but that is the source’s own label.',
    'The physiological estimate is approximate.',
    // found live: a clinically correct limitation rejected only for "non-diagnostic"
    'These findings are non-diagnostic estimates generated by a third-party application rather than validated clinical or laboratory measurements.',
    'The estimates are non-validated and experimental.', 'This does not mean the result is a diagnosis.', 'Reference ranges and source flags reflect the application’s own criteria and should not be used alone for clinical decision-making.',
  ])('accepts the required safe wording "%s"', (text) => { expect(wording(text)).toEqual([]); });
  it('the negation must come shortly BEFORE the word, not merely somewhere in the sentence', () => {
    expect(wording('This is not a complete picture and it points to a disorder of the heart.')).toContain('diagnostic_wording');
  });
  it('does not mistake a source label for diagnostic wording', () => {
    const labelled = input([f('k', 'Cardiovascular Disease Risk', 'High', 'not_applicable', { sourceFlag: 'high' })]);
    expect(codes(checkNarrative('clinical', narrative([sec('f_k', 'Cardiovascular Disease Risk was marked high by the app.', ['k'])]), labelled))).toEqual([]);
  });
  it('rejects markup, links and markdown, but allows a "<" in a supplied range', () => {
    for (const t of ['See <b>this</b>.', 'Visit https://example.com now.', 'This is **bold**.', 'Use `code` here.', '[a](b)']) {
      expect(codes(checkNarrative('clinical', narrative(GOOD.sections.slice(1), { limitations: t }), IN)), t).toContain('markup_or_link');
    }
    expect(codes(checkNarrative('clinical', narrative(GOOD.sections.slice(1)), IN))).toEqual([]); // GOOD quotes "<5.7"
  });
});

describe('layers and reading level', () => {
  it('layers agree when each cites every must-cite finding', () => {
    expect(layersAgree(GOOD, GOOD, IN)).toBe(true);
    expect(layersAgree(GOOD, narrative(GOOD.sections.slice(2)), IN)).toBe(false);
    expect(layersAgree(narrative(GOOD.sections.slice(2)), GOOD, IN)).toBe(false);
  });
  it('a hard-to-read layman text is a soft problem only', () => {
    const dense = narrative(GOOD.sections.slice(1), { limitations: 'Notwithstanding considerable methodological heterogeneity, physiological estimation accompanied by photoplethysmographic approximation necessarily remains substantially provisional and interpretatively constrained.' });
    const r = checkNarrative('layman', dense, IN);
    expect(r.ok).toBe(true);
    expect(r.problems.find((p) => p.code === 'reading_level_high')).toMatchObject({ severity: 'soft' });
    expect(r.readingGrade).toBeGreaterThan(10);
    expect(checkNarrative('clinical', dense, IN).readingGrade).toBeUndefined();
  });
  it('estimates a lower grade for short plain sentences', () => {
    expect(readingGrade('Your heart rate was above the range. Please talk to a doctor.')).toBeLessThan(6);
  });
});
