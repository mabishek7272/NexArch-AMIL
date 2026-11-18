/**
 * Deterministic lab-result candidate extraction from page text (plan §7.1).
 *
 * Produces CANDIDATES, not observations: each keeps the raw text exactly, its
 * page/line source, the extraction method, and uncertainty flags. Nothing is
 * converted, normalised to a clinical meaning, or inferred. Lines that don't
 * match the conservative pattern are simply not candidates (reported as such).
 */

export type CandidateFlag =
  | 'missing_unit'
  | 'inequality_value'
  | 'comma_decimal_ambiguous'
  | 'missing_reference_interval'
  | 'ocr_source'
  | 'ocr_low_confidence'
  | 'lab_flag_present';

export interface LabCandidate {
  analyte: string;
  valueRaw: string;
  comparator: '<' | '>' | '<=' | '>=' | null;
  valueNum: number | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  labFlag: string | null;
  page: number;
  line: number;
  sourceText: string;
  method: 'native_text' | 'ocr';
  ocrConfidence: number | null;
  flags: CandidateFlag[];
}

import { OcrPolicyView, SYNTHETIC_VIEW } from '../ocr-policy/policy';

const NUM = String.raw`-?\d+(?:[.,]\d+)?`;
const LINE = new RegExp(
  String.raw`^(?<analyte>[A-Za-z][A-Za-z0-9 ,()/%'.\-]{1,60}?)\s*[:\s]\s*` +
  String.raw`(?<cmp><=|>=|≤|≥|<|>)?\s*(?<value>${NUM})` +
  String.raw`(?:\s*(?!(?:H|L|HH|LL|HIGH|LOW)\s*$)(?<unit>(?:[a-zA-Zµμ%][a-zA-Z0-9µμ%/^.*]*|10\^\d+/[a-zA-Z]+)))?` +
  String.raw`(?:\s*\(?\s*(?<low>${NUM})\s*(?:-|–|to)\s*(?<high>${NUM})\s*\)?)?` +
  String.raw`(?:\s*(?<flag>H|L|HH|LL|HIGH|LOW|\*))?\s*$`,
);

const EXCLUDE = /^(page|date|dob|age|tel|phone|fax|mrn|id|ref|reference|specimen|collected|received|reported|patient|name)\b/i;

function toNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  if (/^-?\d+,\d+$/.test(s)) return null; // ambiguous comma: never guess
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseLabLines(
  text: string,
  page: number,
  method: 'native_text' | 'ocr',
  ocrConfidence: number | null = null,
  /** The ONE OCR study-policy version this parse follows (src/ocr-policy). The default is the explicitly labelled SYNTHETIC test policy: this workflow is synthetic-only until a real policy can be activated. */
  policy: Pick<OcrPolicyView, 'confidenceFlagThreshold' | 'enabledReviewFlags'> = SYNTHETIC_VIEW,
): LabCandidate[] {
  const out: LabCandidate[] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim().replace(/\s+/g, ' ');
    if (!line || EXCLUDE.test(line)) return;
    const m = LINE.exec(line);
    if (!m?.groups) return;
    const g = m.groups;
    const cmpMap: Record<string, LabCandidate['comparator']> = { '<': '<', '>': '>', '<=': '<=', '>=': '>=', '≤': '<=', '≥': '>=' };
    const flags: CandidateFlag[] = [];
    const on = new Set<string>(policy.enabledReviewFlags); const raise = (f: CandidateFlag, cond: boolean) => { if (cond && on.has(f)) flags.push(f); };
    raise('missing_unit', !g.unit);
    raise('inequality_value', !!g.cmp);
    raise('comma_decimal_ambiguous', [g.value, g.low, g.high].some((v) => v && /,/.test(v)));
    raise('missing_reference_interval', g.low === undefined);
    raise('ocr_source', method === 'ocr');
    raise('ocr_low_confidence', method === 'ocr' && (ocrConfidence === null || ocrConfidence < policy.confidenceFlagThreshold));
    raise('lab_flag_present', !!g.flag);
    out.push({
      analyte: g.analyte.trim().replace(/[:\s]+$/, ''),
      valueRaw: `${g.cmp ?? ''}${g.value}`,
      comparator: g.cmp ? cmpMap[g.cmp] : null,
      valueNum: toNum(g.value),
      unit: g.unit ?? null,
      refLow: toNum(g.low),
      refHigh: toNum(g.high),
      refText: g.low !== undefined ? `${g.low}-${g.high}` : null,
      labFlag: g.flag ?? null,
      page,
      line: i + 1,
      sourceText: rawLine.trim(),
      method,
      ocrConfidence,
      flags,
    });
  });
  return out;
}
