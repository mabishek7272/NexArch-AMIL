/**
 * ANUClaw Research Studio — shared types (M1 foundation).
 *
 * Scope of THIS milestone: durable project + task-graph state, one real deterministic agent (Research Planner), and the
 * mechanisms the rest of the system will reuse (claim/commit, retry/backoff, pause/resume/cancel, stale-task recovery,
 * downstream invalidation, budgets). No literature search, browser automation, writing or export agent exists yet — see
 * docs/RESEARCH-STUDIO-PLAN.md for what is implemented versus planned.
 */

export const PROJECT_MODES = [
  'narrative_review', 'systematic_review', 'scoping_review', 'original_research', 'research_protocol', 'case_report', 'dissertation',
] as const;
export type ProjectMode = typeof PROJECT_MODES[number];

export const PROJECT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];

/**
 * The research brief (plan §1). Nothing here is invented by the system: every field is supplied by the researcher.
 * Mode-specific requirements are enforced in project-service.ts (e.g. original_research needs `hasData`;
 * systematic/scoping/narrative review need a stated search method; case_report needs a data-permissions attestation).
 */
export interface ResearchBrief {
  topic: string; question: string; hypothesis?: string; initialAbstract?: string;
  field?: string; audience?: string; population?: string; scope?: string;
  inclusionCriteria?: string; exclusionCriteria?: string;
  dateRestriction?: string; languageRestriction?: string; sourceRestriction?: string;
  targetJournal?: string; targetUniversity?: string; guidelineUrls?: string[];
  wordLimits?: { overall?: number; bySection?: Record<string, number> };
  pageTarget?: { pages?: number; layout?: string };
  referenceTarget?: number; referenceHardMax?: number;
  visualTypes?: string[];
  /** Original-research mode: whether the researcher has actual data/results to draft from. A missing/false value blocks results-drafting tasks (never fabricated). */
  hasData?: boolean; dataResearchRunId?: string;
  /** Review modes: the ACTUAL search/screening method — required for narrative/systematic/scoping review and for a "systematic review" label (plan §6). */
  searchMethod?: string; screeningMethod?: string; searchStrategy?: { databases: string[]; queries: string[] };
  /** Case-report mode: data-permissions attestation (mirrors src/research/service.ts's attestation pattern). */
  dataPermissions?: { authorized: boolean; statement: string };
  /** Dissertation mode. */
  institution?: string; chapterOutline?: string[];
  allowedBrowserProviders?: string[]; allowedSourceDomains?: string[];
  maxRuntimeMinutes?: number; maxActions?: number; maxDownloads?: number; maxRevisionRounds?: number;
}

export interface ProjectRow {
  id: string; owner_id: string; mode: ProjectMode; title: string; status: ProjectStatus;
  brief_json: string; brief_sha256: string; created_at: number; updated_at: number;
}

export const TASK_STATES = ['queued', 'running', 'awaiting_user', 'paused', 'retryable_failure', 'failed', 'cancelled', 'completed'] as const;
export type TaskState = typeof TASK_STATES[number];
/** Terminal states: no further transition is possible (cancel included — cancellation is final, not resumable). */
export const TERMINAL_STATES: TaskState[] = ['failed', 'cancelled', 'completed'];

export interface TaskRow {
  id: string; project_id: string; type: string; status: TaskState;
  depends_on_json: string; params_json: string; result_json: string | null; result_sha256: string | null;
  attempts: number; max_attempts: number; next_eligible_at: number | null;
  claimed_at: number | null; claim_token: string | null;
  invalidated_at: number | null; invalidated_reason: string | null;
  budget_json: string; usage_json: string;
  revision_group: string | null; max_revisions_in_group: number | null;
  created_at: number; updated_at: number;
}

export interface TaskEventRow { id: string; project_id: string; task_id: string; seq: number; event: string; detail_json: string; at: number; prev_hash: string; hash: string }

/** What a registered agent handler returns. The orchestrator never invents a 'completed' outcome on its own. */
export type HandlerOutcome =
  | { kind: 'completed'; result: unknown; childTasks?: NewTaskSpec[] }
  | { kind: 'retryable_failure'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'awaiting_user'; reason: string };

export interface NewTaskSpec {
  type: string; dependsOn?: string[]; params?: unknown; maxAttempts?: number; budget?: { maxActions?: number; maxTokens?: number };
  revisionGroup?: string; maxRevisionsInGroup?: number;
}

