/**
 * Flags governance adds on top of the adapter's (interpretation engine, P4a). Every rule is deterministic, reads only
 * the findings, and never alters a value. Thresholds here are ENGINEERING defaults for data quality, not clinical
 * limits, and are versioned with the ruleset.
 *
 *   blocking  : the data cannot be narrated safely as it stands (impossible value, wrong unit)
 *   attention : the reader should be told, the report may proceed
 */
import type { NormalizedFinding, NormalizedFlag } from '../adapters/types';
import type { FindingPosition, GovernanceContext } from './types';

export const CONFIDENCE_FLOOR = 0.5;
export const STALE_AFTER_DAYS = 30;
export const FUTURE_SKEW_MS = 5 * 60_000;

const normUnit = (u: string) => u.toLowerCase().replace(/\s+/g, '');

export function governanceFlags(findings: NormalizedFinding[], positions: FindingPosition[], capturedAt: string, ctx: GovernanceContext, nowMs: number): NormalizedFlag[] {
  const flags: NormalizedFlag[] = [];
  const posOf = new Map(positions.map((p) => [p.findingKey, p]));

  for (const f of findings) {
    if (f.excluded) continue;
    const key = f.findingKey;
    const pos = posOf.get(key)!.position;

    if (typeof f.value === 'number' && f.valueStatus !== 'missing') {
      const range = ctx.plausibleRanges[key];
      if (range && (f.value < range[0] || f.value > range[1])) {
        flags.push({ type: 'implausible_value', severity: 'blocking', findingKeys: [key], detail: 'The value is outside the range this system treats as physically possible for this measurement (a data-quality sanity bound, not a clinical threshold), so it is treated as a likely measurement error.' });
      }
    }
    const expected = ctx.expectedUnits[key];
    if (expected && f.unit !== undefined && normUnit(f.unit) !== normUnit(expected)) {
      flags.push({ type: 'unit_mismatch', severity: 'blocking', findingKeys: [key], detail: `The unit given for this value is not the unit this system expects (${expected}), so the value cannot be compared safely.` });
    }
    if (pos === 'above' || pos === 'below') {
      flags.push({ type: 'out_of_source_range', severity: 'attention', findingKeys: [key], detail: `The value is ${pos} the reference range supplied by the source application.` });
    }
    if (f.sourceFlag === 'normal' && (pos === 'above' || pos === 'below')) {
      flags.push({ type: 'contradiction', severity: 'attention', findingKeys: [key], detail: `The source marks this value normal, but it is ${pos} the reference range the source supplied.` });
    }
    if ((f.sourceFlag === 'high' && (pos === 'within' || pos === 'below')) || (f.sourceFlag === 'low' && (pos === 'within' || pos === 'above'))) {
      flags.push({ type: 'contradiction', severity: 'attention', findingKeys: [key], detail: `The source marks this value ${f.sourceFlag}, which does not match its position (${pos}) against the reference range the source supplied.` });
    }
    if (typeof f.confidence === 'number' && f.confidence < CONFIDENCE_FLOOR) {
      flags.push({ type: 'low_confidence', severity: 'attention', findingKeys: [key], detail: 'The source reports low confidence in this value.' });
    }
  }

  const t = Date.parse(capturedAt);
  if (Number.isNaN(t)) {
    flags.push({ type: 'review_required', severity: 'attention', detail: 'The capture time could not be read.' });
  } else if (t > nowMs + FUTURE_SKEW_MS) {
    flags.push({ type: 'review_required', severity: 'attention', detail: 'The capture time is in the future.' });
  } else if (nowMs - t > STALE_AFTER_DAYS * 86_400_000) {
    flags.push({ type: 'stale_capture', severity: 'attention', detail: `The capture is more than ${STALE_AFTER_DAYS} days old.` });
  }
  return flags;
}
