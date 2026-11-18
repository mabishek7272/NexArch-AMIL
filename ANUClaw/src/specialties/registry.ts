/**
 * Specialty module registry (plan §9). Every department is listed with what REAL code
 * exists, its release state and the external requirements still open. There is no
 * "complete" or "approved" state in this build: clinical approval needs named humans
 * and evidence the software cannot produce. `validateRegistry` enforces that invariant
 * (and is tested), so an entry cannot quietly claim more than the table below allows.
 */
export type ReleaseState =
  | 'research_only'     // real executable research capability; outputs unvalidated, clinical claims prohibited
  | 'framework_only'    // generic engineering framework exists; no department-specific approved content
  | 'gated'             // capability exists but is blocked from clinical/operational use pending validation
  | 'unavailable';      // nothing implemented

export interface SpecialtyModule {
  id: string;
  department: string;
  intendedUse: string;
  /** Real, tested code that serves this department today (empty = none). */
  implemented: string[];
  releaseState: ReleaseState;
  /** Clinical/department approval is never granted by this build. */
  approval: { status: 'not_approved'; requiredFrom: string };
  /** Released, source-cited, clinician-approved rules for this department. Always 0 here. */
  releasedRules: 0;
  externalRequirements: string[];
  /** What the department's output may NOT be used to claim (from plan §9). */
  prohibitedClaims: string[];
}

const NO_APPROVAL = (who: string) => ({ status: 'not_approved' as const, requiredFrom: who });
const DOC = 'document workflow (extraction → confirmation → snapshot → rules → report) via /api/clinical and /v1';

