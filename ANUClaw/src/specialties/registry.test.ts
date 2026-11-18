import { describe, expect, it } from 'vitest';
import { SPECIALTIES, SpecialtyModule, validateRegistry } from './registry';

describe('specialty registry honesty invariants', () => {
  it('the shipped registry is valid', () => { expect(validateRegistry()).toEqual([]); });

  it('covers every department in plan §9', () => {
    expect(SPECIALTIES.map((m) => m.id).sort()).toEqual([
      'ai_prediction', 'biomarker_discovery', 'biostatistics', 'clinical_pharmacology', 'drug_discovery', 'emergency_medicine', 'epidemiology',
      'ergonomics', 'haematology_pathology', 'immunology', 'internal_medicine_id', 'orthopedics_rehab', 'physiological_monitoring',
      'posture_movement', 'synthetic_biology', 'virology_molecular',
    ]);
  });

  it('no module is approved or has released clinical rules; none is called complete', () => {
    for (const m of SPECIALTIES) {
      expect(m.approval.status).toBe('not_approved');
      expect(m.releasedRules).toBe(0);
      expect(['research_only', 'framework_only', 'gated', 'unavailable']).toContain(m.releaseState);
    }
  });

  it('emergency, monitoring, prediction and biomarker stay gated; ergonomics (nothing built) is unavailable', () => {
    const state = (id: string) => SPECIALTIES.find((m) => m.id === id)!.releaseState;
    for (const id of ['emergency_medicine', 'physiological_monitoring', 'ai_prediction', 'biomarker_discovery', 'clinical_pharmacology']) expect(state(id)).toBe('gated');
    expect(state('ergonomics')).toBe('unavailable');
  });

  it('every module lists external requirements and prohibited claims', () => {
    for (const m of SPECIALTIES) { expect(m.externalRequirements.length).toBeGreaterThan(0); expect(m.prohibitedClaims.length).toBeGreaterThan(0); }
  });

  it('the validator rejects entries that over-claim', () => {
    const base = SPECIALTIES[0];
    const bad = (patch: Partial<SpecialtyModule>) => validateRegistry([{ ...base, ...patch } as SpecialtyModule]);
    expect(bad({ approval: { status: 'approved', requiredFrom: 'x' } as any }).join()).toMatch(/must be not_approved/);
    expect(bad({ releasedRules: 3 as any }).join()).toMatch(/no clinical rules/);
    expect(bad({ externalRequirements: [] }).join()).toMatch(/external requirements/);
    expect(bad({ implemented: [], releaseState: 'framework_only' }).join()).toMatch(/requires at least one real implementation/);
    expect(bad({ releaseState: 'unavailable' }).join()).toMatch(/unavailable but lists implementations/);
    expect(bad({ releaseState: 'complete' as any }).join()).toMatch(/invalid release state/);
  });
});
