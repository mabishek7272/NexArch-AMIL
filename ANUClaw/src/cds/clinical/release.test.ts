import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { clinicalContentRelease, loadRegister } from './release';

const reg = (releases: unknown[]) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'r.json'); fs.writeFileSync(f, JSON.stringify({ releases })); return f; };

describe('clinicalContentRelease (F13)', () => {
  it('the shipped register releases nothing: every module is blocked', () => {
    expect(loadRegister()).toEqual([]);
    for (const d of ['oncology-combination', 'neurology-combination']) expect(clinicalContentRelease(d, 'seed-2026.1', {}).released).toBe(false);
  });
  it('only an exact (domain, version) register entry releases content', () => {
    const f = reg([{ ruleId: 'cds.oncology-combination', ruleVersion: '1.0.0' }]);
    expect(clinicalContentRelease('oncology-combination', '1.0.0', {}, f)).toMatchObject({ released: true, mode: 'registered' });
    expect(clinicalContentRelease('oncology-combination', '1.0.1', {}, f).released).toBe(false);          // a new version needs its own approval
    expect(clinicalContentRelease('neurology-combination', '1.0.0', {}, f).released).toBe(false);
  });
  it('production ignores the developer override; other environments need the literal "true"', () => {
    expect(clinicalContentRelease('x', '1', { ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT: 'true', NODE_ENV: 'production' }).released).toBe(false);
    expect(clinicalContentRelease('x', '1', { ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT: 'true', NODE_ENV: 'development' })).toMatchObject({ released: true, mode: 'seed_dev_override' });
    for (const v of ['1', 'yes', 'TRUE', '']) expect(clinicalContentRelease('x', '1', { ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT: v }).released).toBe(false);
  });
  it('an unreadable or malformed register fails closed', () => {
    expect(clinicalContentRelease('x', '1', {}, '/no/such/file.json').released).toBe(false);
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'b.json'); fs.writeFileSync(bad, '{not json');
    expect(loadRegister(bad)).toEqual([]);
  });
});