/** `token` is the task's current claim token (M2): an agent that performs bounded external work (a connector call, a
 * model call) calls `recordUsage(task, token, delta)` per unit of work so the existing per-task budget (plan §2) is
 * actually enforced, not merely descriptive. M1's researchPlannerAgent does no external work and ignores it. */
export interface AgentContext { project: ProjectRow; task: TaskRow; token: string }
export type AgentHandler = (ctx: AgentContext) => Promise<HandlerOutcome>;

/**
 * Evidence graph (M2, plan §5): questions → search runs → sources → excerpts → claims → sections. Every status below is
 * deliberately separate from the others — resolving a DOI is NOT the same as verifying metadata, having full text is NOT
 * the same as a claim being supported, and "a check was never run" (unknown) is never collapsed into "passed".
 */
export const METADATA_VERIFICATION_STATUSES = ['unknown', 'unverified', 'verified', 'mismatch'] as const;
export type MetadataVerificationStatus = typeof METADATA_VERIFICATION_STATUSES[number];
export const FULLTEXT_STATUSES = ['unknown', 'unavailable', 'abstract_only', 'full_text'] as const;
export type FulltextStatus = typeof FULLTEXT_STATUSES[number];
export const CORRECTION_STATUSES = ['unknown', 'none', 'corrected', 'retracted'] as const;
export type CorrectionStatus = typeof CORRECTION_STATUSES[number];
export const CLAIM_SUPPORT_STATUSES = ['unknown', 'unresolved', 'supported', 'contradicted'] as const;
export type ClaimSupportStatus = typeof CLAIM_SUPPORT_STATUSES[number];
export const EVIDENCE_RELATIONS = ['supports', 'contradicts', 'unclear'] as const;
export type EvidenceRelation = typeof EVIDENCE_RELATIONS[number];
export const SOURCE_LINK_RELATIONS = ['duplicate', 'preprint_of', 'correction_of', 'same_version', 'unrelated'] as const;
export type SourceLinkRelation = typeof SOURCE_LINK_RELATIONS[number];
export const SOURCE_LINK_STATUSES = ['proposed', 'confirmed', 'rejected'] as const;
export type SourceLinkStatus = typeof SOURCE_LINK_STATUSES[number];
export const SCREENING_DECISIONS = ['pending', 'include', 'exclude'] as const;
export type ScreeningDecisionValue = typeof SCREENING_DECISIONS[number];
export const EXTRACTED_BY = ['human', 'deterministic', 'model'] as const;
export type ExtractedBy = typeof EXTRACTED_BY[number];

export interface SearchStrategyRow { id: string; project_id: string; version: number; databases_json: string; queries_json: string; filters_json: string; created_by: string; created_at: number }

export interface SearchRunRow {
  id: string; project_id: string; strategy_id: string | null; task_id: string | null;
  source: string; query_json: string; filters_json: string; page: number;
  status: 'running' | 'completed' | 'failed' | 'partial';
  result_count: number; error: string | null; started_at: number; completed_at: number | null;
}

export interface SourceRow {
  id: string; project_id: string;
  doi: string | null; pmid: string | null; url: string | null; normalized_id: string;
  title: string; authors_json: string; year: number | null; venue: string | null; source_type: string;
  content_hash: string | null;
  metadata_json: string;
  metadata_verification_status: MetadataVerificationStatus;
  fulltext_status: FulltextStatus;
  correction_status: CorrectionStatus;
  import_provenance_json: string;
  created_at: number; updated_at: number;
}

export interface SourceVersionRow { id: string; source_id: string; version: number; metadata_json: string; content_hash: string | null; retrieved_at: number; retrieval_metadata_json: string }
export interface SourceLinkRow { id: string; project_id: string; source_id_a: string; source_id_b: string; relation: SourceLinkRelation; status: SourceLinkStatus; decided_by: string | null; decided_at: number | null; created_at: number }
export interface ArtifactRow { id: string; project_id: string; source_id: string; kind: 'pdf' | 'text'; storage_path: string; sha256: string; size_bytes: number; created_at: number }
export interface ExcerptRow { id: string; project_id: string; source_id: string; task_id: string | null; locator_json: string; text: string; sha256: string; extracted_by: ExtractedBy; created_by: string; invalidated_at: number | null; invalidated_reason: string | null; created_at: number }
export interface ClaimRow { id: string; project_id: string; statement: string; created_by: string; created_at: number }
export interface ClaimEvidenceLinkRow { id: string; project_id: string; claim_id: string; excerpt_id: string; relation: EvidenceRelation; claim_support_status: ClaimSupportStatus; created_by: string; created_at: number }
export interface ScreeningDecisionRow { id: string; project_id: string; source_id: string; decision: ScreeningDecisionValue; exclusion_reason: string | null; decided_by: string; decided_at: number }
export interface EvidenceMatrixRow { id: string; project_id: string; task_id: string; matrix_json: string; built_at: number }

