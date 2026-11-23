/**
 * Guards for model-written narratives (interpretation engine, P4b). Deterministic code, no model. A narrative that fails
 * any HARD guard is not used; the fixed template is used instead. Soft problems are recorded only.
 *
 * What is enforced:
 *  - shape: strict keys, bounded sizes, no markup, links or markdown;
 *  - numbers: a section may contain only numbers belonging to the findings it cites (value, uncertainty, the reference the
 *    source supplied, digits in its own labels); nextSteps and limitations contain no numbers at all. This is what stops a
 *    model inventing a value or a range, or attaching one finding's range to another;
 *  - citations: each section cites at least one real finding, except plain context sections, which then have no numbers;
 *  - coverage: every finding that is out of range, flagged, or flagged by the source must be cited by the layer;
 *  - direction: a section that cites only out-of-range findings must not say "within/normal", and one that cites only
 *    in-range findings must not say "above/below/outside";
 *  - wording: no diagnosis, no reassurance, no treatment or medication advice, no contradiction of the referral notice.
 *    Negation- and context-aware, so "does not support a diagnosis" and "should be confirmed with a clinician" pass.
 */
import { numberTokens, numbersOf } from './input';
import type { GuardProblem, GuardResult, Layer, Narrative, NarrativeInput, NarrativeInputFinding, StatusLabel } from './types';

const LABELS = new Set<StatusLabel>(['source_finding', 'interpretation', 'limitation']);
export const NO_CITATION_OK = new Set(['overview', 'data_quality', 'context']);
const ID_RE = /^[a-z0-9_]{1,40}$/;
const MAX_SECTIONS = 40, MAX_TEXT = 1200, MAX_STEPS = 8, MAX_STEP = 300, MAX_LIMIT = 800;

// ── wording ─────────────────────────────────────────────────────────────────────────────────

const BANNED_PHRASES = [
  'you have diabetes', 'you are diabetic', 'you have hypertension', 'you are hypertensive', 'you have anemia', 'you have anaemia',
  'clinically normal', 'healthy heart', 'no risk', 'perfectly healthy', 'confirms normal', 'excellent health', 'nothing to worry',
  'you are healthy', "you're healthy", 'normal cardiovascular function', 'all clear', 'no cause for concern', 'nothing to be concerned',
  'rest assured', 'you are fine', "you're fine", 'good news', 'no need to see', 'no need to consult', 'no need for a doctor',
  'do not need to see', "don't need to see", 'not necessary to see', 'no need to worry', 'not a concern',
];
/** Stems that must not appear unless a negation sits shortly before them, grouped by what they would amount to. */
const DIAGNOSTIC_STEMS = [
  'diabet', 'hypertens', 'hypotens', 'anemi', 'anaemi', 'disease', 'disorder', 'pathology', 'syndrome', 'scolio', 'kypho', 'lordo',
  'arthrit', 'tachycard', 'bradycard', 'hypox', 'hyperglyc', 'hypoglyc', 'cancer', 'infarct', 'diagnos',
];
const REASSURANCE_STEMS = ['healthy', 'reassur'];
const TREATMENT_STEMS = ['treat', 'prescri', 'medicat', 'dosage', 'surg', 'exercis', 'stretch'];
/** Substrings (not prefixes): "physiotherapy" and "therapist" both contain "therap". */
const TREATMENT_CONTAINS = ['therap'];
/** Whole words (not stems): "safe" must not match "safety", "dose" must not match "dosage" twice. */
const REASSURANCE_WORDS = ['safe'];
const TREATMENT_WORDS = ['dose', 'doses'];
const NEGATION = /\b(not|no|never|without|cannot|neither|nor|rather than|instead of)\b|n't\b/;
/**
 * A negation that REVERSES a statement into reassurance: "does not on its own mean anything is wrong" tells a reader their out-of-range
 * result is probably fine. (Found live: the model wrote exactly this and the negation-aware phrase list let it through, because there
 * a negation makes a phrase safe.) The safe wording is "does not support a diagnosis" or "cannot say whether you are well".
 */
