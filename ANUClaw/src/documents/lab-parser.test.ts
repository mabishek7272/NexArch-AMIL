import { describe, expect, it } from 'vitest';
import { parseLabLines } from './lab-parser';

describe('parseLabLines', () => {
  it('keeps raw value, unit and the lab-printed reference interval', () => {
    const [c] = parseLabLines('Hemoglobin 13.2 g/dL 12.0-15.5', 1, 'native_text');
    expect(c).toMatchObject({ analyte: 'Hemoglobin', valueRaw: '13.2', valueNum: 13.2, unit: 'g/dL', refLow: 12, refHigh: 15.5, flags: [] });
    expect(c.sourceText).toBe('Hemoglobin 13.2 g/dL 12.0-15.5');
  });

  it('preserves inequality values and flags them', () => {
    const [c] = parseLabLines('Troponin I <0.01 ng/mL 0.00-0.04', 2, 'native_text');
    expect(c).toMatchObject({ valueRaw: '<0.01', comparator: '<', valueNum: 0.01 });
    expect(c.flags).toContain('inequality_value');
  });

  it('never guesses comma decimals', () => {
    const [c] = parseLabLines('Creatinine 1,2 mg/dL 0,6-1,3', 1, 'native_text');
    expect(c.valueNum).toBeNull();
    expect(c.refLow).toBeNull();
    expect(c.flags).toContain('comma_decimal_ambiguous');
  });

  it('flags missing unit and missing interval, and lab H/L markers', () => {
    const [c] = parseLabLines('Glucose 7.9 H', 1, 'native_text');
    expect(c.flags).toEqual(expect.arrayContaining(['missing_reference_interval', 'lab_flag_present']));
    expect(c.labFlag).toBe('H');
    const [d] = parseLabLines('Ratio 2.5', 1, 'native_text');
    expect(d.flags).toContain('missing_unit');
  });

  it('marks OCR-sourced and low-confidence candidates', () => {
    const [c] = parseLabLines('Sodium 140 mmol/L 135-145', 3, 'ocr', 0.62);
    expect(c.flags).toEqual(expect.arrayContaining(['ocr_source', 'ocr_low_confidence']));
  });

  it('ignores identifiers/dates and non-result lines', () => {
    expect(parseLabLines(['Patient: Synthetic 12', 'Date 2026 01', 'Page 1 of 2', 'Interpretation follows below'].join('\n'), 1, 'native_text')).toEqual([]);
  });

  it('records page and line numbers', () => {
    const cs = parseLabLines('Header\nSodium 140 mmol/L 135-145\nPotassium 4.1 mmol/L 3.5-5.1', 4, 'native_text');
    expect(cs.map((c) => [c.page, c.line])).toEqual([[4, 2], [4, 3]]);
  });
});
