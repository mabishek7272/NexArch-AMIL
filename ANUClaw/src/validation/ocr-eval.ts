/**
 * Annotated OCR / extraction evaluation (plan §7.2, §16.2).
 *
 * Compares what the extraction pipeline produced with a human-annotated truth set: analyte, value, comparator, unit,
 * reference interval and PAGE attribution, and accounts for extraction failures separately from misses. The key safety
 * number is the SILENT error rate: wrong fields that carried no uncertainty flag.
 */
import { OcrPolicyView, PolicyError, SYNTHETIC_VIEW, stampOf, UnitEquivalence } from '../ocr-policy/policy';
import { assessEvidence, EvidenceReport, EvidenceKind, rate, Rate, requireSchema, ValidationInputError } from './common';

export interface OcrTruthItem { id: string; page: number; analyte: string; valueRaw: string; valueNum: number | null; comparator: string | null; unit: string | null; refLow: number | null; refHigh: number | null }
export interface OcrAnnotationSet {
  schema: 'anuclaw-ocr-annotation/v1';
  provenance: { kind: EvidenceKind; annotators: Array<{ id: string; role: string }>; adjudication: 'none' | 'double_annotated_adjudicated'; createdAt: string; notes?: string; protocolRef?: string };
  documents: Array<{ documentId: string; pages: number; truth: OcrTruthItem[] }>;
}
export interface OcrExtracted { analyte: string; valueRaw: string; comparator?: string | null; valueNum?: number | null; unit?: string | null; refLow?: number | null; refHigh?: number | null; page: number; flags?: string[]; ocrConfidence?: number | null }
export interface OcrResultSet {
  schema: 'anuclaw-ocr-extraction/v1';
  system: { engine: string; version: string };
  documents: Array<{ documentId: string; pages: Array<{ page: number; status: string }>; candidates: OcrExtracted[] }>;
}

export const normAnalyte = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
/** Unit normalization follows the policy's unit-equivalence record (no unit equivalence is hard-coded here). */
export function normUnit(u: string | null | undefined, eq: UnitEquivalence = SYNTHETIC_VIEW.unitEquivalence): string {
  let x = u ?? ''; if (eq.microSignToU) x = x.replace(/µ|μ/g, 'u'); if (eq.caseFold) x = x.toLowerCase(); x = eq.stripWhitespace ? x.replace(/\s+/g, '') : x.trim();
  for (const g of eq.equivalentGroups) { const gs = g.map((y) => normUnit(y, { ...eq, equivalentGroups: [] })); if (gs.includes(x)) return gs[0]; } return x;
}
const normValue = (s: string) => s.trim().replace(',', '.');
const numEq = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-9);

export interface ItemOutcome {
  documentId: string; truthId: string; analyte: string; truthPage: number;
  status: 'matched' | 'missed' | 'extraction_failure';
  detail?: string;
  fields?: { pageCorrect: boolean; valueCorrect: boolean; comparatorCorrect: boolean; unitCorrect: boolean; refLowCorrect: boolean; refHighCorrect: boolean; allCorrect: boolean };
  flagged?: boolean;
  /** Matched items only: the extracted candidate's relevant fields (for calibration and missing-field reports; additive). */
  candidate?: { ocrConfidence: number | null; flags: string[]; unit: string | null; comparator: string | null; refLow: number | null; refHigh: number | null; valueRaw: string };
}
export interface OcrEvaluation {
  schema: 'anuclaw-ocr-evaluation/v1';
  policy: ReturnType<typeof stampOf>;
  system: OcrResultSet['system'];
  counts: { documents: number; truthItems: number; matched: number; missed: number; extractionFailures: number; extraneousCandidates: number; pagesTotal: number; pagesFailed: number };
  recall: { all: Rate; excludingFailedPages: Rate };
  /** Precision counts every unannotated candidate as wrong; if the annotation is incomplete (values not annotated that really are on the page) it UNDERSTATES precision. */
  precision: Rate;
  fieldAccuracyAmongMatched: { page: Rate; value: Rate; comparator: Rate; unit: Rate; refLow: Rate; refHigh: Rate; allFields: Rate };
  uncertaintyFlags: { errorsInMatched: number; errorsFlagged: number; silentErrors: number; silentErrorRateAmongMatched: Rate; unflaggedCorrect: number; flaggedCorrect: number };
  failedPagesByStatus: Record<string, number>;
  outcomes: ItemOutcome[];
  extraneous: Array<{ documentId: string; analyte: string; valueRaw: string; page: number }>;
  evidence: EvidenceReport;
}

