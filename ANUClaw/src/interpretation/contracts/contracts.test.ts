import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { validateInterpretationRequest } from './validate';

const dir = path.join(__dirname, 'examples');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

describe('interpretation-request/v1 contract', () => {
  it('both shipped examples validate', () => {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) expect(validateInterpretationRequest(load(f)), f).toEqual({ ok: true });
  });
  it('requires findings or nativePayload, and never both', () => {
    const vitals = load('beaive-vitals.request.json'), posture = load('posturepulse-posture.request.json');
    const neither = { ...vitals }; delete neither.findings;
    expect(validateInterpretationRequest(neither).ok).toBe(false);
    expect(validateInterpretationRequest({ ...vitals, nativePayload: posture.nativePayload }).ok).toBe(false);
  });
  it('a nativePayload carries exactly one of bundle or unsigned, in the known format', () => {
    const posture = load('posturepulse-posture.request.json');
    const np = posture.nativePayload;
    expect(validateInterpretationRequest({ ...posture, nativePayload: { ...np, bundle: { payload: {}, signature: 'x' } } }).ok).toBe(false);
    expect(validateInterpretationRequest({ ...posture, nativePayload: { format: np.format } }).ok).toBe(false);
    expect(validateInterpretationRequest({ ...posture, nativePayload: { ...np, format: 'other/v1' } }).ok).toBe(false);
  });
});
