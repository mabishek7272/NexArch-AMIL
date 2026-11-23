/**
 * Report assembly (interpretation engine, P4c): turns the stored findings, the governance output and the guarded
 * narratives into the two report layers. Pure and deterministic: the same inputs give byte-identical layers, and both
 * layers are built from the SAME findings document, so they cannot disagree about a value, a position or a flag.
 *
 * What is assembled here is CONTENT. The review banner (AI-reviewed / awaiting clinician / signed) and the tenant's
 * branding are applied when a layer is rendered, because they can change after the content is stored.
 *
 * Nothing in a layer comes from a model except the narrative sections that already passed the guards. The referral
 * advisory, the safety net, the governance statement and every label are fixed text from code.
 */
import type { NormalizedFinding, NormalizedFlag } from '../adapters/types';
import type { FindingsDoc, GovernanceDoc, FindingPosition } from '../governance/types';
import { FLAG_SENTENCE } from '../narrative/deterministic';
import type { Layer, Narrative, NarrativeSection } from '../narrative/types';
import { ADVISORY } from './advisory';

export const REPORT_LAYER_SCHEMA = 'report-layer/v1' as const;

export interface ReportFindingRow {
  key: string; label: string; group?: string; side?: string;
  /** null when the source reported no value, or the finding was excluded. */
  value: number | string | boolean | null; unit?: string; valueStatus: string;
  uncertainty?: string;
  referenceText?: string; referenceDraft?: boolean;
  position: string; positionBasis: string;
  sourceFlag?: string; tier?: string; underResearch?: boolean;
  excludedReason?: string; unsupportedReasons?: string[];
}
export interface ReportFlagRow { type: string; severity: string; findingKeys?: string[]; text: string }
export interface ReportReferral { level: string; reasonCodes: string[]; text: string; safetyNet: string | null; advisory: { id: string; version: string; status: string } }
export interface ReportTraceability {
  reportId: string; version: number; findingsSha256: string; governanceSha256: string; originalPayloadSha256: string;
  application: string; applicationVersion?: string; modelName: string; modelVersion: string; calibrationVersion?: string; researchStatus?: string;
  adapter: { id: string; version: string }; intakeRuleset: { id: string; version: string }; governanceRuleset: { id: string; version: string };
  narrativeMode: string; modelRequested: string | null; modelReturned: string | null; promptVersion: string | null;
  advisory: { id: string; version: string; status: string } | null;
  tenantId: string; jobId: string; verification?: string;
}
export interface ReportLayerDoc {
  schemaVersion: typeof REPORT_LAYER_SCHEMA;
  layer: Layer;
  capturedAt: string;
  findings: ReportFindingRow[];
  sections: NarrativeSection[];
  nextSteps: string[];
  limitations: string;
  referral: ReportReferral | null;
  flags: ReportFlagRow[];
  notMeasurable: Array<{ label: string; reason: string; whatWouldBeNeeded: string }>;
  symptomsReported: boolean;
  traceability: ReportTraceability;
}

export interface AssembleInput {
  doc: FindingsDoc; gov: GovernanceDoc; narratives: Record<Layer, Narrative>;
  /** Flags the narrative stage added (for example review_required). */
  narrativeFlags: NormalizedFlag[];
  governanceSha256: string;
  meta: { reportId: string; version: number; narrativeMode: string; modelRequested: string | null; modelReturned: string | null; promptVersions: Record<Layer, string | null> };
}

const GENERIC_FLAG: [string, string] = ['A data-quality note was raised for some results.', 'A data-quality note was raised for some results.'];
const REASON_WORDS = (r: string) => r.replace(/_/g, ' ');

function uncertaintyText(f: NormalizedFinding): string | undefined {
  const u = f.uncertainty; if (!u) return undefined;
  if (u.plusMinus !== undefined) return `±${u.plusMinus}${f.unit ? ` ${f.unit}` : ''}`;
  if (u.interval) return `${u.interval[0]} to ${u.interval[1]}${f.unit ? ` ${f.unit}` : ''}`;
  return undefined;
}

function referenceText(f: NormalizedFinding): string | undefined {
  const r = f.reference; if (!r) return undefined;
  if (r.text) return r.text;
  const u = f.unit ? ` ${f.unit}` : '';
  if (r.lower !== undefined && r.upper !== undefined) return `${r.lower} to ${r.upper}${u}`;
  if (r.lower !== undefined) return `above ${r.lower}${u}`;
  if (r.upper !== undefined) return `below ${r.upper}${u}`;
  if (r.value !== undefined) return `${r.value}${u}`;
  return undefined;
}

