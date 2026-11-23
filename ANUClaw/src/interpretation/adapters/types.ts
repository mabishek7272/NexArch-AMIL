/** Shared types for tenant adapters (interpretation engine, P3). */
import type { GovernanceContext } from '../governance/types';

export interface RequestFinding {
  key: string; label: string; group?: string; value: number | string | boolean | null; unit?: string;
  uncertainty?: { plusMinus: number } | { interval: [number, number] };
  confidence?: number;
  sourceReference?: { text?: string; lower?: number; upper?: number; lowerInclusive?: boolean; upperInclusive?: boolean; citation?: string };
  sourceFlag?: 'low' | 'normal' | 'high' | 'review' | 'not_applicable';
  underResearch?: boolean; excluded?: { reason: string }; notes?: string;
}

/** A validated interpretation-request/v1 body WITHOUT subject.identity (split off at intake). */
export interface StoredRequest {
  schemaVersion: 'interpretation-request/v1';
  tenantRequestId?: string; skillId: string; analysisType: string;
  subject: { externalRef: string; demographics?: { ageYears?: number; sexAtBirth?: 'female' | 'male' | 'intersex' | 'unknown' } };
  acquisition: { capturedAt: string; method?: string; sessionRef?: string; context?: Record<string, string | number | boolean | null> };
  source: { application: string; applicationVersion?: string; modelName: string; modelVersion: string; calibrationVersion?: string; researchStatus?: string };
  /** Generic input (absent for native-payload skills). */
  findings?: RequestFinding[];
  /** Native input. As SUBMITTED it is `{format, bundle|unsigned}`; after the adapter's `prepare` it is the verified, stripped form the adapter reads. */
  nativePayload?: unknown;
  sourceNarrative?: string; extensions?: Record<string, unknown>;
}

export interface NormalizedFinding {
  findingKey: string; sourceKey: string; label: string; group?: string;
  valueStatus: 'stated' | 'derived' | 'missing'; value: number | string | boolean | null; unit?: string;
  derivation?: { fromKeys: string[]; rule: string };
  uncertainty?: { plusMinus?: number; interval?: [number, number] }; confidence?: number;
  reference?: { origin: 'tenant_supplied'; text?: string; lower?: number; upper?: number; lowerInclusive?: boolean; upperInclusive?: boolean; citation?: string; status?: 'draft' | 'approved'; kind?: 'geometric' | 'literature'; value?: number };
  sourceFlag?: string; underResearch?: boolean; excluded?: { reason: string };
  side?: 'left' | 'right' | 'bilateral'; stepId?: string; signConvention?: string;
  tier?: 'estimate' | 'proxy' | 'entered' | 'annotated' | 'not_measurable';
  sourcePosition?: string; unsupportedReasons?: string[];
}
export interface NormalizedFlag { type: string; severity: 'info' | 'attention' | 'blocking'; findingKeys?: string[]; detail: string; resolvedBy?: string | null }

export interface SourceVerification {
  level: 'signed_bundle_verified' | 'unverified_payload'; origin?: string; digestStatus?: 'recomputed_full_body' | 'upstream_signed_claim_not_recomputable';
  viewSha256?: string; reportId?: string; reportVersion?: number; reportStatus?: 'draft' | 'released' | 'rejected'; supersedesReportId?: string | null; signedAt?: string;
}
export interface NotMeasurable { metricKey: string; label: string; reason: string; whatWouldBeNeeded: string }
export interface SymptomSummary { reportedAt?: string; severity: string; symptoms: string[]; triggeredAction: string }

export interface AdapterOutput {
  findings: NormalizedFinding[]; flags: NormalizedFlag[];
  sourceVerification?: SourceVerification; notMeasurable?: NotMeasurable[]; symptoms?: SymptomSummary[];
}

export interface Adapter {
  id: string; version: string;
  /** Which request form the adapter reads: generic `findings`, or the tenant's `nativePayload`. */
  input: 'findings' | 'native';
  /**
   * Optional, runs at INTAKE (where secrets and the clock are available, so the tenant gets an immediate answer):
   * verifies native input and returns the request to store. `run` must stay pure and deterministic.
   */
  prepare?(req: StoredRequest): StoredRequest;
  run(req: StoredRequest): AdapterOutput;
  /** Source-specific knowledge for the governance stage (risk indicators, sanity bounds, expected units). Omitted = none. */
  governance?: GovernanceContext;
}

/** A problem with the request that no retry can fix: the job fails permanently with this code. */
export class AdapterError extends Error {
  /** `status` and `details` matter only when raised from `prepare` (an intake refusal); `run` errors are job failures. */
  constructor(public readonly code: string, message: string, public readonly status = 422, public readonly details?: unknown) { super(message); }
}