export function validateAnnotations(a: any): string[] {
  const p: string[] = [];
  if (a?.schema !== 'anuclaw-ocr-annotation/v1') p.push('annotation schema must be anuclaw-ocr-annotation/v1');
  if (!['synthetic_fixture', 'human_annotated'].includes(a?.provenance?.kind)) p.push('provenance.kind must be synthetic_fixture or human_annotated');
  if (!Array.isArray(a?.documents) || !a.documents.length) p.push('documents must be a non-empty array');
  const seen = new Set<string>();
  for (const d of a?.documents ?? []) {
    if (!d?.documentId || seen.has(d.documentId)) p.push(`duplicate or missing documentId ${d?.documentId}`); seen.add(d?.documentId);
    for (const t of d?.truth ?? []) {
      if (!t.id || !Number.isInteger(t.page) || t.page < 1 || t.page > d.pages) p.push(`${d.documentId}/${t.id}: page ${t.page} outside 1..${d.pages}`);
      if (!t.analyte || typeof t.valueRaw !== 'string') p.push(`${d.documentId}/${t.id}: analyte and valueRaw are required`);
    }
  }
  if (a?.provenance?.kind === 'human_annotated' && (a.provenance.annotators?.length ?? 0) < 1) p.push('human_annotated sets must name their annotators');
  return p;
}

