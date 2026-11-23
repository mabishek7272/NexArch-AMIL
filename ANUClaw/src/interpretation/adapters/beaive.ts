/**
 * beAIve adapter (interpretation engine, P3a): converts a beAIve face-scan vitals request into normalized findings.
 *
 * Rules this adapter follows, because it sits in front of clinical interpretation:
 *  - It never invents a value or a range. Only what beAIve stated, or what is computed deterministically from stated
 *    values (splitting "154/94" into systolic/diastolic), is emitted; computed values are marked `derived`.
 *  - A null value stays `missing` and raises a flag. Nothing fills it in.
 *  - A reference range is carried as `tenant_supplied` and is only given numeric bounds when beAIve supplied them or
 *    the text is an unambiguous pattern ("<129/90", "60-100", ">95"). A sex-dependent range ("M:14-18, F:12-16") is
 *    resolved ONLY when the request states sexAtBirth as female or male; otherwise it stays text with an info flag.
 *  - Keys it does not know are kept under `unmapped.*` and flagged, never silently dropped.
 */
import type { GovernanceContext } from '../governance/types';
import type { Adapter, AdapterOutput, NormalizedFinding, NormalizedFlag, RequestFinding, StoredRequest } from './types';

export const BEAIVE_ADAPTER_ID = 'beaive-v1';
export const BEAIVE_ADAPTER_VERSION = '1.0.0';

const CANONICAL: Record<string, string> = {
  hr: 'heart_rate_bpm', rr: 'breathing_rate_per_min', spo2: 'spo2_percent', wellness_score: 'wellness_score',
  bp_risk: 'bp_risk_category', hba1c_risk: 'hba1c_risk_category', glucose_risk: 'fasting_glucose_risk_category',
  ascvd: 'ascvd_risk_percent', hba1c: 'hba1c_percent', hemoglobin: 'hemoglobin_g_dl', stress_index: 'stress_index',
  pns_zone: 'pns_zone', sns_zone: 'sns_zone', rmssd: 'rmssd_ms', sdnn: 'sdnn_ms', lf_hf: 'lf_hf_ratio',
};

type Ref = NonNullable<NormalizedFinding['reference']>;
const NUM = '(\\d+(?:\\.\\d+)?)';

function sanitizeKey(k: string): string { return `unmapped.${k.toLowerCase().replace(/[^a-z0-9_.]/g, '_')}`.slice(0, 80); }

/** Parses only unambiguous single-range texts. Returns null when it is not sure (the text is then kept as text only). */
function parseRangeText(text: string): Partial<Ref> | null {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(new RegExp(`^<=\\s*${NUM}$`)))) return { upper: Number(m[1]), upperInclusive: true };
  if ((m = t.match(new RegExp(`^<\\s*${NUM}$`)))) return { upper: Number(m[1]), upperInclusive: false };
  if ((m = t.match(new RegExp(`^>=\\s*${NUM}$`)))) return { lower: Number(m[1]), lowerInclusive: true };
  if ((m = t.match(new RegExp(`^>\\s*${NUM}$`)))) return { lower: Number(m[1]), lowerInclusive: false };
  if ((m = t.match(new RegExp(`^${NUM}\\s*-\\s*${NUM}$`)))) {
    const lo = Number(m[1]), hi = Number(m[2]);
    return lo <= hi ? { lower: lo, upper: hi, lowerInclusive: true, upperInclusive: true } : null;
  }
  return null;
}

function toReference(f: RequestFinding, sex: string | undefined, flags: NormalizedFlag[], key: string): Ref | undefined {
  const r = f.sourceReference;
  if (!r) return undefined;
  const out: Ref = { origin: 'tenant_supplied' };
  if (r.text !== undefined) out.text = r.text;
  if (r.citation !== undefined) out.citation = r.citation;
  const hasBounds = r.lower !== undefined || r.upper !== undefined;
  if (hasBounds) {
    for (const k of ['lower', 'upper', 'lowerInclusive', 'upperInclusive'] as const) if (r[k] !== undefined) (out as any)[k] = r[k];
    return out;
  }
  if (!r.text) return out;
  const bySex = r.text.match(new RegExp(`^M:\\s*${NUM}\\s*-\\s*${NUM}\\s*,\\s*F:\\s*${NUM}\\s*-\\s*${NUM}$`, 'i'));
  if (bySex) {
    if (sex === 'male' || sex === 'female') {
      const [lo, hi] = sex === 'male' ? [Number(bySex[1]), Number(bySex[2])] : [Number(bySex[3]), Number(bySex[4])];
      if (lo <= hi) Object.assign(out, { lower: lo, upper: hi, lowerInclusive: true, upperInclusive: true });
    } else {
      flags.push({ type: 'missing_data', severity: 'info', findingKeys: [key], detail: 'The source reference depends on sex and sexAtBirth was not provided as female or male, so no numeric range was applied.' });
    }
    return out;
  }
  const parsed = parseRangeText(r.text);
  if (parsed) Object.assign(out, parsed);
  return out;
}

function base(f: RequestFinding, key: string, flags: NormalizedFlag[], sex: string | undefined): NormalizedFinding {
  const n: NormalizedFinding = {
    findingKey: key, sourceKey: f.key, label: f.label,
    valueStatus: f.value === null ? 'missing' : 'stated', value: f.value,
  };
  if (f.group !== undefined) n.group = f.group;
  if (f.unit !== undefined) n.unit = f.unit;
  if (f.uncertainty) n.uncertainty = 'plusMinus' in f.uncertainty ? { plusMinus: f.uncertainty.plusMinus } : { interval: f.uncertainty.interval };
  if (f.confidence !== undefined) n.confidence = f.confidence;
  const ref = toReference(f, sex, flags, key);
  if (ref) n.reference = ref;
  if (f.sourceFlag !== undefined) n.sourceFlag = f.sourceFlag;
  if (f.underResearch !== undefined) n.underResearch = f.underResearch;
  if (f.excluded) n.excluded = { reason: f.excluded.reason };
  return n;
}

