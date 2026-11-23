import { describe, expect, it } from 'vitest';
import { validateManifest, InterpretationManifest } from './manifest';
import { builtinInterpretationManifests } from './registry';
import { declareAdapter, getAdapter, isAdapterAvailable, listAdapters } from './adapters';

const good = (): InterpretationManifest => ({
  id: 'physiological-signal-interpretation', version: '1.2.3', title: 'Physiological Signal Interpretation',
  acceptsAnalysisTypes: ['face_scan_vitals'], adapterId: 'beaive-v1', inputSchema: 'interpretation-request/v1',
  prompts: { clinical: 'clinical-vitals/v1', layman: 'layman-vitals/v1' }, riskTier: 'ruo', requiresRelease: false,
});

const errorsOf = (m: unknown) => { const r = validateManifest(m); return r.ok ? [] : r.errors; };

describe('interpretation manifest validation', () => {
  it('accepts a well-formed manifest and every built-in skill', () => {
    expect(validateManifest(good()).ok).toBe(true);
    for (const m of builtinInterpretationManifests()) expect(errorsOf(m), m.id).toEqual([]);
  });

  it('is strict about unknown fields and non-objects', () => {
    expect(errorsOf({ ...good(), surprise: 1 })).toContain('unknown field "surprise"');
    for (const bad of [null, 'x', 5, [], undefined]) expect(errorsOf(bad)).toEqual(['manifest must be an object']);
  });

  it.each([
    ['id with a path segment', { id: '../etc/passwd' }, /id must match/],
    ['id with upper-case', { id: 'Bad-Id' }, /id must match/],
    ['non-semver version', { version: 'latest' }, /semantic version/],
    ['empty title', { title: '  ' }, /title is required/],
    ['wrong input schema', { inputSchema: 'interpretation-request/v2' }, /inputSchema must be/],
    ['unknown risk tier', { riskTier: 'medical' }, /riskTier must be/],
    ['non-boolean requiresRelease', { requiresRelease: 'no' }, /requiresRelease must be/],
    ['no analysis types', { acceptsAnalysisTypes: [] }, /acceptsAnalysisTypes/],
    ['bad analysis type', { acceptsAnalysisTypes: ['Face Scan'] }, /acceptsAnalysisTypes/],
    ['no prompts', { prompts: {} }, /at least one of clinical, layman/],
    ['unknown prompt layer', { prompts: { clinical: 'clinical-vitals/v1', doctor: 'x' } }, /unknown prompt layer/],
    ['bad prompt id', { prompts: { clinical: '../../secret' } }, /not a valid prompt id/],
    ['unknown adapter', { adapterId: 'does-not-exist' }, /unknown adapterId/],
    ['adapter cannot read the analysis type', { acceptsAnalysisTypes: ['posture_landmark'] }, /cannot read analysis type/],
  ])('refuses %s', (_label, patch, message) => {
    expect(errorsOf({ ...good(), ...patch }).join(' | ')).toMatch(message);
  });

  it('requires a clinicalDomain for the clinical tier and forbids it otherwise', () => {
    expect(errorsOf({ ...good(), riskTier: 'clinical' }).join()).toMatch(/needs a clinicalDomain/);
    expect(validateManifest({ ...good(), riskTier: 'clinical', clinicalDomain: 'cardiometabolic' }).ok).toBe(true);
    expect(errorsOf({ ...good(), clinicalDomain: 'cardiometabolic' }).join()).toMatch(/only allowed for the clinical tier/);
    expect(errorsOf({ ...good(), riskTier: 'clinical', clinicalDomain: 'Bad Domain' }).join()).toMatch(/needs a clinicalDomain/);
  });

  it('a wildcard adapter accepts any analysis type', () => {
    expect(validateManifest({ ...good(), id: 'any-report', adapterId: 'report-clinical-v1', acceptsAnalysisTypes: ['ecg_strip', 'face_scan_vitals'], prompts: { clinical: 'clinical-report/v1' } }).ok).toBe(true);
  });
});

describe('adapter declarations', () => {
  it('ship as declared but NOT available, so nothing can be assigned against code that does not exist', () => {
    for (const id of ['beaive-v1', 'posturepulse-v1', 'report-clinical-v1', 'report-layman-v1']) {
      expect(getAdapter(id), id).toBeDefined();
    }
    expect(listAdapters().every((a) => !a.available || a.id.startsWith('test-'))).toBe(true);
    expect(isAdapterAvailable('beaive-v1')).toBe(false);
    expect(isAdapterAvailable('nope')).toBe(false);
  });

  it('declareAdapter registers or flips an adapter without sharing the caller\'s array', () => {
    const types = ['x_type'];
    declareAdapter({ id: 'test-adapter', available: true, analysisTypes: types });
    types.push('mutated');
    expect(isAdapterAvailable('test-adapter')).toBe(true);
    expect(getAdapter('test-adapter')!.analysisTypes).toEqual(['x_type']);
  });
});