/** A candidate counts as UNCERTAINTY-FLAGGED if it has any flag or an OCR confidence below `policy.confidenceFlagThreshold` (the ONE policy value shared with the parser). With no policy the labelled SYNTHETIC test policy applies. */
export function evaluateOcr(annotations: OcrAnnotationSet, results: OcrResultSet, opts: { policy?: OcrPolicyView } = {}): OcrEvaluation {
  const policy = opts.policy ?? SYNTHETIC_VIEW;
  requireSchema(annotations, 'anuclaw-ocr-annotation/v1', 'annotations'); requireSchema(results, 'anuclaw-ocr-extraction/v1', 'results');
  const problems = validateAnnotations(annotations); if (problems.length) throw new ValidationInputError(problems);
  // fail closed: human-annotated (real) evidence needs an ACTIVE real-study policy; none can exist in this build, and the synthetic test policy is never usable with real data
  if (annotations.provenance.kind === 'human_annotated') throw new PolicyError(policy.kind === 'synthetic_test' ? 'synthetic_policy_with_real_data' : 'policy_not_active', 'Real (human-annotated) evidence cannot be evaluated: no real-study OCR policy is active in this build (activation is blocked) and the synthetic test policy is never usable with real data.');
  const resByDoc = new Map(results.documents.map((d) => [d.documentId, d]));
  const missingDocs = annotations.documents.filter((d) => !resByDoc.has(d.documentId)).map((d) => d.documentId);
  if (missingDocs.length) throw new ValidationInputError([`results are missing annotated documents: ${missingDocs.join(', ')} (a document with no result must be reported as extraction failures, not omitted)`]);

  const outcomes: ItemOutcome[] = []; const extraneous: OcrEvaluation['extraneous'] = []; const failedByStatus: Record<string, number> = {};
  let pagesTotal = 0, pagesFailed = 0;
  const fields = { page: [0, 0], value: [0, 0], comparator: [0, 0], unit: [0, 0], refLow: [0, 0], refHigh: [0, 0], all: [0, 0] };
  let errors = 0, errorsFlagged = 0, silent = 0, flaggedCorrect = 0, unflaggedCorrect = 0, matched = 0, missed = 0, failures = 0, truthTotal = 0, extraneousCount = 0;

  for (const doc of annotations.documents) {
    const res = resByDoc.get(doc.documentId)!;
    const pageStatus = new Map(res.pages.map((p) => [p.page, p.status]));
    for (let pg = 1; pg <= doc.pages; pg++) { pagesTotal++; const st = pageStatus.get(pg) ?? 'missing_status'; if (st !== 'ok') { pagesFailed++; failedByStatus[st] = (failedByStatus[st] ?? 0) + 1; } }
    const used = new Set<number>();
    for (const t of doc.truth) {
      truthTotal++;
      const key = normAnalyte(t.analyte);
      // candidate selection: same analyte; prefer same page, then same value
      let best = -1, bestScore = -1;
      res.candidates.forEach((c, i) => {
        if (used.has(i) || normAnalyte(c.analyte) !== key) return;
        const score = (c.page === t.page ? 2 : 0) + (normValue(c.valueRaw) === normValue(t.valueRaw) ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (best < 0) {
        const st = pageStatus.get(t.page) ?? 'missing_status';
        if (st !== 'ok') { failures++; outcomes.push({ documentId: doc.documentId, truthId: t.id, analyte: t.analyte, truthPage: t.page, status: 'extraction_failure', detail: `page ${t.page} status ${st}` }); }
        else { missed++; outcomes.push({ documentId: doc.documentId, truthId: t.id, analyte: t.analyte, truthPage: t.page, status: 'missed', detail: 'no candidate for this analyte on a page that extracted ok' }); }
        continue;
      }
      used.add(best); matched++;
      const c = res.candidates[best];
      const f = {
        pageCorrect: c.page === t.page,
        valueCorrect: normValue(c.valueRaw) === normValue(t.valueRaw) && numEq(c.valueNum ?? null, t.valueNum),
        comparatorCorrect: (c.comparator ?? null) === (t.comparator ?? null),
        unitCorrect: normUnit(c.unit, policy.unitEquivalence) === normUnit(t.unit, policy.unitEquivalence),
        refLowCorrect: numEq(c.refLow, t.refLow), refHighCorrect: numEq(c.refHigh, t.refHigh), allCorrect: false,
      };
      f.allCorrect = f.pageCorrect && f.valueCorrect && f.comparatorCorrect && f.unitCorrect && f.refLowCorrect && f.refHighCorrect;
      const upd = (k: keyof typeof fields, ok: boolean) => { fields[k][1]++; if (ok) fields[k][0]++; };
      upd('page', f.pageCorrect); upd('value', f.valueCorrect); upd('comparator', f.comparatorCorrect); upd('unit', f.unitCorrect); upd('refLow', f.refLowCorrect); upd('refHigh', f.refHighCorrect); upd('all', f.allCorrect);
      const flagged = (c.flags?.length ?? 0) > 0 || (c.ocrConfidence != null && c.ocrConfidence < policy.confidenceFlagThreshold);
      if (!f.allCorrect) { errors++; if (flagged) errorsFlagged++; else silent++; } else if (flagged) flaggedCorrect++; else unflaggedCorrect++;
      outcomes.push({ documentId: doc.documentId, truthId: t.id, analyte: t.analyte, truthPage: t.page, status: 'matched', fields: f, flagged,
        candidate: { ocrConfidence: c.ocrConfidence ?? null, flags: c.flags ?? [], unit: c.unit ?? null, comparator: c.comparator ?? null, refLow: c.refLow ?? null, refHigh: c.refHigh ?? null, valueRaw: c.valueRaw } });
    }
    res.candidates.forEach((c, i) => { if (!used.has(i)) { extraneousCount++; extraneous.push({ documentId: doc.documentId, analyte: c.analyte, valueRaw: c.valueRaw, page: c.page }); } });
  }
  const evidence = assessEvidence({
    kind: annotations.provenance.kind, n: truthTotal, minN: policy.minTruthItems, minSource: 'policy',
    annotators: annotations.provenance.annotators?.length, protocolRef: annotations.provenance.protocolRef,
    adjudicated: undefined,  // human-annotated evidence is refused above (no active real policy), so only synthetic fixtures reach this point
    extra: annotations.documents.length < policy.minDocuments ? [`only ${annotations.documents.length} documents (minimum ${policy.minDocuments}, from policy ${policy.id}@${policy.version})`] : [],
  });
  return {
    schema: 'anuclaw-ocr-evaluation/v1', policy: stampOf(policy), system: results.system,
    counts: { documents: annotations.documents.length, truthItems: truthTotal, matched, missed, extractionFailures: failures, extraneousCandidates: extraneousCount, pagesTotal, pagesFailed },
    recall: { all: rate(matched, truthTotal), excludingFailedPages: rate(matched, truthTotal - failures) },
    precision: rate(matched, matched + extraneousCount),
    fieldAccuracyAmongMatched: { page: rate(fields.page[0], fields.page[1]), value: rate(fields.value[0], fields.value[1]), comparator: rate(fields.comparator[0], fields.comparator[1]), unit: rate(fields.unit[0], fields.unit[1]), refLow: rate(fields.refLow[0], fields.refLow[1]), refHigh: rate(fields.refHigh[0], fields.refHigh[1]), allFields: rate(fields.all[0], fields.all[1]) },
    uncertaintyFlags: { errorsInMatched: errors, errorsFlagged, silentErrors: silent, silentErrorRateAmongMatched: rate(silent, matched), unflaggedCorrect, flaggedCorrect },
    failedPagesByStatus: failedByStatus, outcomes, extraneous, evidence,
  };
}
