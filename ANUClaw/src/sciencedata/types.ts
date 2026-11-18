/** Public scientific-data integration (research-only). Downloading a record is NOT running any model or analysis on it. */
export type ProviderId = 'alphafold' | 'rcsb' | 'ncbi_datasets' | 'geo';
export const PROVIDER_IDS: ProviderId[] = ['alphafold', 'rcsb', 'ncbi_datasets', 'geo'];

/**
 * What the content IS. Never inferred from the file name:
 *  experimental    – derived from an experiment (e.g. X-ray/NMR/EM structure)
 *  predicted       – a computational prediction or computational annotation (e.g. AlphaFold model, gene annotation)
 *  author_supplied – processed data/assertions supplied by the submitting authors (e.g. GEO series)
 *  curated_reference – a curated reference sequence (e.g. RefSeq assembly)
 *  metadata_only   – a descriptive record, no experimental/predicted content
 */
export type Classification = 'experimental' | 'predicted' | 'author_supplied' | 'curated_reference' | 'metadata_only';

export type SourceKind = 'record_metadata' | 'structure_file' | 'confidence_file' | 'sequence_file' | 'annotation_file' | 'expression_matrix' | 'archive';

export interface ProviderInfo {
  id: ProviderId; name: string; origins: string[]; accessionPattern: string; accessionExample: string;
  searchable: boolean; license: string; attribution: string; termsUrl: string; restrictions: string;
}

export interface SourceRecord {
  id: string; provider: ProviderId; accession: string; kind: SourceKind; classification: Classification; classificationNote: string;
  format: string; sourceUrl: string; finalUrl: string; sourceVersion: string; retrievedAt: number; sha256: string; bytes: number;
  license: string; attribution: string; termsUrl: string; restrictions: string; contentType: string | null; etag: string | null;
  parentSourceId: string | null; memberPath: string | null; researchOnly: true;
  /** 'provider_policy': the licence is the provider's published, provider-wide policy, NOT read from this record. Record/dataset-specific terms are not established here. */
  termsBasis: 'provider_policy'; recordSpecificTerms: string;
  /** live: fetched from the provider by this system · replay_of_live_artifact: bytes of an earlier live fetch re-ingested offline and verified against the recorded SHA-256 · synthetic_fixture: test data. */
  acquisition: 'live' | 'replay_of_live_artifact' | 'synthetic_fixture'; replayNote: string | null;
}

/** Explicit, machine-readable failure states. */
export type FetchErrorCode =
  | 'cancelled' | 'blocked_origin' | 'redirect_refused' | 'too_large' | 'rate_limited' | 'not_found' | 'unavailable' | 'timeout'
  | 'bad_content_type' | 'malformed_response' | 'budget_exhausted' | 'bad_accession' | 'unsupported_format' | 'integrity_failure' | 'access_denied';   // access_denied = the provider answered 401/403; WHY is not established (never inferred to be controlled access)

export class ScienceError extends Error {
  constructor(public readonly code: FetchErrorCode, message: string, public readonly status = 502, public readonly details?: unknown) { super(message); this.name = 'ScienceError'; }
}

export const RESEARCH_ONLY_NOTICE = 'Public reference data for research use only. It is not clinical evidence, is not part of the approved evidence corpus, and a successful download validates nothing (no prediction, docking, biomarker discovery or clinical validity is implied).';
