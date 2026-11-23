/**
 * Position of a value against its reference (interpretation engine, P4a). Deterministic; never changes a value.
 *
 * A position is computed ONLY against a present, numeric, non-draft reference that the source supplied. Anything
 * ambiguous is `indeterminate` rather than guessed: an uncertainty interval whose ends fall in different places, or a
 * value exactly on a bound whose inclusivity the source did not state. A draft or text-only reference yields
 * `no_reference` (a value is never called normal or abnormal against a draft).
 */
import type { NormalizedFinding } from '../adapters/types';
import type { FindingPosition, Position, PositionBasis } from './types';

type Point = 'below' | 'within' | 'above' | 'boundary';

function classify(x: number, ref: NonNullable<NormalizedFinding['reference']>): Point {
  if (ref.lower !== undefined) {
    if (x < ref.lower) return 'below';
    if (x === ref.lower) { if (ref.lowerInclusive === false) return 'below'; if (ref.lowerInclusive === undefined) return 'boundary'; }
  }
  if (ref.upper !== undefined) {
    if (x > ref.upper) return 'above';
    if (x === ref.upper) { if (ref.upperInclusive === false) return 'above'; if (ref.upperInclusive === undefined) return 'boundary'; }
  }
  return 'within';
}

function interval(f: NormalizedFinding, v: number): [number, number] {
  if (f.uncertainty?.interval) return [Math.min(...f.uncertainty.interval), Math.max(...f.uncertainty.interval)];
  if (typeof f.uncertainty?.plusMinus === 'number') return [v - f.uncertainty.plusMinus, v + f.uncertainty.plusMinus];
  return [v, v];
}

export function computePosition(f: NormalizedFinding): FindingPosition {
  const out = (position: Position, basis: PositionBasis): FindingPosition => ({ findingKey: f.findingKey, position, basis });
  if (f.excluded) return out('not_applicable', 'excluded');
  if (f.valueStatus === 'missing' || f.value === null) return out('not_applicable', 'missing_value');
  const ref = f.reference;
  if (!ref) return out('no_reference', 'no_reference');
  if (ref.status === 'draft') return out('no_reference', 'draft_reference');
  if (ref.lower === undefined && ref.upper === undefined) return out('no_reference', 'text_only_reference');
  if (typeof f.value !== 'number' || !Number.isFinite(f.value)) return out('not_applicable', 'non_numeric_value');

  const [lo, hi] = interval(f, f.value);
  const a = classify(lo, ref), b = classify(hi, ref);
  if (a === 'boundary' || b === 'boundary') return out('indeterminate', 'boundary_inclusivity_unstated');
  if (a !== b) return out('indeterminate', 'uncertainty_straddles_bound');
  return out(a, 'numeric_reference');
}