function splitBloodPressure(f: RequestFinding, own: NormalizedFinding, out: NormalizedFinding[], flags: NormalizedFlag[]): void {
  const m = typeof f.value === 'string' ? f.value.match(/^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/) : null;
  if (!m) {
    if (f.value !== null) flags.push({ type: 'review_required', severity: 'attention', findingKeys: [own.findingKey], detail: 'The blood pressure value is not in SYSTOLIC/DIASTOLIC form, so it was kept as given and not split.' });
    return;
  }
  const sys = Number(m[1]), dia = Number(m[2]);
  const refText = f.sourceReference?.text?.match(new RegExp(`^<\\s*${NUM}\\s*/\\s*${NUM}$`));
  const unit = f.unit ?? 'mmHg';
  const mk = (key: string, label: string, value: number, upper: number | undefined): NormalizedFinding => {
    const d: NormalizedFinding = {
      findingKey: key, sourceKey: f.key, label, valueStatus: 'derived', value, unit,
      derivation: { fromKeys: [f.key], rule: 'split_bp_string' },
    };
    if (f.group !== undefined) d.group = f.group;
    if (upper !== undefined) d.reference = { origin: 'tenant_supplied', text: `<${upper}`, upper, upperInclusive: false };
    if (f.underResearch !== undefined) d.underResearch = f.underResearch;
    if (f.excluded) d.excluded = { reason: f.excluded.reason };
    return d;
  };
  out.push(mk('bp_systolic_mmhg', 'Systolic blood pressure', sys, refText ? Number(refText[1]) : undefined));
  out.push(mk('bp_diastolic_mmhg', 'Diastolic blood pressure', dia, refText ? Number(refText[2]) : undefined));
  if (sys <= dia || sys < 50 || sys > 300 || dia < 20 || dia > 200) {
    flags.push({ type: 'implausible_value', severity: 'attention', findingKeys: ['bp_systolic_mmhg', 'bp_diastolic_mmhg'], detail: 'The blood pressure values fall outside a plausible range or systolic is not above diastolic. Values were kept as given.' });
  }
}

/**
 * What governance needs to know about beAIve findings. None of this is a clinical threshold:
 *  - riskIndicatorKeys: beAIve's own risk-CATEGORY indicators; the source flagging one high/review triggers the referral advisory.
 *  - highRiskKeys: numeric findings for which being outside beAIve's own reference triggers the advisory.
 *    DRAFT LIST, pending clinician approval: edit here (and bump the adapter version) when the clinical lead decides.
 *  - plausibleRanges: sanity bounds that separate "measurement error" from "measurement"; outside is a data-quality flag.
 */
export const BEAIVE_GOVERNANCE: GovernanceContext = {
  riskIndicatorKeys: ['bp_risk_category', 'hba1c_risk_category', 'fasting_glucose_risk_category'],
  highRiskKeys: ['bp_systolic_mmhg', 'bp_diastolic_mmhg', 'hba1c_percent', 'spo2_percent'],
  plausibleRanges: {
    heart_rate_bpm: [20, 250], breathing_rate_per_min: [3, 70], spo2_percent: [50, 100], bp_systolic_mmhg: [50, 300], bp_diastolic_mmhg: [20, 200],
    hba1c_percent: [2, 20], hemoglobin_g_dl: [3, 25], ascvd_risk_percent: [0, 100],
  },
  expectedUnits: {
    heart_rate_bpm: 'bpm', breathing_rate_per_min: 'breaths/min', spo2_percent: '%', bp_systolic_mmhg: 'mmHg', bp_diastolic_mmhg: 'mmHg',
    hba1c_percent: '%', hemoglobin_g_dl: 'g/dL', ascvd_risk_percent: '%', rmssd_ms: 'ms', sdnn_ms: 'ms',
  },
};

export const beaiveAdapter: Adapter = {
  id: BEAIVE_ADAPTER_ID,
  version: BEAIVE_ADAPTER_VERSION,
  input: 'findings',
  governance: BEAIVE_GOVERNANCE,
  run(req: StoredRequest): AdapterOutput {
    const sex = req.subject.demographics?.sexAtBirth;
    const findings: NormalizedFinding[] = [];
    const flags: NormalizedFlag[] = [];
    const unmapped: string[] = [], missing: string[] = [], research: string[] = [];

    for (const f of req.findings ?? []) {
      const isBp = f.key === 'bp';
      const mapped = isBp ? 'bp' : CANONICAL[f.key];
      const key = mapped ?? sanitizeKey(f.key);
      const n = base(f, key, flags, sex);
      findings.push(n);
      if (!mapped) unmapped.push(key);
      if (n.valueStatus === 'missing') missing.push(key);
      if (f.underResearch) research.push(key);
      if (isBp) splitBloodPressure(f, n, findings, flags);
    }
    if (missing.length) flags.push({ type: 'missing_data', severity: 'attention', findingKeys: missing, detail: 'The source could not measure these values; they are kept as missing and nothing was filled in.' });
    if (unmapped.length) flags.push({ type: 'unmapped_key', severity: 'info', findingKeys: unmapped, detail: 'These source keys are not known to this adapter; they are kept as given and not interpreted.' });
    if (research.length || req.source.researchStatus === 'under_research') {
      flags.push({ type: 'under_research', severity: 'info', ...(research.length ? { findingKeys: research } : {}), detail: 'The source states these estimates are still under research and are not equivalent to a laboratory result.' });
    }
    return { findings, flags };
  },
};
