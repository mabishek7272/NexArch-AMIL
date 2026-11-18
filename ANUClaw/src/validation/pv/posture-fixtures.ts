/**
 * SYNTHETIC posture fixtures: DRAWN stick-figure SVGs and a parametric stand-in for a "system under test". No real person, no photograph, no video. A response to these
 * cases says nothing about performance on humans (different anatomy, clothing, lighting, motion, camera, skin tones, occlusion patterns).
 */
import * as crypto from 'crypto';
import { canonical, sha256Hex } from '../study/manifest';

export const SCENARIOS = ['neutral', 'shoulder_tilt', 'trunk_asymmetry', 'altered_posture', 'blur', 'occlusion', 'rotation', 'framing', 'lighting', 'multi_person', 'no_person', 'uncalibrated'] as const;
export type Scenario = typeof SCENARIOS[number];
export const METRIC_KEYS = { tilt: 'static.shoulder_line_tilt', lean: 'static.trunk_lean' } as const;
export interface Params { shoulderTiltDeg: number; trunkLeanDeg: number; blur: number; occlusion: number; rotationDeg: number; inFrame: number; light: number; persons: number; scaleKnown: boolean }
export interface PostureCase { caseId: string; scenario: Scenario; subjectId: string; params: Params; svg: string; /** truth of the DRAWN figure; absent when the scenario is deliberately unmeasurable */ reference: { tilt: number; lean: number } | null; unmeasurableReason: string | null }
const NEUTRAL: Params = { shoulderTiltDeg: 0, trunkLeanDeg: 0, blur: 0, occlusion: 0, rotationDeg: 0, inFrame: 1, light: 1, persons: 1, scaleKnown: true };
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const f1 = (n: number) => Math.round(n * 10) / 10;

export function drawSvg(id: string, p: Params): string {
  const fig = (dx: number) => `<g transform="translate(${dx},0) rotate(${f1(p.rotationDeg)},160,120)"><circle cx="160" cy="50" r="18" fill="none" stroke="black"/><line x1="160" y1="68" x2="${f1(160 + p.trunkLeanDeg * 1.2)}" y2="170" stroke="black"/>` +
    `<line x1="${f1(110)}" y1="${f1(95 - p.shoulderTiltDeg * 1.0)}" x2="${f1(210)}" y2="${f1(95 + p.shoulderTiltDeg * 1.0)}" stroke="black" stroke-width="3"/></g>`;
  const figs = Array.from({ length: Math.max(0, p.persons) }, (_, i) => fig(i * 120 + (p.inFrame < 1 ? Math.round((1 - p.inFrame) * 400) : 0))).join('');
  return `<?xml version="1.0"?>\n<!-- SYNTHETIC-DRAWN-FIXTURE ${id}: a drawn stick figure; no real person, photograph or video -->\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" data-synthetic="true">` +
    `<defs><filter id="b"><feGaussianBlur stdDeviation="${f1(p.blur * 8)}"/></filter></defs><rect width="320" height="240" fill="${p.light < 0.5 ? '#222' : '#fff'}" opacity="${f1(0.4 + p.light * 0.6)}"/>` +
    `<g filter="url(#b)">${figs}</g>${p.occlusion > 0 ? `<rect x="90" y="70" width="${Math.round(p.occlusion * 160)}" height="60" fill="gray"/>` : ''}</svg>\n`;
}
const REASONS: Partial<Record<Scenario, string>> = { blur: 'low_image_quality', occlusion: 'occluded', rotation: 'rotation_out_of_range', framing: 'subject_out_of_frame', lighting: 'insufficient_light', multi_person: 'multiple_people', no_person: 'no_pose_detected', uncalibrated: 'scale_unknown' };
export function postureCases(perScenario = 4, seed = 20261118): PostureCase[] {
  const r = rng(seed); const out: PostureCase[] = []; let n = 0;
  for (const scenario of SCENARIOS) for (let i = 0; i < perScenario; i++) {
    const p: Params = { ...NEUTRAL }; const jit = (a: number, b: number) => f1(a + r() * (b - a));
    switch (scenario) {
      case 'shoulder_tilt': p.shoulderTiltDeg = jit(4, 9) * (r() < 0.5 ? -1 : 1); break;
      case 'trunk_asymmetry': p.trunkLeanDeg = jit(3, 8) * (r() < 0.5 ? -1 : 1); break;
      case 'altered_posture': p.shoulderTiltDeg = jit(2, 5); p.trunkLeanDeg = jit(2, 6); break;
      case 'blur': p.blur = jit(0.7, 1); break; case 'occlusion': p.occlusion = jit(0.5, 0.9); break; case 'rotation': p.rotationDeg = jit(35, 70); break; case 'framing': p.inFrame = jit(0.2, 0.6); break;
      case 'lighting': p.light = jit(0.05, 0.2); break; case 'multi_person': p.persons = 2 + Math.floor(r() * 2); break; case 'no_person': p.persons = 0; break; case 'uncalibrated': p.scaleKnown = false; break; default: break;
    }
    const caseId = `pv-${scenario}-${i + 1}`; const reason = REASONS[scenario] ?? null; n++;
    out.push({ caseId, scenario, subjectId: `drawn-figure-${scenario}-${i + 1}`, params: p, svg: drawSvg(caseId, p), reference: reason ? null : { tilt: p.shoulderTiltDeg, lean: p.trunkLeanDeg }, unmeasurableReason: reason });
  }
  void n; return out;
}

