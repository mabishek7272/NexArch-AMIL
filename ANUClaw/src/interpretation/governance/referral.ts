/**
 * Referral advisory triggers and review routing (interpretation engine, P4a). No model is involved.
 *
 * Triggers (any one is enough):
 *  (a) a risk-category indicator is flagged high or review by the source;
 *  (b) a high-risk finding sits outside the reference the source supplied;
 *  (c) any blocking flag;
 *  (d) two or more attention flags on high-risk indicators;
 *  (e) an under-research estimate that the source itself flags high.
 * The output names the static advisory text by id and version; the wording itself lives in reports/advisory.ts. There
 * is no numeric "urgent" level: that would need a released threshold.
 */
import type { NormalizedFinding, NormalizedFlag } from '../adapters/types';
import { ADVISORY_ID, ADVISORY_VERSION } from '../reports/advisory';
import type { FindingPosition, GovernanceContext, Referral, ReferralReason, Route } from './types';

export function referralFor(findings: NormalizedFinding[], positions: FindingPosition[], flags: NormalizedFlag[], ctx: GovernanceContext): Referral | null {
  const reasons: ReferralReason[] = [];
  const live = findings.filter((f) => !f.excluded);
  const posOf = new Map(positions.map((p) => [p.findingKey, p.position]));
  const risk = new Set(ctx.riskIndicatorKeys), high = new Set(ctx.highRiskKeys);

  const a = live.filter((f) => risk.has(f.findingKey) && (f.sourceFlag === 'high' || f.sourceFlag === 'review')).map((f) => f.findingKey);
  if (a.length) reasons.push({ code: 'risk_indicator_flagged', findingKeys: a });

  const b = live.filter((f) => high.has(f.findingKey) && (posOf.get(f.findingKey) === 'above' || posOf.get(f.findingKey) === 'below')).map((f) => f.findingKey);
  if (b.length) reasons.push({ code: 'high_risk_outside_reference', findingKeys: b });

  if (flags.some((f) => f.severity === 'blocking')) reasons.push({ code: 'blocking_flag' });

  const watched = new Set([...risk, ...high]);
  const attentionOnRisk = flags.filter((f) => f.severity === 'attention' && f.findingKeys?.some((k) => watched.has(k)));
  if (attentionOnRisk.length >= 2) reasons.push({ code: 'multiple_attention_on_high_risk', findingKeys: [...new Set(attentionOnRisk.flatMap((f) => f.findingKeys ?? []).filter((k) => watched.has(k)))] });

  const e = live.filter((f) => f.underResearch === true && f.sourceFlag === 'high').map((f) => f.findingKey);
  if (e.length) reasons.push({ code: 'under_research_high', findingKeys: e });

  return reasons.length ? { level: 'see_clinician_soon', reasons, textId: ADVISORY_ID, textVersion: ADVISORY_VERSION } : null;
}

/** Blocking data-quality flags hold the report for a clinician; everything else may proceed to the automatic AI review. */
export function routeFor(flags: NormalizedFlag[], referral: Referral | null): Route {
  const blocking = [...new Set(flags.filter((f) => f.severity === 'blocking').map((f) => f.type))];
  return {
    state: blocking.length ? 'awaiting_clinician' : 'eligible_for_ai_review',
    reasons: blocking,
    followUp: referral !== null || flags.some((f) => f.severity === 'attention'),
  };
}
