/** The deterministic fallback must be safe on its own and pass the SAME guards as a model's text. */
import { describe, expect, it } from 'vitest';
import { deterministicNarrative } from './deterministic';
import { checkNarrative, layersAgree } from './guards';
import { buildNarrativeInput } from './input';
import { LAYERS } from './types';
import { posture, vitals } from './fixtures';

const hard = (r: ReturnType<typeof checkNarrative>) => r.problems.filter((p) => p.severity === 'hard');

describe.each([
  ['the beAIve example', () => vitals()],
  ['a beAIve scan with a missing value, a contradiction and an out-of-range blood pressure', () => vitals((r) => {
    r.findings.find((x: any) => x.key === 'hr').sourceFlag = 'normal'; // contradicts its own range
    r.findings.find((x: any) => x.key === 'rr').value = null;
    r.findings.find((x: any) => x.key === 'bp').value = '171/99';
  })],
  ['an unsigned PosturePulse report (draft references, proxy tier, an excluded row)', () => posture('unsigned')],
  ['a verified PosturePulse bundle', () => posture('signed')],
  ['a PosturePulse report with symptoms and an unsupported row', () => posture('unsigned', (f) => {
    f.report.rows[1].excluded = null; (f.report.rows[1] as any).unsupportedReasons = ['occlusion', 'low_confidence'];
    f.symptomReports = [{ symptomReportId: 's', sessionId: f.session.sessionId, reportedAt: new Date().toISOString(), symptoms: ['pain'], severity: 'mild', freeText: null, triggeredAction: 'pause' }];
  })],
])('%s', (_name, build) => {
  const { doc, gov } = build();
  for (const layer of LAYERS) {
    it(`${layer}: passes every hard guard`, () => {
      const n = deterministicNarrative(layer, doc, gov);
      const r = checkNarrative(layer, n, buildNarrativeInput(layer, doc, gov));
      expect(hard(r), JSON.stringify(hard(r))).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
  it('both layers cite every finding that must be cited, and agree', () => {
    const i = buildNarrativeInput('clinical', doc, gov);
    expect(layersAgree(deterministicNarrative('clinical', doc, gov), deterministicNarrative('layman', doc, gov), i)).toBe(true);
  });
  it('is deterministic', () => {
    for (const l of LAYERS) expect(JSON.stringify(deterministicNarrative(l, doc, gov))).toBe(JSON.stringify(deterministicNarrative(l, doc, gov)));
  });
});

describe('content of the fallback', () => {
  const { doc, gov } = vitals();
  const clinical = deterministicNarrative('clinical', doc, gov);
  const layman = deterministicNarrative('layman', doc, gov);
  const text = (n: typeof clinical, key: string) => n.sections.find((s) => s.findingRefs.includes(key))!.text;

  it('states each value with its unit and the source\'s own reference and position, in both layers', () => {
    expect(text(clinical, 'heart_rate_bpm')).toBe('Heart Rate: 107 bpm. The reference supplied by beAIve is 60-100. The value is above that reference.');
    expect(text(layman, 'heart_rate_bpm')).toBe('Heart Rate: 107 bpm. The range beAIve uses for this is 60-100. Your result is above that range.');
    expect(text(clinical, 'breathing_rate_per_min')).toContain('The value is within that reference.');
  });
  it('does not compare a value that has no usable range, and says so', () => {
    expect(text(clinical, 'hemoglobin_g_dl')).toContain('no usable numeric range');
    expect(text(layman, 'hemoglobin_g_dl')).toContain('no usable range');
    expect(text(layman, 'hemoglobin_g_dl')).not.toMatch(/above|below|within/);
  });
  it('relays experimental estimates and a missing value without filling anything in', () => {
    expect(text(clinical, 'hba1c_percent')).toContain('experimental estimate');
    expect(text(layman, 'hba1c_percent')).toContain('not the same as a lab test');
    expect(text(clinical, 'unmapped.pnn_missing_example')).toBe('Example of a value the source could not measure: the source reported no value.');
  });
  it('never reassures and never diagnoses, in the fixed next steps and limits either', () => {
    const all = JSON.stringify([clinical, layman]).toLowerCase();
    for (const w of ['healthy', 'all clear', 'nothing to worry', 'diabetes', 'hypertension', 'you have ']) expect(all, w).not.toContain(w);
    expect(layman.nextSteps).toContain('Do not start, stop or change any medicine because of this report.');
    expect(layman.limitations).toContain('not a diagnosis');
  });
  it('leaves excluded findings out entirely', () => {
    const p = posture('unsigned');
    const all = JSON.stringify([deterministicNarrative('clinical', p.doc, p.gov), deterministicNarrative('layman', p.doc, p.gov)]);
    expect(all).not.toContain('head_forward_offset'); expect(all).not.toContain('Head forward offset');
  });
  it('the layman fallback reads at or below the soft reading-grade limit', () => {
    const r = checkNarrative('layman', layman, buildNarrativeInput('layman', doc, gov));
    expect(r.readingGrade).toBeLessThanOrEqual(10);
    expect(r.problems.find((p) => p.code === 'reading_level_high')).toBeUndefined();
  });
});