export const SPECIALTIES: SpecialtyModule[] = [
  {
    id: 'orthopedics_rehab', department: 'Orthopedics and rehabilitation',
    intendedUse: 'Summarise supplied imaging reports, symptoms, function and longitudinal movement measurements.',
    implemented: [DOC, 'PosturePulse measurement import (verified provenance only)'], releaseState: 'framework_only',
    approval: NO_APPROVAL('named orthopedic/rehabilitation clinical lead'), releasedRules: 0,
    externalRequirements: ['approved summarisation scope and reviewer', 'validated motion-measurement adapters and study', 'licensed outcome instruments where used'],
    prohibitedClaims: ['image-diagnosis capability', 'diagnosis from camera measurements'],
  },
  {
    id: 'ergonomics', department: 'Ergonomics',
    intendedUse: 'Assess documented task exposure and propose reviewed workplace adjustments.',
    implemented: [], releaseState: 'unavailable',
    approval: NO_APPROVAL('occupational-health/ergonomics lead'), releasedRules: 0,
    externalRequirements: ['approved, licensed method (e.g. RULA/REBA) with required inputs', 'task force/load/repetition/duration data', 'measurement study'],
    prohibitedClaims: ['a complete ergonomic assessment', 'exposure inferred from a still image'],
  },
  {
    id: 'posture_movement', department: 'Posture and movement',
    intendedUse: 'Import quality-controlled angles/proxies, uncertainty, capture conditions and repeat-session changes.',
    implemented: ['PosturePulse import with trusted-upstream/signed-bundle provenance, consent and quality preservation'], releaseState: 'framework_only',
    approval: NO_APPROVAL('measurement/biomechanics lead and clinician investigator'), releasedRules: 0,
    externalRequirements: ['agreement/repeatability study vs a reference', 'approved reference ranges for the exact construct', 'live test against the real PosturePulse backend'],
    prohibitedClaims: ['normality or disease claims', 'treating camera proxies as bony-landmark measurements', 'clinically meaningful change from measurement change alone'],
  },
  {
    id: 'immunology', department: 'Immunology',
    intendedUse: 'Explain supplied immunology panels and organise longitudinal assay results.',
    implemented: [DOC], releaseState: 'framework_only', approval: NO_APPROVAL('immunology specialty reviewer'), releasedRules: 0,
    externalRequirements: ['assay-specific interpretation rules with sources', 'specialty review and sign-off'],
    prohibitedClaims: ['autoimmune or immune-deficiency diagnosis from an isolated marker'],
  },
  {
    id: 'haematology_pathology', department: 'Haematology and clinical pathology',
    intendedUse: 'Structure CBC, chemistry and coagulation panels; highlight reviewed patterns and changes.',
    implemented: [DOC, 'comparison with the laboratory-printed reference interval (report-presentation rule only)'], releaseState: 'framework_only',
    approval: NO_APPROVAL('haematology/pathology lead'), releasedRules: 0,
    externalRequirements: ['approved pattern rules with sources', 'analyzer/method context handling', 'validated imaging modules for smear/histology (none exist)'],
    prohibitedClaims: ['smear, histology or image interpretation'],
  },
  {
    id: 'virology_molecular', department: 'Virology and molecular diagnostics',
    intendedUse: 'Explain existing PCR/antigen/antibody and other assay reports in context.',
    implemented: [DOC], releaseState: 'framework_only', approval: NO_APPROVAL('virology/molecular diagnostics lead'), releasedRules: 0,
    externalRequirements: ['assay-specific context (specimen, dates, control status)', 'sourced interpretation rules'],
    prohibitedClaims: ['Ct interpreted as a universal viral load or infectiousness measure across assays'],
  },
  {
    id: 'internal_medicine_id', department: 'Internal medicine and infectious diseases',
    intendedUse: 'Build a chronological problem/evidence summary and clinician-review questions.',
    implemented: [DOC], releaseState: 'framework_only', approval: NO_APPROVAL('internal medicine lead'), releasedRules: 0,
    externalRequirements: ['approved local clinical workflow', 'comprehensive authorised case snapshot sources'],
    prohibitedClaims: ['treatment recommendations without an approved local clinical workflow'],
  },
  {
    id: 'biostatistics', department: 'Biostatistics and clinical research',
    intendedUse: 'Execute reproducible descriptive analysis and approved study analyses.',
    implemented: ['research workspace: descriptive, Welch comparison, proportions (Wilson/risk ratio), seeded bootstraps — verified against scipy; re-run reproducibility; small-cell suppression'],
    releaseState: 'research_only', approval: NO_APPROVAL('biostatistician and domain research lead'), releasedRules: 0,
    externalRequirements: ['protocol and analysis plan per study', 'governed datasets and approvals', 'ethics/regulatory review where applicable'],
    prohibitedClaims: ['fabricated significance, datasets or completed studies', 'causal or clinical conclusions'],
  },
  {
    id: 'epidemiology', department: 'Epidemiology',
    intendedUse: 'Produce authorised cohort trends, rates and surveillance summaries.',
    implemented: ['research workspace: proportions and incidence rate ratios with small-cell suppression'], releaseState: 'research_only',
    approval: NO_APPROVAL('epidemiology lead'), releasedRules: 0,
    externalRequirements: ['case definitions and valid denominators', 'period/location and reporting-delay metadata', 'representativeness assessment', 'age/sex standardisation (not implemented)'],
    prohibitedClaims: ['individual diagnoses from population associations', 'causality'],
  },
  {
    id: 'clinical_pharmacology', department: 'Clinical pharmacology',
    intendedUse: 'Reconcile supplied medicines and explain sourced interaction, renal/hepatic, allergy and PGx considerations.',
    implemented: ['CDS pharmacogenomics engine (SEED content: not clinically validated; disabled for clinical use)'], releaseState: 'gated',
    approval: NO_APPROVAL('clinical pharmacist/pharmacologist'), releasedRules: 0,
    externalRequirements: ['licensed, versioned interaction/PGx knowledge sources', 'validated rules and specialist review', 'verified medication lists'],
    prohibitedClaims: ['prescribing or dose-change advice', 'use of seed PGx content for clinical decisions'],
  },
  {
    id: 'drug_discovery', department: 'Drug discovery',
    intendedUse: 'Run approved computational research and summarise reproducible results.',
    implemented: ['research workspace: RDKit-backed STANDARD descriptors (version and function names recorded) and drug-likeness under two named conventions; the built-in approximation uses differently-named simple counts, is shown with its differences, and is never substituted for H-bond counts or drug-likeness'], releaseState: 'research_only',
    approval: NO_APPROVAL('computational chemistry lead'), releasedRules: 0,
    externalRequirements: ['container runtime for docking (Docker Desktop needs macOS privileged-helper approval)', 'validated structures/targets and dataset provenance', 'approved docking/ADMET/PK-PD tools', 'independent validation'],
    prohibitedClaims: ['computational rankings as efficacy, safety or binding evidence'],
  },
  {
    id: 'emergency_medicine', department: 'Emergency medicine',
    intendedUse: 'Create timely handover summaries and support locally approved escalation protocols.',
    implemented: ['alert workflow state machine (acknowledge / escalate-on-deadline / close) — SIMULATION ONLY; enforced by a database constraint; real alerting and escalation are disabled'], releaseState: 'gated', approval: NO_APPROVAL('emergency medicine lead and clinical safety officer'), releasedRules: 0,
    externalRequirements: ['approved escalation protocol', 'measured alert latency/availability', 'accountable recipients and acknowledgment workflow', 'drills and downtime procedure', 'intended-use and regulatory review'],
    prohibitedClaims: ['emergency alerting or escalation (disabled)'],
  },
  {
    id: 'physiological_monitoring', department: 'Physiological monitoring',
    intendedUse: 'Ingest authorised device observations; show trends, quality, gaps and approved alerts.',
    implemented: ['monitoring ingestion with freshness/gap/duplicate/out-of-order/clock handling, FHIR Observation adapter (tested unit conversion), labelled simulator; silence never shown as a normal value; no real hardware adapter'], releaseState: 'gated',
    approval: NO_APPROVAL('clinical service owner for the monitored population'), releasedRules: 0,
    externalRequirements: ['real device adapters validated on hardware', 'measured end-to-end reliability', 'patient pairing procedure', 'approved alert rules and recipients'],
    prohibitedClaims: ['continuous-monitoring claims without measured reliability', 'silence or lost connection shown as a normal value', 'alerts from simulated data'],
  },
  {
    id: 'ai_prediction', department: 'AI prediction',
    intendedUse: 'Estimate a predefined outcome over a defined horizon for an eligible population.',
    implemented: ['research workspace: evaluation of SUPPLIED scores (AUC + seeded bootstrap CI, Brier, calibration, leakage check)'], releaseState: 'gated',
    approval: NO_APPROVAL('biostatistician and clinical domain lead'), releasedRules: 0,
    externalRequirements: ['protocol: decision supported, outcome, horizon, population, comparator', 'versioned datasets and locked independent evaluation set', 'external and prospective evaluation', 'subgroup, utility and workflow evidence'],
    prohibitedClaims: ['any clinical risk score; a model confidence field is not a validated risk score'],
  },
  {
    id: 'biomarker_discovery', department: 'Biomarker discovery',
    intendedUse: 'Explore reproducible candidate associations and replication plans.',
    implemented: ['research workspace: exploratory per-feature Welch tests with Benjamini–Hochberg control'], releaseState: 'gated',
    approval: NO_APPROVAL('biostatistician and assay/domain lead'), releasedRules: 0,
    externalRequirements: ['assay QC and batch handling', 'cohort metadata and confounder control', 'independent replication dataset', 'analytical and clinical validation'],
    prohibitedClaims: ['discoveries from an unreplicated correlation', 'clinical use of candidate markers'],
  },
  {
    id: 'synthetic_biology', department: 'Synthetic biology and broader life science',
    intendedUse: 'Organise literature, approved design records, provenance and reproducible computational research.',
    implemented: ['research workspace datasets/runs with provenance (generic)'], releaseState: 'framework_only',
    approval: NO_APPROVAL('project-specific scientific lead'), releasedRules: 0,
    externalRequirements: ['project-specific scope definition', 'domain tools and expert review'],
    prohibitedClaims: ['automatic transition from a model proposal to a clinical or experimental claim'],
  },
];

/** Invariants that keep the registry honest. Returns violations (empty = valid). */
export function validateRegistry(list: SpecialtyModule[] = SPECIALTIES): string[] {
  const v: string[] = [];
  const ids = new Set<string>();
  for (const m of list) {
    if (ids.has(m.id)) v.push(`${m.id}: duplicate id`);
    ids.add(m.id);
    if (m.approval.status !== 'not_approved') v.push(`${m.id}: approval status must be not_approved in this build`);
    if (m.releasedRules !== 0) v.push(`${m.id}: no clinical rules may be marked released`);
    if (!m.externalRequirements.length) v.push(`${m.id}: external requirements must be listed`);
    if (!m.prohibitedClaims.length) v.push(`${m.id}: prohibited claims must be listed`);
    if (m.releaseState === 'unavailable' && m.implemented.length) v.push(`${m.id}: unavailable but lists implementations`);
    if (m.releaseState !== 'unavailable' && !m.implemented.length) v.push(`${m.id}: ${m.releaseState} requires at least one real implementation`);
    if (!['research_only', 'framework_only', 'gated', 'unavailable'].includes(m.releaseState)) v.push(`${m.id}: invalid release state`);
  }
  return v;
}