function findingRow(f: NormalizedFinding, pos: FindingPosition | undefined): ReportFindingRow {
  const excluded = f.excluded !== undefined;
  const row: ReportFindingRow = {
    key: f.findingKey, label: f.label, value: excluded ? null : f.value, valueStatus: excluded ? 'excluded' : f.valueStatus,
    position: pos?.position ?? 'not_applicable', positionBasis: pos?.basis ?? (excluded ? 'excluded' : 'no_reference'),
  };
  if (f.group) row.group = f.group;
  if (f.side) row.side = f.side;
  if (f.unit) row.unit = f.unit;
  if (!excluded) {
    const u = uncertaintyText(f); if (u) row.uncertainty = u;
    const ref = referenceText(f); if (ref) row.referenceText = ref;
    if (f.reference?.status === 'draft') row.referenceDraft = true;
    if (f.sourceFlag) row.sourceFlag = f.sourceFlag;
    if (f.tier) row.tier = f.tier;
    if (f.underResearch) row.underResearch = true;
    if (f.unsupportedReasons?.length) row.unsupportedReasons = f.unsupportedReasons.map(REASON_WORDS);
  } else row.excludedReason = f.excluded!.reason;
  return row;
}

/** One line per flag. Clinical keeps the flag's own detail; Layman gets the fixed plain sentence only. */
function flagRows(layer: Layer, flags: NormalizedFlag[]): ReportFlagRow[] {
  return flags.map((fl) => {
    const [clin, lay] = FLAG_SENTENCE[fl.type] ?? GENERIC_FLAG;
    const text = layer === 'clinical' ? (fl.detail ? `${clin} [${fl.detail}]` : clin) : lay;
    return { type: fl.type, severity: fl.severity, ...(fl.findingKeys?.length ? { findingKeys: fl.findingKeys } : {}), text };
  });
}

export function assembleLayers(a: AssembleInput): Record<Layer, ReportLayerDoc> {
  const { doc, gov } = a;
  const posByKey = new Map(gov.positions.map((p) => [p.findingKey, p]));
  const rows = doc.findings.map((f) => findingRow(f, posByKey.get(f.findingKey)));
  const sm = doc.provenance.sourceModel;
  const symptomsReported = (doc.symptoms?.length ?? 0) > 0;
  const allFlags = [...gov.flags, ...a.narrativeFlags];

  const build = (layer: Layer): ReportLayerDoc => {
    const n = a.narratives[layer];
    const referral: ReportReferral | null = gov.referral
      ? {
        level: gov.referral.level, reasonCodes: [...new Set(gov.referral.reasons.map((r) => r.code))],
        text: layer === 'clinical' ? ADVISORY.clinical : ADVISORY.layman,
        // The symptom safety-net is part of the lay advisory; the clinical layer states the finding-level advice only.
        safetyNet: layer === 'layman' ? ADVISORY.safetyNet : null,
        advisory: { id: ADVISORY.id, version: ADVISORY.version, status: ADVISORY.status },
      }
      : null;
    return {
      schemaVersion: REPORT_LAYER_SCHEMA, layer, capturedAt: doc.capturedAt,
      findings: rows,
      sections: n.sections, nextSteps: n.nextSteps, limitations: n.limitations,
      referral, flags: flagRows(layer, allFlags),
      notMeasurable: (doc.notMeasurable ?? []).map((m) => ({ label: m.label, reason: m.reason, whatWouldBeNeeded: m.whatWouldBeNeeded })),
      symptomsReported,
      traceability: {
        reportId: a.meta.reportId, version: a.meta.version, findingsSha256: doc.findingsSha256, governanceSha256: a.governanceSha256,
        originalPayloadSha256: doc.provenance.originalPayloadSha256,
        application: sm.application ?? 'unknown', ...(sm.applicationVersion ? { applicationVersion: sm.applicationVersion } : {}),
        modelName: sm.modelName ?? 'unknown', modelVersion: sm.modelVersion ?? 'unknown',
        ...(sm.calibrationVersion ? { calibrationVersion: sm.calibrationVersion } : {}), ...(sm.researchStatus ? { researchStatus: sm.researchStatus } : {}),
        adapter: doc.provenance.adapter, intakeRuleset: doc.provenance.ruleset, governanceRuleset: gov.ruleset,
        narrativeMode: a.meta.narrativeMode, modelRequested: a.meta.modelRequested, modelReturned: a.meta.modelReturned, promptVersion: a.meta.promptVersions[layer],
        advisory: gov.referral ? { id: ADVISORY.id, version: ADVISORY.version, status: ADVISORY.status } : null,
        tenantId: doc.tenantId, jobId: doc.jobId,
        ...(doc.sourceVerification ? { verification: doc.sourceVerification.level } : {}),
      },
    };
  };
  return { clinical: build('clinical'), layman: build('layman') };
}
