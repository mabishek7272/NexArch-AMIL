/** Current official /api/openapi.json contract inspected 2026-11-18. No legacy-field dependencies. */
import { createHash } from 'crypto';
import { SafeFetcher, FetchResult } from './fetcher';
import { ScienceError } from './types';
export const AF_SCHEMA = 'anuclaw-alphafold/v1' as const;
export const AF_ORIGIN = 'https://alphafold.ebi.ac.uk';
export const AF_UNIPROT =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[1-9][0-9]*)?';
export const AF_QUALIFIER = `^(?:${AF_UNIPROT}|AF-(?:${AF_UNIPROT}-F[1-9][0-9]*|[0-9]{16})(?:-model_v[1-9][0-9]*)?)$`;
export const AF_WARNINGS = [
  'Predicted model: high confidence is not experimental validation.',
  'Low-confidence regions may be flexible or disordered.',
  'Inspect PAE before interpreting relative domain orientation.',
  'Docking against a predicted structure inherits model uncertainty.',
  'Predictions do not establish binding, mechanism, efficacy or safety.',
  'Fragments are separate models; overlapping residues are never merged.',
  'Some proteins longer than 2,700 residues require user-directed bulk data access. This connector never starts FTP downloads.',
];
export type AFOperation = 'prediction' | 'complex' | 'uniprot' | 'sequence' | 'annotations';
export interface ResidueRange {
  start: number;
  end: number;
}
export interface AFWarning {
  code: string;
  message: string;
}
export interface AFFile {
  key: string;
  format: 'mmcif' | 'bcif' | 'pdb' | 'pae' | 'plddt';
  url: string;
}
export interface AFEntity {
  identifier: string | null;
  identifierType: string | null;
  description: string | null;
  type: string | null;
  chains: string[];
  stoichiometry: number | null;
}
export interface AFConfidence {
  meanPlddt: number | null;
  type: string | null;
  average: number | null;
  fractions: Record<string, number>;
  interfaceMetrics: Record<string, number>;
}
export interface AFProvenance {
  provider: string | null;
  tool: string | null;
  createdAt: string | null;
  version: number | null;
}
export interface AFModel {
  modelId: string;
  uniprotAccessions: string[];
  proteinNames: string[];
  genes: string[];
  organisms: string[];
  taxIds: number[];
  sequenceLength: number | null;
  range: ResidueRange | null;
  category: string | null;
  modelType: string | null;
  predicted: true;
  sequence: string | null;
  chain: string | null;
  entities: AFEntity[];
  assembly: string | null;
  oligomericState: string | null;
  confidence: AFConfidence;
  files: AFFile[];
  entryUrl: string;
  provenance: AFProvenance;
}
export interface AFUniProt {
  accession: string | null;
  id: string | null;
  sequenceLength: number | null;
  range: ResidueRange | null;
  checksum: string | null;
}
export interface AFAnnotation {
  type: string | null;
  description: string | null;
  residues: number[];
  regions: Array<ResidueRange & { value: string | null; unit: string | null }>;
  source: string | null;
  sourceUrl: string | null;
  evidence: string | null;
  evidenceClass: 'experimental' | 'transferred' | 'computational' | 'unknown';
}
export interface AFNormalized {
  schema: typeof AF_SCHEMA;
  operation: AFOperation;
  models: AFModel[];
  uniprot: AFUniProt | null;
  sequenceSummary: {
    length: number | null;
    checksum: string | null;
    checksumType: string | null;
  } | null;
  annotations: AFAnnotation[];
  warnings: AFWarning[];
  coverage: {
    overlaps: Array<ResidueRange & { models: string[] }>;
    missing: ResidueRange[];
    completeLengthKnown: boolean;
  };
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 20000 && v.length > 0 ? v : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => str(x) !== null);
const numbers = (v: unknown): number[] => arr(v).filter((x): x is number => num(x) !== null);
export const residueRange = (a: unknown, b: unknown): ResidueRange | null =>
  Number.isSafeInteger(a) && Number.isSafeInteger(b) && Number(a) > 0 && Number(b) >= Number(a)
    ? { start: Number(a), end: Number(b) }
    : null;