const REASSURING_NEGATION = /\b(?:does not|doesn't|do not|don't|is not|isn't|not)\b[^.!?]{0,40}\b(?:mean|indicate|suggest|imply|show|sign)\b[^.!?]{0,30}\b(?:anything|something|a problem|wrong|serious|bad|concerning|worrying)\b/;
const SAFE_CONTEXT = ['clinician', 'clinical', 'laborator', 'licensed', 'validated', 'physician', 'doctor', 'professional', 'device', 'measurement'];
const CONFIRM_WORDS = ['confirmed', 'cleared'];
const RELAY_MARK = /\b(marks?|marked|flags?|flagged|labell?ed|labell?ing|states?|stated)\b/;
const RELAY_SOURCE = /\b(source|app|application)\b/;

const sentencesOf = (t: string): string[] => t.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Remove the source's own labels so a label such as "Disease Risk" is not mistaken for the model's wording. */
function stripLabels(sentence: string, labels: string[]): string {
  let s = sentence.toLowerCase();
  for (const l of labels) { const ll = l.toLowerCase(); if (ll.length >= 3) s = s.split(ll).join(' '); }
  return s;
}

function wordingProblems(text: string, labels: string[], code: (c: string) => GuardProblem): GuardProblem[] {
  const out: GuardProblem[] = [];
  for (const sentence of sentencesOf(text)) {
    const low = stripLabels(sentence, labels);
    for (const ph of BANNED_PHRASES) {
      // A phrase is only a problem when it is asserted: "cannot say whether you are healthy" is the safe wording, "you are healthy" is not.
      for (let at = low.indexOf(ph); at !== -1; at = low.indexOf(ph, at + 1)) {
        if (!NEGATION.test(low.slice(Math.max(0, at - 40), at))) { out.push(code('banned_phrase')); break; }
      }
    }
    if (REASSURING_NEGATION.test(low)) out.push(code('reassurance'));
    const tokens = low.split(/[^a-z']+/).filter(Boolean);
    tokens.forEach((tok, i) => {
      const negated = NEGATION.test(tokens.slice(Math.max(0, i - 8), i).join(' '));
      const kind = DIAGNOSTIC_STEMS.some((st) => tok.startsWith(st)) ? 'diagnostic_wording'
        : REASSURANCE_STEMS.some((st) => tok.startsWith(st)) || REASSURANCE_WORDS.includes(tok) ? 'reassurance'
        : TREATMENT_STEMS.some((st) => tok.startsWith(st)) || TREATMENT_CONTAINS.some((st) => tok.includes(st)) || TREATMENT_WORDS.includes(tok) ? 'treatment_wording'
        : null;
      // "non-diagnostic" and "non-validated" are negations too (found live: a clinically correct limitation was rejected for them).
      if (kind && !negated && tokens[i - 1] !== 'non') out.push(code(kind));
      if ((tok === 'normal' || tok === 'abnormal') && !(RELAY_MARK.test(low) && RELAY_SOURCE.test(low))) out.push(code('reassurance'));
      if (CONFIRM_WORDS.includes(tok) && !SAFE_CONTEXT.some((c) => low.includes(c))) out.push(code('unattributed_confirmation'));
    });
  }
  return out;
}

// ── position / direction ─────────────────────────────────────────────────────────────────────

const OUTSIDE = /\b(above|below|outside|exceed\w*|higher than|lower than|elevated|raised|beyond)\b/;
const INSIDE = /\b(within|inside|in range|in the range|normal)\b/;
const isOut = (f: NarrativeInputFinding) => f.position === 'above' || f.position === 'below';

/** Findings every layer must cite: out of range, flagged by governance, or flagged high/low/review by the source. */
export function mustCite(input: NarrativeInput): string[] {
  const flagged = new Set(input.flags.filter((f) => f.severity !== 'info').flatMap((f) => f.findingKeys ?? []));
  return input.findings
    .filter((f) => isOut(f) || flagged.has(f.key) || f.sourceFlag === 'high' || f.sourceFlag === 'low' || f.sourceFlag === 'review')
    .map((f) => f.key);
}

// ── shape ────────────────────────────────────────────────────────────────────────────────────

/** Strict structural validation. Returns problems, or null and the typed value. */
export function shapeNarrative(raw: unknown): { problems: GuardProblem[]; value: Narrative | null } {
  const bad = (code: string, section?: string): { problems: GuardProblem[]; value: null } => ({ problems: [{ code, severity: 'hard', ...(section ? { section } : {}) }], value: null });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('shape_not_object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['sections', 'nextSteps', 'limitations'].includes(k)) return bad('shape_unknown_field');
  if (!Array.isArray(o.sections) || o.sections.length < 1 || o.sections.length > MAX_SECTIONS) return bad('shape_sections');
  if (!Array.isArray(o.nextSteps) || o.nextSteps.length > MAX_STEPS || !o.nextSteps.every((s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_STEP)) return bad('shape_next_steps');
  if (typeof o.limitations !== 'string' || o.limitations.length < 1 || o.limitations.length > MAX_LIMIT) return bad('shape_limitations');
  const seen = new Set<string>();
  const sections: Narrative['sections'] = [];
  for (const s of o.sections) {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return bad('shape_section');
    const x = s as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!['id', 'text', 'findingRefs', 'statusLabel'].includes(k)) return bad('shape_unknown_field');
    if (typeof x.id !== 'string' || !ID_RE.test(x.id) || seen.has(x.id)) return bad('shape_section_id');
    seen.add(x.id);
    if (typeof x.text !== 'string' || x.text.trim().length < 1 || x.text.length > MAX_TEXT) return bad('shape_section_text', x.id);
    if (!Array.isArray(x.findingRefs) || !x.findingRefs.every((r) => typeof r === 'string' && r.length <= 80)) return bad('shape_refs', x.id);
    if (typeof x.statusLabel !== 'string' || !LABELS.has(x.statusLabel as StatusLabel)) return bad('shape_status_label', x.id);
    sections.push({ id: x.id, text: x.text, findingRefs: x.findingRefs as string[], statusLabel: x.statusLabel as StatusLabel });
  }
  return { problems: [], value: { sections, nextSteps: o.nextSteps as string[], limitations: o.limitations } };
}

// ── reading level (soft) ─────────────────────────────────────────────────────────────────────

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}
export function readingGrade(text: string): number {
  const sentences = Math.max(1, sentencesOf(text).length);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (!words.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return Math.round((0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59) * 10) / 10;
}
export const LAYMAN_GRADE_LIMIT = 10;

// ── the guards ───────────────────────────────────────────────────────────────────────────────

export function checkNarrative(layer: Layer, n: Narrative, input: NarrativeInput): GuardResult {
  const problems: GuardProblem[] = [];
  const add = (code: string, section?: string, severity: 'hard' | 'soft' = 'hard') => problems.push({ code, severity, ...(section ? { section } : {}) });
  const byKey = new Map(input.findings.map((f) => [f.key, f]));
  const labels = input.findings.flatMap((f) => [f.label, f.group ?? '']).concat([input.application]);

  const allText = [...n.sections.map((s) => s.text), ...n.nextSteps, n.limitations];
  for (const t of allText) {
    if (/<\s*[a-z/!]/i.test(t) || /https?:|javascript:|www\./i.test(t) || /\]\(|`|\*\*|^#{1,6}\s/m.test(t)) { add('markup_or_link'); break; }
  }

  const cited = new Set<string>();
  for (const s of n.sections) {
    const refs = [...new Set(s.findingRefs)];
    const unknown = refs.filter((r) => !byKey.has(r));
    if (unknown.length) add('unknown_citation', s.id);
    const real = refs.filter((r) => byKey.has(r));
    real.forEach((r) => cited.add(r));
    if (!real.length && !NO_CITATION_OK.has(s.id)) add('missing_citation', s.id);

    const allowed = new Set<string>();
    for (const r of real) for (const t of numbersOf(byKey.get(r)!)) allowed.add(t);
    for (const t of numberTokens(s.text)) if (!allowed.has(t)) { add('number_not_in_cited_findings', s.id); break; }

    if (real.length) {
      const cf = real.map((r) => byKey.get(r)!);
      const low = s.text.toLowerCase();
      const onlyOut = cf.every(isOut), onlyIn = cf.every((f) => f.position === 'within');
      if (onlyOut && INSIDE.test(stripLabels(low, labels))) add('direction_contradicts_position', s.id);
      if (onlyIn && OUTSIDE.test(stripLabels(low, labels))) add('direction_contradicts_position', s.id);
      if (cf.length === 1 && cf[0].position === 'above' && /\b(below|lower than)\b/.test(low)) add('direction_contradicts_position', s.id);
      if (cf.length === 1 && cf[0].position === 'below' && /\b(above|higher than)\b/.test(low)) add('direction_contradicts_position', s.id);
    }
    if (s.statusLabel === 'limitation' && numberTokens(s.text).length) add('number_in_limitation', s.id);
  }
  for (const step of n.nextSteps) if (numberTokens(step).length) { add('number_in_next_steps'); break; }
  if (numberTokens(n.limitations).length) add('number_in_limitations');

  for (const key of mustCite(input)) if (!cited.has(key)) add('flagged_finding_not_cited');

  for (const s of n.sections) for (const p of wordingProblems(s.text, labels, (c) => ({ code: c, severity: 'hard', section: s.id }))) problems.push(p);
  for (const t of [...n.nextSteps, n.limitations]) for (const p of wordingProblems(t, labels, (c) => ({ code: c, severity: 'hard' }))) problems.push(p);

  let grade: number | undefined;
  if (layer === 'layman') {
    grade = readingGrade(allText.join(' '));
    if (grade > LAYMAN_GRADE_LIMIT) add('reading_level_high', undefined, 'soft');
  }
  // de-duplicate identical problems
  const seen = new Set<string>();
  const unique = problems.filter((p) => { const k = `${p.code}|${p.section ?? ''}|${p.severity}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: !unique.some((p) => p.severity === 'hard'), problems: unique, ...(grade !== undefined ? { readingGrade: grade } : {}) };
}

/** Both layers describe the same findings: each must cite every must-cite finding, so they cannot disagree about which are out of range or flagged. */
export function layersAgree(clinical: Narrative, layman: Narrative, input: NarrativeInput): boolean {
  const need = mustCite(input);
  const cites = (n: Narrative) => new Set(n.sections.flatMap((s) => s.findingRefs));
  const c = cites(clinical), l = cites(layman);
  return need.every((k) => c.has(k) && l.has(k));
}
