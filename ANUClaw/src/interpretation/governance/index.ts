/**
 * Deterministic governance (interpretation engine, P4a): positions, flags, referral advisory triggers and review
 * routing, computed from the stored findings alone. It runs BEFORE any model and is independent of it: whatever a model
 * later says cannot change a position, remove a flag or switch off the advisory.
 *
 * Pure: the same findings, context and clock give the same document, so `governanceSha256` (see the report worker) is
 * reproducible. It states no diagnosis, invents no range and never changes a source value.
 */
import { ADVISORY } from '../reports/advisory';
import { computePosition } from './positions';
import { referralFor, routeFor } from './referral';
import { governanceFlags } from './rules';
import { FindingsDoc, GOVERNANCE_RULESET, GovernanceContext, GovernanceDoc } from './types';

export * from './types';
export { computePosition } from './positions';
export { CONFIDENCE_FLOOR, STALE_AFTER_DAYS } from './rules';

export function governFindings(doc: FindingsDoc, ctx: GovernanceContext, nowMs: number): GovernanceDoc {
  const positions = doc.findings.map(computePosition);
  const flags = [...doc.flags, ...governanceFlags(doc.findings, positions, doc.capturedAt, ctx, nowMs)];
  const referral = referralFor(doc.findings, positions, flags, ctx);
  return {
    schemaVersion: 'governance/v1',
    ruleset: { ...GOVERNANCE_RULESET },
    findingsSha256: doc.findingsSha256,
    evaluatedAt: new Date(nowMs).toISOString(),
    positions, flags, referral,
    route: routeFor(flags, referral),
    advisory: referral ? { id: ADVISORY.id, version: ADVISORY.version, status: ADVISORY.status } : null,
  };
}