/**
 * Manuscript/thesis authoring (M4, plan §3-4). A "section" is append-only by construction: every draft, revision, or
 * editorial proposal is a NEW row, never an edit in place — `status` is the only field that ever transitions
 * (proposed → accepted/rejected), so the full history is always reconstructable. `content_source` and
 * `model_provenance_json` record who/what produced the text; 'model' is a reserved value for a future
 * model/browser-backed writer — none exists yet, so it is never actually used by a registered M4 agent.
 */
export const SECTION_KINDS = ['outline', 'section', 'chapter'] as const;
export type SectionKind = typeof SECTION_KINDS[number];
export const SECTION_CONTENT_SOURCES = ['human', 'deterministic_digest', 'editorial_proposal', 'model'] as const;
export type SectionContentSource = typeof SECTION_CONTENT_SOURCES[number];
export const SECTION_STATUSES = ['accepted', 'proposed', 'rejected'] as const;
export type SectionStatus = typeof SECTION_STATUSES[number];

export interface SectionRow {
  id: string; project_id: string; task_id: string | null; section_key: string; version: number;
  kind: SectionKind; title: string; content_text: string; content_source: SectionContentSource; model_provenance_json: string;
  status: SectionStatus; parent_version_id: string | null;
  invalidated_at: number | null; invalidated_reason: string | null;
  created_by: string; created_at: number; ordinal?: number;
}
export interface SectionCommentRow { id: string; project_id: string; section_id: string; body: string; created_by: string; created_at: number }
export interface AuthorDecisionRow { id: string; project_id: string; section_id: string; decision: 'accepted' | 'rejected'; reason: string | null; decided_by: string; decided_at: number }
export interface SectionClaimLinkRow { id: string; project_id: string; section_id: string; claim_id: string; created_at: number }

export const CITATION_AUDIT_STATUSES = ['unknown', 'clean', 'issues_found'] as const;
export type CitationAuditStatus = typeof CITATION_AUDIT_STATUSES[number];
export interface CitationAuditRow { id: string; project_id: string; section_id: string; task_id: string; findings_json: string; overall_status: CitationAuditStatus; created_at: number }

export interface GuidelineRow { id: string; project_id: string; version: number; journal_or_university: string; constraints_json: string; checklist_json: string; created_by: string; created_at: number }
export interface ComplianceReportRow { id: string; project_id: string; task_id: string; report_json: string; built_at: number }

/**
 * Visuals (M5, plan §5/§8). `kind: 'data_derived'` MUST reference an immutable, hash-verified `research_runs` row
 * (`src/research/service.ts`) and an exact output field — never a hand-typed number. `kind: 'conceptual'` carries
 * no numeric claim sourced as if real; `spec_json` is pure layout/labels, and `renderConceptual` refuses a spec
 * containing anything that looks like a measured quantity (see visual-service.ts). Every visual is rendered by a
 * small, fixed, auditable renderer (`renderer` names a function in a closed registry) — never arbitrary/`eval`'d
 * code — producing a real, deterministic SVG stored alongside the spec.
 */
export const VISUAL_KINDS = ['data_derived', 'conceptual'] as const;
export type VisualKind = typeof VISUAL_KINDS[number];
export const VISUAL_TYPES = ['flowchart', 'evidence_map', 'conceptual_diagram', 'prisma_flow', 'table', 'data_plot', 'graphical_abstract'] as const;
export type VisualType = typeof VISUAL_TYPES[number];
export interface VisualSpecRow {
  id: string; project_id: string; task_id: string | null; visual_key: string; version: number;
  type: VisualType; kind: VisualKind; title: string;
  spec_json: string; data_provenance_json: string; svg: string;
  invalidated_at: number | null; invalidated_reason: string | null;
  created_by: string; created_at: number; ordinal?: number;
}

/** Export packages (M5, plan §8): a provenance manifest is hash-chained exactly like task events — every export is traceable to the exact section/source/visual versions it was built from. */
export interface ExportRow {
  id: string; project_id: string; task_id: string;
  format: 'markdown' | 'bibtex' | 'ris' | 'latex' | 'pdf' | 'docx' | 'provenance_manifest';
  content_sha256: string; byte_size: number; storage_path: string;
  manifest_json: string; built_at: number; ordinal?: number;
}