const malformed = (s: string): never => {
  throw new ScienceError('malformed_response', s, 502);
};
export function validateQualifier(raw: unknown): string {
  const q = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (q.length > 100 || !new RegExp(AF_QUALIFIER, 'i').test(q))
    throw new ScienceError(
      'bad_accession',
      'Enter a UniProt accession or supported AlphaFold model ID; URLs and paths are not accepted.',
      400,
    );
  return q.replace(/-MODEL_V/, '-model_v');
}
export function validateSequence(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 10000)
    throw new ScienceError('bad_accession', 'Sequence request exceeds 10,000 characters.', 400);
  const seq = raw.replace(/\s/g, '').toUpperCase();
  if (seq.length < 20 || seq.length > 2700 || !/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(seq))
    throw new ScienceError(
      'bad_accession',
      'Use 20–2,700 standard amino acids (ACDEFGHIKLMNPQRSTVWY), without headers, identifiers or metadata.',
      400,
    );
  return seq;
}
/** Exact host and safe advertised suffix. No user filenames, arbitrary origins or executable content. */
export function officialFile(
  url: unknown,
  format: AFFile['format'],
  origin = AF_ORIGIN,
): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const suffix = { mmcif: 'cif', bcif: 'bcif', pdb: 'pdb', pae: 'json', plddt: 'json' }[format];
    if (
      u.origin !== origin ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !new RegExp(`^/files/[A-Za-z0-9_-]+\\.${suffix}$`).test(u.pathname) ||
      url.includes('..') ||
      url.includes('%') ||
      url.includes('\\')
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
function files(e: Obj, origin: string, warnings: AFWarning[]): AFFile[] {
  const fs: AFFile[] = [];
  for (const [field, format] of [
    ['cifUrl', 'mmcif'],
    ['bcifUrl', 'bcif'],
    ['pdbUrl', 'pdb'],
    ['paeDocUrl', 'pae'],
    ['plddtDocUrl', 'plddt'],
  ] as const) {
    if (e[field] == null) continue;
    const url = officialFile(e[field], format, origin);
    if (url) fs.push({ key: format, format, url });
    else
      warnings.push({
        code: `file_url_refused_${field}`,
        message: `Provider ${field} was not an approved file URL.`,
      });
  }
  return fs;
}
function entity(raw: unknown): AFEntity {
  const e = obj(raw);
  return {
    identifier: str(e.identifier),
    identifierType: str(e.identifier_category ?? e.identifierType),
    description: str(e.description),
    type: str(e.entity_type),
    chains: strings(e.chain_ids),
    stoichiometry: num(e.stoichiometry),
  };
}
function model(raw: unknown, summary: boolean, origin: string, warnings: AFWarning[]): AFModel {
  const e = obj(raw),
    id = str(summary ? e.model_identifier : e.modelEntityId);
  if (!id || !new RegExp(AF_QUALIFIER, 'i').test(id) || !id.startsWith('AF-'))
    return malformed('AlphaFold response is missing a supported current model identifier.');
  const metrics: Record<string, number> = {},
    fractions: Record<string, number> = {};
  for (const [k, v] of Object.entries(e))
    if (/^(complexPredictionAccuracy_[A-Za-z0-9_]+|ipTM|ipSAE)$/.test(k) && num(v) !== null)
      metrics[k] = Number(v);
  for (const k of [
    'fractionPlddtVeryHigh',
    'fractionPlddtConfident',
    'fractionPlddtLow',
    'fractionPlddtVeryLow',
  ])
    if (num(e[k]) !== null) fractions[k] = Number(e[k]);
  const fs = files(e, origin, warnings);
  if (summary && str(e.model_url)) {
    const fmt = ({ MMCIF: 'mmcif', BCIF: 'bcif', PDB: 'pdb' } as const)[
      String(e.model_format) as 'MMCIF'
    ];
    const url = fmt && officialFile(e.model_url, fmt, origin);
    if (url) fs.push({ key: fmt, format: fmt, url });
    else
      warnings.push({
        code: `file_url_refused_${id}`,
        message: 'Summary file URL or format is not supported.',
      });
  }
  const sequence = str(e.sequence),
    range = residueRange(
      summary ? e.uniprot_start : e.sequenceStart,
      summary ? e.uniprot_end : e.sequenceEnd,
    ),
    type = summary ? str(e.confidence_type) : num(e.globalMetricValue) !== null ? 'pLDDT' : null,
    average = num(summary ? e.confidence_avg_local_score : e.globalMetricValue);
  return {
    modelId: id,
    uniprotAccessions: strings(e.uniprotAccession),
    proteinNames: strings(e.uniprotDescription ?? e.complexName),
    genes: strings(e.gene),
    organisms: strings(e.organismScientificName),
    taxIds: (Array.isArray(e.taxId) ? e.taxId : [e.taxId]).filter(
      (x): x is number => num(x) !== null,
    ),
    sequenceLength: sequence?.length ?? null,
    range,
    sequence,
    category: str(e.model_category),
    modelType: str(e.model_type ?? e.entityType),
    predicted: true,
    chain: str(e.chainId),
    entities: arr(e.entities ?? e.complexComposition).map(entity),
    assembly: str(e.assemblyType),
    oligomericState: str(e.oligomericState ?? e.oligomeric_state),
    confidence: {
      meanPlddt: type === 'pLDDT' ? average : null,
      type,
      average,
      fractions,
      interfaceMetrics: metrics,
    },
    files: fs,
    entryUrl: `${AF_ORIGIN}/entry/${encodeURIComponent(id)}`,
    provenance: {
      provider: str(e.providerId ?? e.provider),
      tool: str(e.toolUsed),
      createdAt: str(e.modelCreatedDate ?? e.created),
      version: num(e.latestVersion),
    },
  };
}
/** Only comparable fragments (same accession) are compared. No coordinates are merged. */
export function coverage(models: AFModel[], length: number | null): AFNormalized['coverage'] {
  const overlaps: AFNormalized['coverage']['overlaps'] = [],
    missing: ResidueRange[] = [];
  const comparable = models.filter((m) => m.uniprotAccessions.length <= 1);
  for (let i = 0; i < comparable.length; i++)
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i],
        b = comparable[j];
      if (a.uniprotAccessions.join() !== b.uniprotAccessions.join() || !a.range || !b.range)
        continue;
      const r = residueRange(
        Math.max(a.range.start, b.range.start),
        Math.min(a.range.end, b.range.end),
      );
      if (r) overlaps.push({ ...r, models: [a.modelId, b.modelId] });
    }
  let next = 1;
  for (const r of comparable
    .flatMap((m) => (m.range ? [m.range] : []))
    .sort((a, b) => a.start - b.start)) {
    if (r.start > next) missing.push({ start: next, end: r.start - 1 });
    next = Math.max(next, r.end + 1);
  }
  if (length !== null && next <= length) missing.push({ start: next, end: length });
  return { overlaps, missing, completeLengthKnown: length !== null };
}
export function normalizeAlphaFold(
  operation: AFOperation,
  raw: unknown,
  origin = AF_ORIGIN,
): AFNormalized {
  const warnings = AF_WARNINGS.map((message, i) => ({ code: `scientific_${i + 1}`, message })),
    e = obj(raw);
  const providerWarnings = Array.isArray(raw) ? raw.flatMap((r) => arr(obj(r).warnings)) : arr(e.warnings);
  providerWarnings.slice(0,20).forEach((w,i) => { if (typeof w === 'string' && w.length <= 1000) warnings.push({code:`provider_${i}`,message:w}); });
  let models: AFModel[] = [],
    uniprot: AFUniProt | null = null,
    sequenceSummary: AFNormalized['sequenceSummary'] = null;
  const annotations: AFAnnotation[] = [];
  if (operation === 'prediction' || operation === 'complex') {
    if (!Array.isArray(raw) || raw.length > 500)
      return malformed('AlphaFold returned an invalid or excessive model list.');
    models = raw.map((x) => model(x, false, origin, warnings));
  } else if (operation === 'uniprot' || operation === 'sequence') {
    if (!('structures' in e) || (e.structures !== null && !Array.isArray(e.structures)))
      return malformed('AlphaFold summary has no structures field.');
    if (arr(e.structures).length > 500) return malformed('Too many summary models.');
    models = arr(e.structures).map((x) => model(obj(x).summary, true, origin, warnings));
    if (operation === 'uniprot' && e.uniprot_entry != null) {
      const u = obj(e.uniprot_entry);
      uniprot = {
        accession: str(u.ac),
        id: str(u.id),
        sequenceLength: num(u.sequence_length),
        range: residueRange(u.segment_start, u.segment_end),
        checksum: str(u.uniprot_checksum),
      };
    }
    if (operation === 'sequence') {
      const s = obj(e.entry);
      if (!str(s.sequence) || !str(s.checksum))
        return malformed('Sequence summary entry is malformed.');
      sequenceSummary = {
        length: String(s.sequence).length,
        checksum: str(s.checksum),
        checksumType: str(s.checksum_type),
      };
    }
  } else {
    if (!Array.isArray(e.annotation))
      return malformed('AlphaFold annotations have no annotation list.');
    for (const a of e.annotation) {
      const x = obj(a),
        evidence = str(x.evidence),
        ev = evidence?.toUpperCase() ?? '';
      annotations.push({
        type: str(x.type),
        description: str(x.description),
        residues: numbers(x.residues),
        regions: arr(x.regions).flatMap((r) => {
          const z = obj(r),
            range = residueRange(z.start, z.end);
          return range ? [{ ...range, value: str(z.annotation_value), unit: str(z.unit) }] : [];
        }),
        source: str(x.source_name),
        sourceUrl: str(x.source_url)?.startsWith('https://') ? str(x.source_url) : null,
        evidence,
        evidenceClass: /TRANSFER/.test(ev)
          ? 'transferred'
          : /COMPUTATIONAL|PREDICTED/.test(ev)
            ? 'computational'
            : /^EXPERIMENTAL(?:LY SUPPORTED)?$/.test(ev)
              ? 'experimental'
              : 'unknown',
      });
    }
  }
  if (!models.length && operation !== 'annotations')
    warnings.push({
      code: 'no_models',
      message: 'The provider returned no models for this request.',
    });
  return {
    schema: AF_SCHEMA,
    operation,
    models,
    uniprot,
    sequenceSummary,
    annotations,
    warnings,
    coverage: coverage(
      operation === 'prediction' || operation === 'uniprot' ? models : [],
      uniprot?.sequenceLength ?? null,
    ),
  };
}
export interface AFLookupResult {
  normalized: AFNormalized;
  raw: FetchResult;
  cache: 'hit' | 'miss' | 'revalidated';
  retrievedAt: number;
  checkedAt: number;
  responseHash: string;
  cacheKey: string;
}
/** Bounded cache contains PUBLIC payloads only; private associations are never shared. */
export class AlphaFoldConnector {
  private readonly cache = new Map<string, AFLookupResult>();
  constructor(
    readonly fetcher: SafeFetcher,
    readonly origin = AF_ORIGIN,
    readonly ttlMs = 60000,
  ) {}
  async lookup(
    operation: AFOperation,
    input: unknown,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<AFLookupResult> {
    if (!['prediction', 'complex', 'uniprot', 'sequence', 'annotations'].includes(operation))
      throw new ScienceError('bad_accession', 'Unsupported AlphaFold operation.', 400);
    const value = operation === 'sequence' ? validateSequence(input) : validateQualifier(input),
      hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex'),
      key = `${operation}:${operation === 'sequence' ? hash(value) : value}`,
      old = this.cache.get(key);
    if (signal?.aborted) throw new ScienceError('cancelled', 'Request cancelled.', 499);
    if (!refresh && old && Date.now() - old.checkedAt < this.ttlMs) return { ...old, cache: 'hit' };
    const endpoint =
      operation === 'sequence'
        ? `/sequence/summary?type=sequence&rows=25&id=${encodeURIComponent(value)}`
        : operation === 'uniprot'
          ? `/uniprot/summary/${value}.json`
          : operation === 'annotations'
            ? `/annotations/${value}.json?type=MUTAGEN`
            : `/${operation}/${value}`;
    const headers: Record<string, string> = {};
    if (old?.raw.headers.etag) headers['If-None-Match'] = old.raw.headers.etag;
    else if (old?.raw.headers['last-modified'])
      headers['If-Modified-Since'] = old.raw.headers['last-modified'];
    const r = await this.fetcher.request(`${this.origin}/api${endpoint}`, {
      origins: [this.origin],
      maxBytes: 2e6,
      timeoutMs: 12000,
      retries: 2,
      expectTypes: /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i,
      accept: 'application/json',
      countsAsFile: false,
      signal,
      headers,
    });
    const now = Date.now();
    let result: AFLookupResult;
    if (r.status === 304 && old) result = { ...old, cache: 'revalidated', checkedAt: now };
    else {
      let raw: unknown;
      try {
        raw = JSON.parse(r.body.toString('utf8'));
      } catch {
        return malformed('AlphaFold returned invalid JSON.');
      }
      const safeRaw =
        operation === 'sequence'
          ? {
              ...r,
              finalUrl: `${this.origin}/api/sequence/summary?type=sequence&rows=25&id=sha256:${hash(value)}`,
            }
          : r;
      result = {
        normalized: normalizeAlphaFold(operation, raw, this.origin),
        raw: safeRaw,
        cache: 'miss',
        retrievedAt: now,
        checkedAt: now,
        responseHash: hash(r.body),
        cacheKey: key,
      };
    }
    this.cache.delete(key);
    this.cache.set(key, result);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}

/** Versioned confidence-file normalization, separate from model metadata and coordinates. */
export interface AFConfidenceArtifact {
  schema: typeof AF_SCHEMA;
  format: 'pae' | 'plddt';
  residueScores: Array<{ index: number; residue: number | null; plddt: number }>;
  matrix: number[][] | null;
  maxPae: number | null;
}
export function normalizeConfidenceArtifact(format: 'pae' | 'plddt', raw: unknown): AFConfidenceArtifact {
  const e = obj(Array.isArray(raw) ? raw[0] : raw);
  if (format === 'pae') {
    const matrix = e.predicted_aligned_error;
    if (!Array.isArray(matrix) || !matrix.length || matrix.length > 2700 || matrix.some((r: unknown) => !Array.isArray(r) || r.length !== matrix.length || r.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v < 0))) return malformed('Invalid PAE matrix.');
    const maximum = num(e.max_predicted_aligned_error);
    if (maximum !== null && maximum < 0) return malformed('Invalid maximum PAE.');
    return { schema: AF_SCHEMA, format, matrix, maxPae: maximum, residueScores: [] };
  }
  const scores = e.confidenceScore, residues = e.residueNumber;
  if (!Array.isArray(scores) || !scores.length || scores.length > 10000 || scores.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) return malformed('Invalid per-residue confidence.');
  if (residues !== undefined && (!Array.isArray(residues) || residues.length !== scores.length || residues.some((v: unknown) => !Number.isSafeInteger(v) || Number(v) < 1))) return malformed('Invalid confidence residue numbering.');
  return { schema: AF_SCHEMA, format, matrix: null, maxPae: null, residueScores: scores.map((plddt: number,index: number) => ({ index: index+1, residue: Array.isArray(residues) ? residues[index] : null, plddt })) };
}