// ── parametric stand-in for a system under test (NOT a pose model) ─────────
export interface StubConfig { noiseSd: number; gate: { maxBlur: number; maxOcclusion: number; maxRotationDeg: number; minInFrame: number; minLight: number; maxPersons: number }; defect?: 'emit_value_when_unmeasurable' | 'bias' | 'drop_outputs' | 'no_reason_code'; biasDeg?: number }
export const DEFAULT_STUB: StubConfig = { noiseSd: 0.4, gate: { maxBlur: 0.5, maxOcclusion: 0.3, maxRotationDeg: 25, minInFrame: 0.8, minLight: 0.25, maxPersons: 1 } };
export type StubItem = { clipId: string; subjectId: string; repeat: number; metricKey: string; unit: string; status: 'estimate' | 'unsupported' | 'not_measurable'; value?: number; uncertainty?: number; reason?: string };
export function stubGate(p: Params, g: StubConfig['gate']): string | null {
  if (p.persons === 0) return 'no_pose_detected'; if (p.persons > g.maxPersons) return 'multiple_people'; if (p.inFrame < g.minInFrame) return 'subject_out_of_frame'; if (p.blur > g.maxBlur) return 'low_image_quality';
  if (p.occlusion > g.maxOcclusion) return 'occluded'; if (Math.abs(p.rotationDeg) > g.maxRotationDeg) return 'rotation_out_of_range'; if (p.light < g.minLight) return 'insufficient_light'; if (!p.scaleKnown) return 'scale_unknown'; return null;
}
/** Deterministic per (case, repeat, config): the same inputs always give the same outputs, so runs are reproducible and hashable. */
export function runStub(cases: Array<{ caseId: string; subjectId: string; params: Params }>, repeat: number, cfg: StubConfig = DEFAULT_STUB): StubItem[] {
  const out: StubItem[] = [];
  for (const c of cases) {
    const rand = rng(parseInt(sha256Hex(`${c.caseId}|${repeat}|${canonical(cfg)}`).slice(0, 8), 16)); const noise = () => (rand() + rand() + rand() - 1.5) * 2 * cfg.noiseSd; const reason = stubGate(c.params, cfg.gate);
    for (const [k, truth, unit] of [[METRIC_KEYS.tilt, c.params.shoulderTiltDeg, 'deg'], [METRIC_KEYS.lean, c.params.trunkLeanDeg, 'deg']] as const) {
      if (cfg.defect === 'drop_outputs' && parseInt(sha256Hex(c.caseId).slice(0, 2), 16) % 4 === 0) continue;
      if (reason && cfg.defect !== 'emit_value_when_unmeasurable') { out.push({ clipId: c.caseId, subjectId: c.subjectId, repeat, metricKey: k, unit, status: 'unsupported', ...(cfg.defect === 'no_reason_code' ? {} : { reason }) }); continue; }
      out.push({ clipId: c.caseId, subjectId: c.subjectId, repeat, metricKey: k, unit, status: 'estimate', value: f1x(truth + noise() + (cfg.defect === 'bias' ? cfg.biasDeg ?? 1.5 : 0)), uncertainty: 1.0 });
    }
  }
  return out;
}
const f1x = (n: number) => Math.round(n * 100) / 100;
export const hashOf = (o: unknown) => crypto.createHash('sha256').update(canonical(o)).digest('hex');
