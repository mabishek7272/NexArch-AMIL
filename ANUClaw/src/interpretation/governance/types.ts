/** Types for the deterministic governance stage (interpretation engine, P4a). */
import type { NormalizedFinding, NormalizedFlag, SourceVerification, NotMeasurable, SymptomSummary } from '../adapters/types';

export const GOVERNANCE_RULESET = { id: 'governance-ruleset', version: '1.0.0' } as const;

export type Position = 'below' | 'within' | 'above' | 'indeterminate' | 'no_reference' | 'not_applicable';
export type PositionBasis =
  | 'numeric_reference' | 'uncertainty_straddles_bound' | 'boundary_inclusivity_unstated'
  | 'draft_reference' | 'text_only_reference' | 'no_reference' | 'non_numeric_value' | 'missing_value' | 'excluded';

export interface FindingPosition { findingKey: string; position: Position; basis: PositionBasis }

export type ReferralReasonCode = 'risk_indicator_flagged' | 'high_risk_outside_reference' | 'blocking_flag' | 'multiple_attention_on_high_risk' | 'under_research_high';
export interface ReferralReason { code: ReferralReasonCode; findingKeys?: string[] }
export interface Referral { level: 'see_clinician_soon'; reasons: ReferralReason[]; textId: string; textVersion: string }

export type RouteState = 'awaiting_clinician' | 'eligible_for_ai_review';
export interface Route { state: RouteState; reasons: string[]; /** a non-blocking item for the clinician queue */ followUp: boolean }

/** The normalized-findings/v1 document as stored (see contracts/normalized-findings.v1.schema.json). */
export interface FindingsDoc {
  schemaVersion: 'normalized-findings/v1'; jobId: string; tenantId: string; skillId: string; subjectRef: string; capturedAt: string;
  findings: NormalizedFinding[]; flags: NormalizedFlag[];
  provenance: { adapter: { id: string; version: string }; sourceModel: Record<string, string>; ruleset: { id: string; version: string }; originalPayloadSha256: string };
  findingsSha256: string;
  sourceVerification?: SourceVerification; notMeasurable?: NotMeasurable[]; symptoms?: SymptomSummary[];
}

/** Source-specific knowledge an adapter declares; versioned with the adapter. None of it is a clinical threshold. */
export interface GovernanceContext {
  /** Risk-CATEGORY indicators (e.g. "High blood pressure risk"): the source flagging one high/review triggers the advisory. */
  riskIndicatorKeys: string[];
  /** Numeric findings for which being outside the source's own reference triggers the advisory. A draft list pending clinician approval. */
  highRiskKeys: string[];
  /** Sanity bounds: values outside are treated as measurement errors (data quality), NOT as clinical limits. */
  plausibleRanges: Record<string, [number, number]>;
  /** Expected unit per finding key; a different stated unit is a data-quality problem. */
  expectedUnits: Record<string, string>;
}
export const EMPTY_CONTEXT: GovernanceContext = { riskIndicatorKeys: [], highRiskKeys: [], plausibleRanges: {}, expectedUnits: {} };

export interface GovernanceDoc {
  schemaVersion: 'governance/v1';
  ruleset: { id: string; version: string };
  findingsSha256: string;
  evaluatedAt: string;
  positions: FindingPosition[];
  /** The adapter's flags followed by the flags governance added. */
  flags: NormalizedFlag[];
  referral: Referral | null;
  route: Route;
  advisory: { id: string; version: string; status: string } | null;
}
