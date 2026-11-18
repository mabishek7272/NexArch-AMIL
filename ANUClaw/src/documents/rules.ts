/**
 * Versioned rule framework (plan §8, F13/F14).
 *
 * A rule runs only if it is RELEASED:
 *   - category 'report_presentation' (restates what the source document itself
 *     says, e.g. its own printed reference interval) needs a source description;
 *   - category 'clinical' additionally needs an approval record (approver role,
 *     date, evidence citation, population). This build ships NO approved
 *     clinical rules — none have clinical sign-off — so clinical evaluation
 *     returns an explicit `no_released_rules` state rather than inventing thresholds.
 * Results use explicit states; a no-flag result never means "healthy".
 */
import { createHash } from 'crypto';

export interface ObservationInput {
  id: string;
  analyte: string;
  valueRaw: string;
  comparator: string | null;
  valueNum: number | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  page: number | null;
}

export type FindingResult =
  | 'outside_reported_interval_high'
  | 'outside_reported_interval_low'
  | 'within_reported_interval'
  | 'insufficient_data'
  | 'not_comparable';

export interface Finding {
  ruleId: string;
  ruleVersion: string;
  observationId: string;
  result: FindingResult;
  reason: string;
}

export interface RuleApproval { approverRole: string; approvedAt: string; evidence: string; population: string }

export interface RuleDefinition {
  id: string;
  version: string;
  title: string;
  category: 'report_presentation' | 'clinical';
  source: string;
  approval?: RuleApproval;
  evaluate(obs: ObservationInput[]): Finding[];
}

export function isReleased(rule: RuleDefinition): boolean {
  if (!rule.source?.trim()) return false;
  if (rule.category === 'report_presentation') return true;
  const a = rule.approval;
  return Boolean(a && a.approverRole && a.approvedAt && a.evidence && a.population);
}

/** Compares a value with the reference interval printed on the SAME report. Not a clinical threshold. */
export const REPORTED_INTERVAL_RULE: RuleDefinition = {
  id: 'report.reported-interval-comparison',
  version: '1.0.0',
  title: 'Value compared with the laboratory-printed reference interval',
  category: 'report_presentation',
  source: 'The reference interval printed by the issuing laboratory on the source document. No external clinical threshold is applied.',
  evaluate(obs) {
    return obs.map((o): Finding => {
      const base = { ruleId: this.id, ruleVersion: this.version, observationId: o.id };
      if (o.refLow === null || o.refHigh === null) return { ...base, result: 'insufficient_data', reason: 'No reference interval was printed for this value.' };
      if (o.valueNum === null) return { ...base, result: 'not_comparable', reason: 'The value is not an unambiguous number.' };
      if (o.comparator) {
        // "<x" / ">x" values can only be compared when the bound decides it.
        if ((o.comparator.startsWith('<') && o.valueNum <= o.refLow) ) return { ...base, result: 'outside_reported_interval_low', reason: `Reported as ${o.valueRaw}, at or below the printed lower limit ${o.refLow}.` };
        if ((o.comparator.startsWith('>') && o.valueNum >= o.refHigh)) return { ...base, result: 'outside_reported_interval_high', reason: `Reported as ${o.valueRaw}, at or above the printed upper limit ${o.refHigh}.` };
        if (o.comparator.startsWith('<') && o.valueNum <= o.refHigh && o.valueNum > o.refLow) return { ...base, result: 'not_comparable', reason: `Reported as ${o.valueRaw}; the exact value relative to the interval cannot be determined.` };
        return { ...base, result: 'not_comparable', reason: `Reported as ${o.valueRaw}; comparison is not determinable.` };
      }
      if (o.valueNum > o.refHigh) return { ...base, result: 'outside_reported_interval_high', reason: `${o.valueRaw} is above the printed interval ${o.refLow}–${o.refHigh}.` };
      if (o.valueNum < o.refLow) return { ...base, result: 'outside_reported_interval_low', reason: `${o.valueRaw} is below the printed interval ${o.refLow}–${o.refHigh}.` };
      return { ...base, result: 'within_reported_interval', reason: `${o.valueRaw} is within the printed interval ${o.refLow}–${o.refHigh}.` };
    });
  },
};

/** Clinical rules require approval metadata; none are bundled (pending clinical lead sign-off). */
export const CLINICAL_RULES: RuleDefinition[] = [];

export const RULE_ENGINE_VERSION = 'anuclaw-rules-1.0.0';

export interface RuleRunOutput {
  engineVersion: string;
  rules: Array<{ id: string; version: string; released: boolean }>;
  clinicalState: 'evaluated' | 'no_released_rules';
  findings: Finding[];
}

export function runRules(obs: ObservationInput[], rules: RuleDefinition[] = [REPORTED_INTERVAL_RULE, ...CLINICAL_RULES]): RuleRunOutput {
  const released = rules.filter(isReleased);
  const clinicalReleased = released.filter((r) => r.category === 'clinical');
  return {
    engineVersion: RULE_ENGINE_VERSION,
    rules: rules.map((r) => ({ id: r.id, version: r.version, released: isReleased(r) })),
    clinicalState: clinicalReleased.length ? 'evaluated' : 'no_released_rules',
    findings: released.flatMap((r) => r.evaluate(obs)),
  };
}

/** Canonical JSON (sorted keys) for stable hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
}

export function sha256(v: unknown): string {
  return createHash('sha256').update(typeof v === 'string' ? v : canonicalJson(v)).digest('hex');
}
