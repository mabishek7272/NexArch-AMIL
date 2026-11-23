import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { beaiveAdapter } from './beaive';
import type { StoredRequest } from './types';

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));
function req(over: (r: any) => void = () => {}): StoredRequest {
  const r = JSON.parse(JSON.stringify(example));
  delete r.subject.identity;
  over(r);
  return r;
}
const find = (out: ReturnType<typeof beaiveAdapter.run>, k: string) => out.findings.find((f) => f.findingKey === k);

describe('beAIve adapter', () => {
  it('splits blood pressure into derived systolic/diastolic with references from "<129/90"', () => {
    const out = beaiveAdapter.run(req());
    const s = find(out, 'bp_systolic_mmhg')!, d = find(out, 'bp_diastolic_mmhg')!;
    expect([s.value, d.value]).toEqual([154, 94]);
    expect(s.valueStatus).toBe('derived');
    expect(s.derivation).toEqual({ fromKeys: ['bp'], rule: 'split_bp_string' });
    expect(s.reference).toMatchObject({ origin: 'tenant_supplied', upper: 129, upperInclusive: false });
    expect(d.reference).toMatchObject({ upper: 90, upperInclusive: false });
    expect(find(out, 'bp')!.valueStatus).toBe('stated'); // the original is kept as given
  });

  it('keeps a null as missing, flags it, and never fills it in', () => {
    const out = beaiveAdapter.run(req());
    const m = find(out, 'unmapped.pnn_missing_example')!;
    expect(m.valueStatus).toBe('missing'); expect(m.value).toBeNull();
    expect(out.flags.some((f) => f.type === 'missing_data' && f.findingKeys?.includes(m.findingKey))).toBe(true);
  });

  it('leaves the sex-dependent hemoglobin range unresolved without sexAtBirth, and flags it', () => {
    const out = beaiveAdapter.run(req());
    const h = find(out, 'hemoglobin_g_dl')!;
    expect(h.reference?.text).toBe('M:14-18, F:12-16');
    expect(h.reference?.lower).toBeUndefined(); expect(h.reference?.upper).toBeUndefined();
    expect(out.flags.some((f) => f.type === 'missing_data' && f.findingKeys?.includes('hemoglobin_g_dl'))).toBe(true);
  });

  it('applies the matching sex-specific hemoglobin range only when sexAtBirth is female or male', () => {
    const f = find(beaiveAdapter.run(req((r) => { r.subject.demographics.sexAtBirth = 'female'; })), 'hemoglobin_g_dl')!;
    expect(f.reference).toMatchObject({ lower: 12, upper: 16 });
    const m = find(beaiveAdapter.run(req((r) => { r.subject.demographics.sexAtBirth = 'male'; })), 'hemoglobin_g_dl')!;
    expect(m.reference).toMatchObject({ lower: 14, upper: 18 });
    const i = find(beaiveAdapter.run(req((r) => { r.subject.demographics.sexAtBirth = 'intersex'; })), 'hemoglobin_g_dl')!;
    expect(i.reference?.lower).toBeUndefined();
  });

  it('parses unambiguous range texts and leaves ambiguous ones as text only', () => {
    const out = beaiveAdapter.run(req((r) => {
      r.findings.push({ key: 'weird', label: 'Weird', value: 1, sourceReference: { text: 'about 5 or so' } });
    }));
    expect(find(out, 'heart_rate_bpm')!.reference).toMatchObject({ lower: 60, upper: 100, lowerInclusive: true, upperInclusive: true });
    expect(find(out, 'spo2_percent')!.reference).toMatchObject({ lower: 95, lowerInclusive: false });
    const w = find(out, 'unmapped.weird')!;
    expect(w.reference).toEqual({ origin: 'tenant_supplied', text: 'about 5 or so' });
  });

  it('keeps unknown source keys under unmapped.* and flags them', () => {
    const out = beaiveAdapter.run(req((r) => { r.findings.push({ key: 'Mystery-Index', label: 'Mystery', value: 7 }); }));
    expect(find(out, 'unmapped.mystery_index')).toBeTruthy();
    expect(out.flags.some((f) => f.type === 'unmapped_key' && f.findingKeys?.includes('unmapped.mystery_index'))).toBe(true);
  });

  it('does not split an unparseable blood pressure and flags it for review', () => {
    const out = beaiveAdapter.run(req((r) => { r.findings[0].value = 'high-ish'; }));
    expect(find(out, 'bp_systolic_mmhg')).toBeUndefined();
    expect(out.flags.some((f) => f.type === 'review_required')).toBe(true);
  });

  it('flags implausible blood pressure but keeps the values', () => {
    const out = beaiveAdapter.run(req((r) => { r.findings[0].value = '80/120'; }));
    expect(find(out, 'bp_systolic_mmhg')!.value).toBe(80);
    expect(out.flags.some((f) => f.type === 'implausible_value')).toBe(true);
  });

  it('relays under-research markers and never upgrades them', () => {
    const out = beaiveAdapter.run(req());
    expect(find(out, 'hba1c_percent')!.underResearch).toBe(true);
    const flag = out.flags.find((f) => f.type === 'under_research')!;
    expect(flag.findingKeys).toContain('hba1c_percent');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(beaiveAdapter.run(req()))).toBe(JSON.stringify(beaiveAdapter.run(req())));
  });
});
